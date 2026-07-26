import assert from "node:assert/strict";
import test from "node:test";

import {
  createContentMatrixRoute,
  POST,
} from "../app/api/agents/content-matrix/route.ts";

const FAKE_KEY = "sk-fake";

function request(body) {
  return new Request("https://workbench.example/api/agents/content-matrix", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function testPayload(overrides = {}) {
  return {
    action: "test",
    protocol: "openai-compatible",
    baseUrl: "https://api.example.com/v1",
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
