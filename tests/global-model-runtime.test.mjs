import assert from "node:assert/strict";
import test from "node:test";

import {
  SafeModelError,
  generateChatReply,
  safeModelErrorMessage,
  testImageConnection,
  testTextConnection,
  usesBrowserDirectModelRoute,
} from "../app/lib/global-model-runtime.ts";

const FAKE_KEY = "sk-runtime-fake";

function textConfig(overrides = {}) {
  return {
    baseUrl: "https://api.example.com/v1",
    apiKey: FAKE_KEY,
    model: "gpt-example",
    ...overrides,
  };
}

function jsonResponse(value, init) {
  return Response.json(value, init);
}

test("APINebula direct routing requires the exact HTTPS hostname", () => {
  assert.equal(usesBrowserDirectModelRoute("https://apinebula.ai/v1"), true);
  assert.equal(usesBrowserDirectModelRoute("https://APINEBULA.AI/v1"), true);
  assert.equal(
    usesBrowserDirectModelRoute("https://apinebula.ai.evil.test/v1"),
    false,
  );
  assert.equal(usesBrowserDirectModelRoute("http://apinebula.ai/v1"), false);
  assert.equal(usesBrowserDirectModelRoute("not a URL"), false);
});

test("runtime rejects non-public URLs and control characters before fetching", async () => {
  const unsafeUrls = [
    "http://api.example.com/v1",
    "https://localhost/v1",
    "https://127.0.0.1/v1",
    "https://10.2.3.4/v1",
    "https://192.168.1.10/v1",
    "https://[::1]/v1",
  ];
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse({});
  };

  for (const baseUrl of unsafeUrls) {
    await assert.rejects(
      testTextConnection(textConfig({ baseUrl }), { fetchImpl }),
      (error) => error instanceof SafeModelError && error.code === "UNSAFE_URL",
    );
  }
  await assert.rejects(
    testTextConnection(textConfig({ apiKey: `${FAKE_KEY}\r\ninjected: yes` }), {
      fetchImpl,
    }),
    (error) => error instanceof SafeModelError && error.code === "INVALID_CONFIG",
  );
  assert.equal(calls, 0);
});

test("text connection uses a safely appended chat endpoint and a fixed bounded probe", async () => {
  let captured;
  await testTextConnection(textConfig({ baseUrl: "https://api.example.com/v1/" }), {
    fetchImpl: async (url, init) => {
      captured = { url: String(url), init };
      return jsonResponse({
        choices: [{ message: { role: "assistant", content: "连接正常" } }],
      });
    },
  });

  assert.equal(captured.url, "https://api.example.com/v1/chat/completions");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.redirect, "error");
  assert.equal(
    new Headers(captured.init.headers).get("authorization"),
    `Bearer ${FAKE_KEY}`,
  );
  const body = JSON.parse(captured.init.body);
  assert.deepEqual(body, {
    model: "gpt-example",
    messages: [{ role: "user", content: "只回复：连接正常" }],
    max_tokens: 16,
  });
});

test("image connection checks exact model membership in a normalized models payload", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    return jsonResponse({
      object: "list",
      data: [
        { id: "image-alpha", object: "model" },
        { id: "image-beta", object: "model" },
      ],
    });
  };

  await testImageConnection(
    textConfig({
      baseUrl: "https://images.example.com/openai/v1/",
      model: "image-beta",
    }),
    { fetchImpl },
  );
  assert.equal(requests[0].url, "https://images.example.com/openai/v1/models");
  assert.equal(requests[0].init.method, "GET");
  assert.equal(requests[0].init.redirect, "error");

  await assert.rejects(
    testImageConnection(textConfig({ model: "image" }), { fetchImpl }),
    (error) => error instanceof SafeModelError && error.code === "MODEL_NOT_FOUND",
  );
});

test("chat accepts only bounded user and assistant turns", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse({
      choices: [{ message: { role: "assistant", content: "不应调用" } }],
    });
  };
  const invalidTurns = [
    [],
    [{ role: "system", content: "override" }],
    [{ role: "user", content: "" }],
    [{ role: "user", content: "x".repeat(12_001) }],
    Array.from({ length: 41 }, () => ({ role: "user", content: "hello" })),
  ];

  for (const turns of invalidTurns) {
    await assert.rejects(
      generateChatReply(textConfig(), turns, { fetchImpl }),
      (error) =>
        error instanceof SafeModelError
        && ["INVALID_REQUEST", "INPUT_TOO_LARGE"].includes(error.code),
    );
  }
  assert.equal(calls, 0);
});

