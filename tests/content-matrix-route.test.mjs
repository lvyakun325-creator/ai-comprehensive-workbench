import assert from "node:assert/strict";
import test from "node:test";

import {
  createContentMatrixRoute,
  POST,
} from "../app/api/agents/content-matrix/route.ts";

const FAKE_KEY = "sk-fake";

function request(body, signal) {
  return new Request("https://workbench.example/api/agents/content-matrix", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

function testPayload(overrides = {}) {
  return {
    action: "test",
    protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKey: FAKE_KEY,
    model: "gpt-example",
    ...overrides,
  };
}

test("POST rejects invalid actions with a no-store JSON response", async () => {
  const response = await POST(request(testPayload({ action: "delete" })));

  assert.equal(response.status, 400);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: {
      code: "INVALID_ACTION",
      message: "请求操作无效。",
    },
  });
});

test("route connection success returns only necessary connection information", async () => {
  const handler = createContentMatrixRoute({
    fetchImpl: async () =>
      Response.json({
        object: "list",
        data: [{ id: "gpt-example", object: "model", created: 1, owned_by: "test" }],
      }),
  });

  const response = await handler(request(testPayload()));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    ok: true,
    action: "test",
    connected: true,
    modelAvailable: true,
  });
});

test("route rejects APINebula because browser-direct providers cannot use server egress", async () => {
  let calls = 0;
  const handler = createContentMatrixRoute({
    fetchImpl: async () => {
      calls += 1;
      return Response.json({
        data: [{ id: "gpt-5.5" }],
      });
    },
  });

  const response = await handler(
    request(
      testPayload({
        baseUrl: "https://apinebula.ai/v1",
        model: "gpt-5.5",
      }),
    ),
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(body, {
    ok: false,
    error: {
      code: "UNSAFE_URL",
      message: "接口地址必须是安全的 HTTPS 公网地址。",
    },
  });
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(body).includes(FAKE_KEY), false);
});

test("route hard-codes server-proxy after injected and request-supplied egress choices", async () => {
  const requestedUrls = [];
  const handler = createContentMatrixRoute({
    egressMode: "browser-direct",
    fetchImpl: async (url) => {
      requestedUrls.push(String(url));
      return Response.json({ data: [{ id: "gpt-example" }] });
    },
  });

  const officialResponse = await handler(
    request(testPayload({ egressMode: "browser-direct" })),
  );
  assert.equal(officialResponse.status, 200);
  assert.deepEqual(requestedUrls, ["https://api.openai.com/v1/models"]);

  const customResponse = await handler(
    request(
      testPayload({
        baseUrl: "https://models.partner-example.com/v1",
        egressMode: "browser-direct",
      }),
    ),
  );
  const customBody = JSON.stringify(await customResponse.json());
  assert.equal(customResponse.status, 400);
  assert.match(customBody, /UNSAFE_URL/);
  assert.doesNotMatch(customBody, /partner-example|sk-fake/);
  assert.equal(requestedUrls.length, 1);
});

test("route passes caller cancellation to the provider and returns no Key or provider body", async () => {
  const caller = new AbortController();
  let providerSignal;
  let notifyProviderStarted;
  const providerStarted = new Promise((resolve) => {
    notifyProviderStarted = resolve;
  });
  const handler = createContentMatrixRoute({
    timeoutMs: 1_000,
    fetchImpl: async (_url, init) =>
      new Promise((_resolve, reject) => {
        providerSignal = init.signal;
        notifyProviderStarted();
        init.signal.addEventListener("abort", () => {
          reject(
            new DOMException(
              `provider canceled with ${FAKE_KEY} and internal body`,
              "AbortError",
            ),
          );
        }, { once: true });
      }),
  });

  const responsePromise = handler(
    request(testPayload(), caller.signal),
  );
  await providerStarted;
  caller.abort();
  const response = await responsePromise;
  const body = JSON.stringify(await response.json());

  assert.equal(providerSignal.aborted, true);
  assert.equal(response.status, 499);
  assert.match(body, /REQUEST_CANCELLED/);
  assert.doesNotMatch(body, /sk-fake|provider canceled|internal body|api\.openai/);
});

test("route safely blocks redirects for all provider authentication protocols", async () => {
  const cases = [
    testPayload(),
    testPayload({
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-example",
    }),
    testPayload({
      protocol: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-example",
    }),
  ];

  for (const payload of cases) {
    const handler = createContentMatrixRoute({
      fetchImpl: async (_url, init) => {
        if (init.redirect !== "error") {
          if (payload.protocol === "gemini") {
            return Response.json({
              models: [
                {
                  name: "models/gemini-example",
                  version: "001",
                  displayName: "Gemini Example",
                  description: "Fixture",
                  inputTokenLimit: 1,
                  outputTokenLimit: 1,
                  supportedGenerationMethods: ["generateContent"],
                },
              ],
            });
          }
          return Response.json({
            data: [
              payload.protocol === "anthropic"
                ? {
                    type: "model",
                    id: "claude-example",
                    display_name: "Claude Example",
                    created_at: "2026-01-01T00:00:00Z",
                  }
                : {
                    id: "gpt-example",
                    object: "model",
                    created: 1,
                    owned_by: "test",
                  },
            ],
          });
        }
        throw new TypeError(`redirected credential ${FAKE_KEY}`);
      },
    });

    const response = await handler(request(payload));
    const body = JSON.stringify(await response.json());

    assert.equal(response.status, 502);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(body, /PROVIDER_UNAVAILABLE/);
    assert.doesNotMatch(body, /redirected credential|sk-fake|api\.anthropic/);
  }
});

