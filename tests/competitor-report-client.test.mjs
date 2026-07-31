import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  analyzeReportPath,
  CompetitorReportClientError,
} from "../app/lib/competitor-report-client.ts";

const originalFetch = globalThis.fetch;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function analyze(signal = new AbortController().signal) {
  return analyzeReportPath("/controlled/douyin/account.xlsx", signal);
}

function assertClientCode(code) {
  return (error) =>
    error instanceof CompetitorReportClientError && error.code === code;
}

test("declared responses above 2 MB are canceled and rejected", async () => {
  let canceled = false;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        cancel() {
          canceled = true;
        },
      }),
      { headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } },
    );

  await assert.rejects(analyze(), assertClientCode("BRIDGE_RESPONSE_TOO_LARGE"));
  assert.equal(canceled, true);
});

test("streamed responses above 2 MB are canceled and reject with a stable code", async () => {
  let canceled = false;
  let emitted = 0;
  globalThis.fetch = async () =>
    new Response(new ReadableStream({
      pull(controller) {
        emitted += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        canceled = true;
      },
    }));

  await assert.rejects(analyze(), assertClientCode("BRIDGE_RESPONSE_TOO_LARGE"));
  assert.equal(canceled, true);
  assert.ok(emitted >= 3);
});

test("reader cancel rejection never replaces the stable size error", async () => {
  let canceled = false;
  globalThis.fetch = async () =>
    new Response(new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES + 1));
      },
      cancel() {
        canceled = true;
        throw new Error("sensitive cleanup failure");
      },
    }));

  await assert.rejects(analyze(), assertClientCode("BRIDGE_RESPONSE_TOO_LARGE"));
  assert.equal(canceled, true);
});

test("abort during a stalled response read cancels the reader and settles", async () => {
  const controller = new AbortController();
  let readStarted;
  const started = new Promise((resolve) => {
    readStarted = resolve;
  });
  let canceled = false;
  globalThis.fetch = async () =>
    new Response(new ReadableStream({
      pull() {
        readStarted();
        return new Promise(() => {});
      },
      cancel() {
        canceled = true;
      },
    }));

  const request = analyze(controller.signal);
  await started;
  controller.abort();
  const settled = await Promise.race([
    request.then(
      () => ({ status: "fulfilled" }),
      (error) => ({ status: "rejected", error }),
    ),
    new Promise((resolve) =>
      setTimeout(() => resolve({ status: "still-pending" }), 100),
    ),
  ]);

  assert.notEqual(settled.status, "still-pending");
  assert.equal(settled.status, "rejected");
  assert.equal(settled.error?.name, "AbortError");
  assert.equal(canceled, true);
});

test("malformed and extra-field bridge responses fail closed", async () => {
  const responses = [
    new Response('{"ok":true', {
      headers: { "content-type": "application/json" },
    }),
    Response.json({
      ok: true,
      stage: "evidence_ready",
      evidenceId: "0123456789abcdef",
      account: {},
      completeness: {},
      batchInputs: {
        strategy: { evidence: [{ evidenceId: "DY-E0001" }] },
        performance: { evidence: [{ evidenceId: "DY-E0001" }] },
        execution: { evidence: [{ evidenceId: "DY-E0001" }] },
      },
      extra: "must fail",
    }),
    Response.json({ ok: false, error: "UNKNOWN", message: "secret provider body" }, {
      status: 502,
    }),
  ];

  for (const response of responses) {
    globalThis.fetch = async () => response;
    await assert.rejects(
      analyze(),
      (error) =>
        error instanceof CompetitorReportClientError
        && !error.message.includes("secret provider body"),
    );
  }
});