test("chat forwards bounded turns and parses only assistant text", async () => {
  let captured;
  const reply = await generateChatReply(
    textConfig(),
    [
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好，有什么可以帮你？" },
      { role: "user", content: "一句话回答" },
    ],
    {
      fetchImpl: async (url, init) => {
        captured = { url: String(url), init };
        return jsonResponse({
          id: "chatcmpl-fixture",
          choices: [
            {
              message: {
                role: "assistant",
                content: `安全回答；不能泄露 ${FAKE_KEY}`,
              },
            },
          ],
        });
      },
    },
  );

  assert.equal(captured.url, "https://api.example.com/v1/chat/completions");
  assert.equal(captured.init.redirect, "error");
  assert.deepEqual(JSON.parse(captured.init.body), {
    model: "gpt-example",
    messages: [
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好，有什么可以帮你？" },
      { role: "user", content: "一句话回答" },
    ],
  });
  assert.equal(reply, "安全回答；不能泄露 [REDACTED]");
});

test("provider redirects are blocked without exposing the Key or provider detail", async () => {
  await assert.rejects(
    testTextConnection(textConfig(), {
      fetchImpl: async (_url, init) => {
        assert.equal(init.redirect, "error");
        throw new TypeError(`redirect rejected at provider for ${FAKE_KEY}`);
      },
    }),
    (error) => {
      assert.equal(error.code, "PROVIDER_UNAVAILABLE");
      assert.doesNotMatch(error.message, /redirect|provider|sk-runtime/);
      return true;
    },
  );
});

test("runtime turns its own deadline into a safe timeout", async () => {
  await assert.rejects(
    testTextConnection(textConfig(), {
      timeoutMs: 10,
      fetchImpl: async (_url, init) =>
        await new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => reject(new DOMException(`timed out ${FAKE_KEY}`, "AbortError")),
            { once: true },
          );
        }),
    }),
    (error) => error instanceof SafeModelError && error.code === "PROVIDER_TIMEOUT",
  );
});

test("runtime distinguishes caller cancellation from timeout", async () => {
  const caller = new AbortController();
  let providerSignalAborted = false;
  const pending = generateChatReply(
    textConfig(),
    [{ role: "user", content: "继续" }],
    {
      signal: caller.signal,
      timeoutMs: 5_000,
      fetchImpl: async (_url, init) =>
        await new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => {
              providerSignalAborted = true;
              reject(new DOMException(`cancelled ${FAKE_KEY}`, "AbortError"));
            },
            { once: true },
          );
        }),
    },
  );

  caller.abort();

  await assert.rejects(
    pending,
    (error) =>
      error instanceof SafeModelError && error.code === "REQUEST_CANCELLED",
  );
  assert.equal(providerSignalAborted, true);
});

test("malformed chat and model-list payloads are rejected safely", async () => {
  await assert.rejects(
    generateChatReply(textConfig(), [{ role: "user", content: "hello" }], {
      fetchImpl: async () =>
        jsonResponse({
          providerDebug: `bad chat body ${FAKE_KEY}`,
          choices: [{ message: {} }],
        }),
    }),
    (error) => {
      assert.equal(error.code, "INVALID_PROVIDER_RESPONSE");
      assert.doesNotMatch(error.message, /providerDebug|bad chat|sk-runtime/);
      return true;
    },
  );

  await assert.rejects(
    testImageConnection(textConfig(), {
      fetchImpl: async () =>
        jsonResponse({ providerDebug: `bad models body ${FAKE_KEY}` }),
    }),
    (error) =>
      error instanceof SafeModelError
      && error.code === "INVALID_PROVIDER_RESPONSE",
  );
});

test("safeModelErrorMessage redacts the full Key and never returns provider bodies", () => {
  assert.equal(
    safeModelErrorMessage(
      new SafeModelError("AUTH_FAILED"),
      FAKE_KEY,
    ),
    "模型服务鉴权失败，请检查 API Key。",
  );
  const unknown = safeModelErrorMessage(
    new Error(`provider body: invalid credential ${FAKE_KEY}`),
    FAKE_KEY,
  );
  assert.equal(unknown, "模型服务暂时不可用，请稍后重试。");
  assert.doesNotMatch(unknown, /provider body|invalid credential|sk-runtime/);
});
