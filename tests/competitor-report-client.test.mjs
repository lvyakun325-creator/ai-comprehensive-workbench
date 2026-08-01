import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";

import {
  analyzeScrapeArtifacts,
  CompetitorReportClientError,
} from "../app/lib/competitor-report-client.ts";

const originalFetch = globalThis.fetch;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function analyze(signal = new AbortController().signal) {
  return analyzeScrapeArtifacts({
    taskId: "competitor-20260801-a1",
    platformId: "douyin",
    inputKind: "account",
    outputDir: "/controlled/outputs/competitor-insight/douyin/competitor-20260801-a1",
    dataPath: "/controlled/outputs/competitor-insight/douyin/competitor-20260801-a1/结构化数据.json",
    excelPath: null,
  }, signal);
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
    platformId: "douyin",
    inputKind: "account",
    reportType: "douyin-account",
    outputDir: "/controlled/outputs/competitor-insight/douyin/competitor-20260801-a1",
    subjectName: "测试账号",
    itemCount: 1,
    account: {
      nickname: "测试账号",
      followers: 100,
      signature: "分享日常生活与健康管理常识",
    },
    completeness: { missingFields: [], warnings: [] },
    batchInputs: {
      strategy: {
        batchId: "strategy",
        allowedEvidenceIds: ["DY-E0001"],
        account: {
          nickname: "测试账号",
          followers: 100,
          signature: "分享日常生活与健康管理常识",
        },
        availability: { comments: true, collects: true, shares: true },
        rankings: { overall: ranking, startup: ranking },
        evidence,
      },
      performance: {
        batchId: "performance",
        allowedEvidenceIds: ["DY-E0001"],
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
        batchId: "execution",
        allowedEvidenceIds: ["DY-E0001"],
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

function contentEvidenceReadyFixture(platformId = "douyin") {
  const prefix = platformId === "xiaohongshu" ? "XHS" : "DY";
  const inputKind = "content";
  return {
    ok: true, stage: "evidence_ready", evidenceId: "0123456789abcdef",
    platformId, inputKind,
    reportType: platformId === "xiaohongshu" ? "xhs-note" : "douyin-content",
    outputDir: `/controlled/outputs/competitor-insight/${platformId}/competitor-20260801-a1`,
    subjectName: "公开作者", itemCount: 1,
    account: { nickname: "公开作者" }, completeness: {},
    batchInputs: { content: {
      batchId: "content", allowedEvidenceIds: [`${prefix}-E0001`],
      author: { nickname: "公开作者" },
      content: { title: "公开作品", body: "已抓取文本", transcript: "" },
      evidence: [{ evidenceId: `${prefix}-E0001`, title: "公开作品", likes: 1, comments: 1, collects: 1, shares: 1, totalInteractions: 4, publishedAt: "2026-07-01" }],
    }},
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

test("accepts xiaohongshu account IDs and rejects a cross-platform prefix", async () => {
  const fixture = evidenceReadyFixture();
  fixture.platformId = "xiaohongshu";
  fixture.reportType = "xhs-account";
  for (const batch of Object.values(fixture.batchInputs)) {
    batch.allowedEvidenceIds = ["XHS-E0001"];
    batch.evidence[0].evidenceId = "XHS-E0001";
    for (const ranking of Object.values(batch.rankings)) ranking.evidenceIds = ["XHS-E0001"];
  }
  globalThis.fetch = async () => Response.json(fixture);
  await analyze();
  fixture.batchInputs.strategy.evidence[0].evidenceId = "DY-E0001";
  globalThis.fetch = async () => Response.json(fixture);
  await assert.rejects(analyze(), assertClientCode("INVALID_BRIDGE_RESPONSE"));
});

test("accepts exact bounded content batches for douyin and xiaohongshu", async () => {
  for (const platformId of ["douyin", "xiaohongshu"]) {
    globalThis.fetch = async () => Response.json(contentEvidenceReadyFixture(platformId));
    const accepted = await analyze();
    assert.equal(accepted.batchInputs.content.batchId, "content");
  }
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

test("account context is exact bounded and strategy-only before model use", async () => {
  globalThis.fetch = async () => Response.json(evidenceReadyFixture());
  const accepted = await analyze();
  assert.deepEqual(accepted.batchInputs.strategy.account, {
    nickname: "测试账号",
    followers: 100,
    signature: "分享日常生活与健康管理常识",
  });

  for (const mutate of [
    (fixture) => { fixture.account.extra = "forbidden"; },
    (fixture) => { fixture.batchInputs.strategy.account.signature = "超".repeat(1001); },
    (fixture) => { fixture.batchInputs.performance.account = fixture.account; },
    (fixture) => { fixture.batchInputs.strategy.account.followers = "100"; },
  ]) {
    const fixture = structuredClone(evidenceReadyFixture());
    mutate(fixture);
    globalThis.fetch = async () => Response.json(fixture);
    await assert.rejects(analyze(), assertClientCode("INVALID_BRIDGE_RESPONSE"));
  }
});

test("scraper artifact bridge endpoint is 8768 and matches the Python fixed port", async () => {
  let requestedUrl = "";
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return Response.json(evidenceReadyFixture());
  };
  await analyze();
  assert.equal(requestedUrl, "http://127.0.0.1:8768/analyze-artifacts");

  const pythonSource = await readFile(
    new URL("../agents/competitor-insight/runtime/bridge_server.py", import.meta.url),
    "utf8",
  );
  assert.match(pythonSource, /^PORT = 8768$/mu);
});

test("analyze artifacts supports the documented one-argument signal default", async () => {
  globalThis.fetch = async () => Response.json(evidenceReadyFixture());
  const result = await analyzeScrapeArtifacts({
    taskId: "competitor-20260801-a1", platformId: "douyin", inputKind: "account",
    outputDir: "/controlled/outputs/competitor-insight/douyin/competitor-20260801-a1",
    dataPath: "/controlled/outputs/competitor-insight/douyin/competitor-20260801-a1/结构化数据.json", excelPath: null,
  });
  assert.equal(result.stage, "evidence_ready");
});
