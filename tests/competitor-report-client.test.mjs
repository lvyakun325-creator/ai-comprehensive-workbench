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

function evidenceReadyFixture() {
  const evidence = [{
    evidenceId: "DY-E0001",
    title: "第一条作品",
    likes: 20,
    comments: 2,
    collects: 3,
    shares: 1,
    totalInteractions: 26,
    publishedAt: "2026-07-01T10:00:00",
  }];
  const ranking = { status: "available", evidenceIds: ["DY-E0001"] };
  return {
    ok: true,
    stage: "evidence_ready",
    evidenceId: "0123456789abcdef",
    account: { nickname: "测试账号" },
    completeness: { missingFields: [], warnings: [] },
    batchInputs: {
      strategy: {
        availability: { comments: true, collects: true, shares: true },
        rankings: { overall: ranking, startup: ranking },
        evidence,
      },
      performance: {
        availability: { comments: true, collects: true, shares: true },
        metrics: {
          workCount: 1,
          averageLikes: 20,
          averageComments: 2,
          averageCollects: 3,
          averageShares: 1,
          averageInteractions: 26,
          maxInteractions: 26,
          aboveAverageInteractionCount: 0,
          top10InteractionShare: 1,
          maxToAverageMultiple: 1,
        },
        rankings: {
          overall: ranking,
          startup: ranking,
          collect: ranking,
          share: ranking,
          comment: ranking,
        },
        evidence,
      },
      execution: {
        availability: { comments: true, collects: true, shares: true },
        rankings: {
          overall: ranking,
          collect: ranking,
          share: ranking,
          comment: ranking,
        },
        evidence,
      },
    },
  };
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

test("malformed and unknown-error bridge responses fail closed", async () => {
  const responses = [
    new Response('{"ok":true', {
      headers: { "content-type": "application/json" },
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

test("a top-level extra field alone makes an otherwise valid response fail closed", async () => {
  globalThis.fetch = async () => Response.json(evidenceReadyFixture());
  await analyze();

  globalThis.fetch = async () => Response.json({
    ...evidenceReadyFixture(),
    extra: "must fail",
  });
  await assert.rejects(analyze(), assertClientCode("INVALID_BRIDGE_RESPONSE"));
});

test("ranking evidence IDs must belong to evidence from the same batch", async () => {
  const fixture = structuredClone(evidenceReadyFixture());
  fixture.batchInputs.strategy.rankings.overall.evidenceIds = ["DY-E9999"];
  globalThis.fetch = async () => Response.json(fixture);

  await assert.rejects(analyze(), assertClientCode("INVALID_BRIDGE_RESPONSE"));
});

test("every batch requires a nonempty available overall ranking", async () => {
  const fixture = structuredClone(evidenceReadyFixture());
  fixture.batchInputs.performance.rankings.overall.evidenceIds = [];
  globalThis.fetch = async () => Response.json(fixture);

  await assert.rejects(analyze(), assertClientCode("INVALID_BRIDGE_RESPONSE"));
});

test("ranking availability follows the strict service contract", async () => {
  const startupUnavailable = structuredClone(evidenceReadyFixture());
  startupUnavailable.batchInputs.strategy.rankings.startup = {
    status: "unavailable",
    evidenceIds: [],
  };
  globalThis.fetch = async () => Response.json(startupUnavailable);
  await assert.rejects(analyze(), assertClientCode("INVALID_BRIDGE_RESPONSE"));

  const emptyAvailableCollects = structuredClone(evidenceReadyFixture());
  emptyAvailableCollects.batchInputs.performance.rankings.collect.evidenceIds = [];
  globalThis.fetch = async () => Response.json(emptyAvailableCollects);
  await assert.rejects(analyze(), assertClientCode("INVALID_BRIDGE_RESPONSE"));

  const unavailableMismatch = structuredClone(evidenceReadyFixture());
  unavailableMismatch.batchInputs.execution.availability.comments = false;
  globalThis.fetch = async () => Response.json(unavailableMismatch);
  await assert.rejects(analyze(), assertClientCode("INVALID_BRIDGE_RESPONSE"));
});