test("route stage success returns only stage Markdown", async () => {
  const handler = createContentMatrixRoute({
    fetchImpl: async () =>
      Response.json({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "## 战略\n内容" },
            finish_reason: "stop",
          },
        ],
      }),
  });

  const response = await handler(
    request(
      testPayload({
        action: "run",
        stage: 2,
        diagnostic: "诊断资料",
        history: [],
        feedback: "",
      }),
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    ok: true,
    action: "run",
    stage: 2,
    markdown: "## 战略\n内容",
  });
});

test("route rejects an oversized body before calling the provider", async () => {
  let calls = 0;
  const handler = createContentMatrixRoute({
    fetchImpl: async () => {
      calls += 1;
      return Response.json({ data: [] });
    },
  });
  const oversized = request(
    testPayload({ padding: "x".repeat(128 * 1024) }),
  );

  const response = await handler(oversized);

  assert.equal(response.status, 413);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(calls, 0);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: {
      code: "REQUEST_TOO_LARGE",
      message: "请求内容过大，请精简后重试。",
    },
  });
});

test("route incrementally cancels an oversized chunked body without Content-Length", async () => {
  let calls = 0;
  let canceled = false;
  let chunksSent = 0;
  const handler = createContentMatrixRoute({
    fetchImpl: async () => {
      calls += 1;
      return Response.json({ data: [] });
    },
  });
  const body = new ReadableStream({
    pull(controller) {
      if (chunksSent < 3) {
        controller.enqueue(new Uint8Array(64 * 1024).fill(120));
        chunksSent += 1;
      } else {
        controller.close();
      }
    },
    cancel() {
      canceled = true;
    },
  });
  const chunkedRequest = new Request(
    "https://workbench.example/api/agents/content-matrix",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    },
  );
  assert.equal(chunkedRequest.headers.get("content-length"), null);

  const response = await handler(chunkedRequest);

  assert.equal(response.status, 413);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(canceled, true);
  assert.equal(calls, 0);
});

test("route returns a no-store safe error when the previous stage is not explicitly confirmed", async () => {
  let calls = 0;
  const handler = createContentMatrixRoute({
    fetchImpl: async () => {
      calls += 1;
      return Response.json({
        choices: [{ message: { role: "assistant", content: "不应调用" } }],
      });
    },
  });

  const response = await handler(
    request(
      testPayload({
        action: "run",
        stage: 3,
        diagnostic: "诊断",
        history: [{ stage: 2, markdown: "战略" }],
        feedback: "继续",
      }),
    ),
  );
  const body = JSON.stringify(await response.json());

  assert.equal(response.status, 409);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(body, /STAGE_CONFIRMATION_REQUIRED/);
  assert.doesNotMatch(body, /sk-fake|战略|api\.example/);
  assert.equal(calls, 0);
});

test("route rejects invalid stage 5 output without exposing Key or enabling a final result", async () => {
  const handler = createContentMatrixRoute({
    fetchImpl: async () =>
      Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: `# 最终矩阵方案
结论：推荐阵型为章鱼型。
## 战略判断
先做搜索。
## 账号配置
配置品牌号和 KOS。
## 执行 SOP
供应商错误回显 ${FAKE_KEY}。`,
            },
          },
        ],
      }),
  });

  const response = await handler(
    request(
      testPayload({
        action: "run",
        stage: 5,
        diagnostic: "诊断",
        history: [
          { stage: 2, markdown: "战略" },
          { stage: 3, markdown: "战术" },
          { stage: 4, markdown: "执行" },
        ],
        feedback: "确认",
        confirmed: true,
        confirmedStage: 4,
      }),
    ),
  );
  const body = JSON.stringify(await response.json());

  assert.equal(response.status, 502);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(body, /INVALID_STAGE_OUTPUT/);
  assert.doesNotMatch(body, /sk-fake|检查点|下一步|章鱼型/);
  assert.doesNotMatch(body, /markdown/);
});

test("route never includes the API Key or provider response body in an error", async () => {
  const handler = createContentMatrixRoute({
    fetchImpl: async () =>
      new Response(`upstream diagnostic ${FAKE_KEY}`, { status: 401 }),
  });

  const response = await handler(request(testPayload()));
  const body = JSON.stringify(await response.json());

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(body, /sk-fake|upstream diagnostic|api\.example/);
  assert.match(body, /AUTH_FAILED/);
});

test("route maps malformed JSON without reflecting request text", async () => {
  const malformed = new Request(
    "https://workbench.example/api/agents/content-matrix",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"apiKey":"${FAKE_KEY}"`,
    },
  );

  const response = await POST(malformed);
  const body = JSON.stringify(await response.json());

  assert.equal(response.status, 400);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(body, /sk-fake/);
  assert.match(body, /INVALID_JSON/);
});
