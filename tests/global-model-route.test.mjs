import assert from "node:assert/strict";
import test from "node:test";

import {
  createTestTextRoute,
  POST as textPOST,
} from "../app/api/models/test-text/route.ts";
import {
  createTestImageRoute,
  POST as imagePOST,
} from "../app/api/models/test-image/route.ts";
import {
  createChatRoute,
  POST as chatPOST,
} from "../app/api/models/chat/route.ts";

const FAKE_KEY = "sk-route-fake";

function config(overrides = {}) {
  return {
    baseUrl: "https://api.openai.com/v1",
    apiKey: FAKE_KEY,
    model: "gpt-example",
    ...overrides,
  };
}

function request(path, body, init = {}) {
  return new Request(`https://workbench.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...init.headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: init.signal,
  });
}

function assertSafeJsonResponse(response) {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
}

function streamedJsonResponse(value, chunkSize = 128 * 1024) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let offset = 0;
  let canceled = false;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(offset + chunkSize, bytes.byteLength);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
      cancel() {
        canceled = true;
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
  return { response, wasCanceled: () => canceled };
}

test("all three routes forward Bearer credentials with redirects blocked and return minimal no-store success", async () => {
  const captured = [];
  const fetchImpl = async (url, init) => {
    captured.push({ url: String(url), init });
    if (String(url).endsWith("/models")) {
      return Response.json({
        object: "list",
        data: [{ id: "gpt-example", object: "model" }],
      });
    }
    return Response.json({
      choices: [{ message: { role: "assistant", content: "真实回复" } }],
    });
  };
  const cases = [
    [
      createTestTextRoute({ fetchImpl }),
      request("/api/models/test-text", { config: config() }),
      { ok: true },
    ],
    [
      createTestImageRoute({ fetchImpl }),
      request("/api/models/test-image", { config: config() }),
      { ok: true },
    ],
    [
      createChatRoute({ fetchImpl }),
      request("/api/models/chat", {
        config: config(),
        turns: [{ role: "user", content: "你好" }],
      }),
      { ok: true, reply: "真实回复" },
    ],
  ];

  for (const [handler, input, expected] of cases) {
    const response = await handler(input);
    assert.equal(response.status, 200);
    assertSafeJsonResponse(response);
    assert.deepEqual(await response.json(), expected);
  }

  assert.equal(captured.length, 3);
  for (const entry of captured) {
    assert.equal(entry.init.redirect, "error");
    assert.equal(
      new Headers(entry.init.headers).get("authorization"),
      `Bearer ${FAKE_KEY}`,
    );
  }
});

test("default POST exports reject unsafe URLs before contacting a provider", async () => {
  const cases = [
    [
      textPOST,
      request("/api/models/test-text", {
        config: config({ baseUrl: "http://api.openai.com/v1" }),
      }),
    ],
    [
      imagePOST,
      request("/api/models/test-image", {
        config: config({ baseUrl: "https://127.0.0.1/v1" }),
      }),
    ],
    [
      chatPOST,
      request("/api/models/chat", {
        config: config({ baseUrl: "https://localhost/v1" }),
        turns: [{ role: "user", content: "hello" }],
      }),
    ],
  ];

  for (const [handler, input] of cases) {
    const response = await handler(input);
    assert.equal(response.status, 400);
    assertSafeJsonResponse(response);
    assert.deepEqual(await response.json(), {
      ok: false,
      code: "UNSAFE_URL",
      message: "接口地址必须是安全的 HTTPS 公网地址。",
    });
  }
});

test("all API routes force server-proxy mode and cannot be switched to APINebula direct", async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (String(url).endsWith("/models")) {
      return Response.json({
        object: "list",
        data: [{ id: "gpt-example", object: "model" }],
      });
    }
    return Response.json({
      choices: [{ message: { role: "assistant", content: "不应调用" } }],
    });
  };
  const apinebulaConfig = config({
    baseUrl: "https://apinebula.ai/v1",
  });
  const cases = [
    [
      createTestTextRoute({ fetchImpl, egressMode: "browser-direct" }),
      request("/api/models/test-text", {
        config: apinebulaConfig,
        egressMode: "browser-direct",
      }),
    ],
    [
      createTestImageRoute({ fetchImpl, egressMode: "browser-direct" }),
      request("/api/models/test-image", {
        config: apinebulaConfig,
        egressMode: "browser-direct",
      }),
    ],
    [
      createChatRoute({ fetchImpl, egressMode: "browser-direct" }),
      request("/api/models/chat", {
        config: apinebulaConfig,
        turns: [{ role: "user", content: "hello" }],
        egressMode: "browser-direct",
      }),
    ],
  ];

  for (const [handler, input] of cases) {
    const response = await handler(input);
    assert.equal(response.status, 400);
    assertSafeJsonResponse(response);
    assert.deepEqual(await response.json(), {
      ok: false,
      code: "UNSAFE_URL",
      message: "接口地址必须是安全的 HTTPS 公网地址。",
    });
  }
  assert.equal(calls, 0);
});

test("routes reject malformed JSON and oversized bodies without calling the provider", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return Response.json({});
  };
  const malformed = await createTestTextRoute({ fetchImpl })(
    request("/api/models/test-text", '{"config":'),
  );
  assert.equal(malformed.status, 400);
  assertSafeJsonResponse(malformed);
  assert.deepEqual(await malformed.json(), {
    ok: false,
    code: "INVALID_REQUEST",
    message: "请求参数无效。",
  });

  const oversized = await createChatRoute({ fetchImpl })(
    request("/api/models/chat", {
      config: config(),
      turns: [{ role: "user", content: "x".repeat(70 * 1024) }],
    }),
  );
  assert.equal(oversized.status, 413);
  assertSafeJsonResponse(oversized);
  assert.deepEqual(await oversized.json(), {
    ok: false,
    code: "REQUEST_TOO_LARGE",
    message: "请求内容过大，请精简后重试。",
  });
  assert.equal(calls, 0);
});

test("route timeout is safe and no-store", async () => {
  const handler = createTestTextRoute({
    timeoutMs: 10,
    fetchImpl: async (_url, init) =>
      await new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () =>
            reject(
              new DOMException(`provider timed out ${FAKE_KEY}`, "AbortError"),
            ),
          { once: true },
        );
      }),
  });

  const response = await handler(
    request("/api/models/test-text", { config: config() }),
  );
  assert.equal(response.status, 504);
  assertSafeJsonResponse(response);
  assert.deepEqual(await response.json(), {
    ok: false,
    code: "PROVIDER_TIMEOUT",
    message: "模型服务响应超时，请稍后重试。",
  });
});

test("route propagates caller cancellation to the provider request", async () => {
  const caller = new AbortController();
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  let providerAborted = false;
  const handler = createChatRoute({
    timeoutMs: 5_000,
    fetchImpl: async (_url, init) =>
      await new Promise((_resolve, reject) => {
        markStarted();
        init.signal.addEventListener(
          "abort",
          () => {
            providerAborted = true;
            reject(new DOMException(`caller cancelled ${FAKE_KEY}`, "AbortError"));
          },
          { once: true },
        );
      }),
  });

  const pending = handler(
    request(
      "/api/models/chat",
      {
        config: config(),
        turns: [{ role: "user", content: "hello" }],
      },
      { signal: caller.signal },
    ),
  );
  await started;
  caller.abort();
  const response = await pending;

  assert.equal(response.status, 499);
  assertSafeJsonResponse(response);
  assert.deepEqual(await response.json(), {
    ok: false,
    code: "REQUEST_CANCELLED",
    message: "本次请求已取消。",
  });
  assert.equal(providerAborted, true);
});

test("image route reports a missing exact model without returning the model list", async () => {
  const handler = createTestImageRoute({
    fetchImpl: async () =>
      Response.json({
        object: "list",
        data: [
          { id: "image-alpha", object: "model" },
          { id: `provider-${FAKE_KEY}`, object: "model" },
        ],
      }),
  });
  const response = await handler(
    request("/api/models/test-image", {
      config: config({ model: "image" }),
    }),
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assertSafeJsonResponse(response);
  assert.deepEqual(body, {
    ok: false,
    code: "MODEL_NOT_FOUND",
    message: "模型列表中未找到指定模型。",
  });
  assert.doesNotMatch(JSON.stringify(body), /image-alpha|provider-|sk-route/);
});

test("route cancels an oversized provider response and returns only a safe error", async () => {
  const upstream = streamedJsonResponse({
    choices: [
      {
        message: {
          role: "assistant",
          content: `raw provider reply ${FAKE_KEY} ${"x".repeat(600 * 1024)}`,
        },
      },
    ],
  });
  const handler = createChatRoute({
    fetchImpl: async () => upstream.response,
  });
  const response = await handler(
    request("/api/models/chat", {
      config: config(),
      turns: [{ role: "user", content: "hello" }],
    }),
  );
  const body = await response.json();

  assert.equal(response.status, 502);
  assertSafeJsonResponse(response);
  assert.deepEqual(body, {
    ok: false,
    code: "PROVIDER_RESPONSE_TOO_LARGE",
    message: "模型服务返回内容过大，请缩小请求后重试。",
  });
  assert.equal(upstream.wasCanceled(), true);
  assert.doesNotMatch(
    JSON.stringify(body),
    /raw provider reply|sk-route|api\.openai/,
  );
});

test("no error response exposes a Key, provider body, endpoint, or test reply", async () => {
  const cases = [
    [
      createTestTextRoute({
        fetchImpl: async () => {
          throw new Error(`provider transport ${FAKE_KEY}`);
        },
      }),
      request("/api/models/test-text", { config: config() }),
    ],
    [
      createTestImageRoute({
        fetchImpl: async () =>
          new Response(`unauthorized detail ${FAKE_KEY}`, { status: 401 }),
      }),
      request("/api/models/test-image", { config: config() }),
    ],
    [
      createChatRoute({
        fetchImpl: async () =>
          Response.json({
            providerBody: `debug ${FAKE_KEY}`,
            choices: [{ message: {} }],
          }),
      }),
      request("/api/models/chat", {
        config: config(),
        turns: [{ role: "user", content: "hello" }],
      }),
    ],
  ];

  for (const [handler, input] of cases) {
    const response = await handler(input);
    const serialized = JSON.stringify(await response.json());
    assertSafeJsonResponse(response);
    assert.doesNotMatch(
      serialized,
      /sk-route|provider transport|unauthorized detail|providerBody|api\.openai/,
    );
    assert.doesNotMatch(serialized, /reply/);
  }
});
