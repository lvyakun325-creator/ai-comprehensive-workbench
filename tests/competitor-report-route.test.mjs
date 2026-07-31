import assert from "node:assert/strict";
import test from "node:test";

import {
  createCompetitorReportRoute,
  POST,
} from "../app/api/agents/competitor-insight/route.ts";

const FAKE_KEY = "sk-competitor-route-fake";

function payload(overrides = {}) {
  return {
    config: {
      baseUrl: "https://api.openai.com/v1",
      apiKey: FAKE_KEY,
      model: "gpt-example",
    },
    batchId: "strategy",
    input: {
      evidence: [{ evidenceId: "DY-E0001", title: "示例作品" }],
    },
    ...overrides,
  };
}

function request(body = payload(), signal) {
  return new Request(
    "https://workbench.example/api/agents/competitor-insight",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    },
  );
}

function validBatch() {
  return {
    batchId: "strategy",
    claims: [],
    topicDirections: [],
    filmingTemplates: [],
    conversionItems: [],
    executionDays: [],
  };
}

function upstream(content = JSON.stringify(validBatch()), init) {
  return Response.json({
    choices: [{ message: { role: "assistant", content } }],
  }, init);
}

test("route accepts only POST", async () => {
  const handler = createCompetitorReportRoute();
  const response = await handler(
    new Request(
      "https://workbench.example/api/agents/competitor-insight",
      { method: "GET" },
    ),
  );

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    ok: false,
    error: {
      code: "METHOD_NOT_ALLOWED",
      message: "仅支持 POST 请求。",
    },
  });
});

test("route success is minimal no-store JSON and forces the server-only endpoint boundary", async () => {
  let captured;
  const handler = createCompetitorReportRoute({
    egressMode: "browser-direct",
    fetchImpl: async (url, init) => {
      captured = { url: String(url), init };
      return upstream();
    },
  });
  const response = await handler(request());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(await response.json(), { ok: true, batch: validBatch() });
  assert.equal(captured.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(captured.init.redirect, "error");
});

test("route rejects oversized declared and chunked requests before provider access", async () => {
  let calls = 0;
  const handler = createCompetitorReportRoute({
    fetchImpl: async () => {
      calls += 1;
      return upstream();
    },
  });
  const declared = new Request(
    "https://workbench.example/api/agents/competitor-insight",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(128 * 1024 + 1),
      },
      body: "{}",
    },
  );
  const declaredResponse = await handler(declared);
  assert.equal(declaredResponse.status, 413);

  let canceled = false;
  let sent = 0;
  const chunked = new Request(
    "https://workbench.example/api/agents/competitor-insight",
    {
      method: "POST",
      body: new ReadableStream({
        pull(controller) {
          if (sent < 3) {
            controller.enqueue(new Uint8Array(64 * 1024).fill(120));
            sent += 1;
          } else {
            controller.close();
          }
        },
        cancel() {
          canceled = true;
        },
      }),
      duplex: "half",
    },
  );
  const chunkedResponse = await handler(chunked);

  assert.equal(chunkedResponse.status, 413);
  assert.equal(canceled, true);
  assert.equal(calls, 0);
  assert.match(
    JSON.stringify(await chunkedResponse.json()),
    /REQUEST_TOO_LARGE/,
  );
});

test("route blocks unsafe endpoints and never reflects credentials, endpoint or evidence", async () => {
  let calls = 0;
  const handler = createCompetitorReportRoute({
    fetchImpl: async () => {
      calls += 1;
      return upstream();
    },
  });
  const unsafeEndpoints = [
    "http://api.openai.com/v1",
    "https://user:pass@api.openai.com/v1",
    "https://api.openai.com:8443/v1",
    "https://api.openai.com.evil.test/v1",
    "https://127.0.0.1/v1",
    "https://10.0.0.5/v1",
    "https://custom.example/v1",
    "https://apinebula.ai/v1",
  ];

  for (const baseUrl of unsafeEndpoints) {
    const body = payload({
      config: { ...payload().config, baseUrl },
      input: {
        evidence: [
          {
            evidenceId: "DY-E0001",
            title: "highly-sensitive-evidence",
          },
        ],
      },
    });
    const response = await handler(request(body));
    const responseText = await response.text();
    assert.equal(response.status, 400, baseUrl);
    assert.match(responseText, /UNSAFE_URL/);
    assert.doesNotMatch(
      responseText,
      /sk-competitor|api\.openai|custom\.example|apinebula|sensitive-evidence/i,
    );
  }
  assert.equal(calls, 0);
});

test("route maps 401, 429, timeout and malformed responses to stable safe codes", async () => {
  const fixtures = [
    {
      expectedStatus: 401,
      expectedCode: "AUTH_FAILED",
      fetchImpl: async () =>
        new Response(`upstream auth ${FAKE_KEY}`, { status: 401 }),
    },
    {
      expectedStatus: 429,
      expectedCode: "RATE_LIMITED",
      fetchImpl: async () => new Response("provider throttle", { status: 429 }),
    },
    {
      expectedStatus: 502,
      expectedCode: "INVALID_PROVIDER_RESPONSE",
      fetchImpl: async () =>
        new Response(`{"provider":"${FAKE_KEY}"`, {
          headers: { "content-type": "application/json" },
        }),
    },
    {
      expectedStatus: 502,
      expectedCode: "INVALID_MODEL_OUTPUT",
      fetchImpl: async () => upstream("provider prose before json"),
    },
  ];

  for (const fixture of fixtures) {
    const handler = createCompetitorReportRoute({
      fetchImpl: fixture.fetchImpl,
    });
    const response = await handler(request());
    const text = await response.text();
    assert.equal(response.status, fixture.expectedStatus);
    assert.match(text, new RegExp(fixture.expectedCode));
    assert.doesNotMatch(
      text,
      /sk-competitor|upstream auth|provider throttle|provider prose|api\.openai/i,
    );
  }

  const timeoutHandler = createCompetitorReportRoute({
    timeoutMs: 5,
    fetchImpl: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("timeout detail", "AbortError")),
          { once: true },
        );
      }),
  });
  const timeoutResponse = await timeoutHandler(request());
  assert.equal(timeoutResponse.status, 504);
  assert.match(await timeoutResponse.text(), /PROVIDER_TIMEOUT/);
});

test("route cancels oversized upstream responses and returns a safe error", async () => {
  let canceled = false;
  let chunksSent = 0;
  const handler = createCompetitorReportRoute({
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            if (chunksSent < 3) {
              controller.enqueue(new Uint8Array(70 * 1024).fill(120));
              chunksSent += 1;
            } else {
              controller.close();
            }
          },
          cancel() {
            canceled = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  });

  const response = await handler(request());
  assert.equal(response.status, 502);
  assert.match(await response.text(), /PROVIDER_RESPONSE_TOO_LARGE/);
  assert.equal(canceled, true);
});

test("caller cancellation aborts provider work and is distinct from timeout", async () => {
  const caller = new AbortController();
  let providerSignal;
  let started;
  const providerStarted = new Promise((resolve) => {
    started = resolve;
  });
  const handler = createCompetitorReportRoute({
    timeoutMs: 1_000,
    fetchImpl: async (_url, init) =>
      new Promise((_resolve, reject) => {
        providerSignal = init.signal;
        started();
        init.signal.addEventListener(
          "abort",
          () =>
            reject(
              new DOMException(
                `provider cancel ${FAKE_KEY} sensitive evidence`,
                "AbortError",
              ),
            ),
          { once: true },
        );
      }),
  });

  const responsePromise = handler(request(payload(), caller.signal));
  await providerStarted;
  caller.abort();
  const response = await responsePromise;
  const text = await response.text();

  assert.equal(providerSignal.aborted, true);
  assert.equal(response.status, 499);
  assert.match(text, /REQUEST_CANCELLED/);
  assert.doesNotMatch(text, /sk-competitor|provider cancel|sensitive evidence/);
});

test("malformed request JSON never reflects the request body", async () => {
  const response = await POST(
    new Request(
      "https://workbench.example/api/agents/competitor-insight",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `{"config":{"apiKey":"${FAKE_KEY}"`,
      },
    ),
  );
  const text = await response.text();

  assert.equal(response.status, 400);
  assert.match(text, /INVALID_JSON/);
  assert.doesNotMatch(text, /sk-competitor/);
});
