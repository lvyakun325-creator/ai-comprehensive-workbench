import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import path from "node:path";
import test from "node:test";
import {
  CompetitorProjectRecordsClientError,
  createCompetitorTask,
  downloadCompetitorBundle,
  finalizeCompetitorBundle,
  loadCompetitorProjectRecords,
  loadCompetitorBundleDetail,
  registerCompetitorArtifacts,
  revealCompetitorBundle,
  revealCompetitorArtifact,
  updateCompetitorTask,
} from "../app/lib/competitor-project-records-client.ts";


const TASK_FIXTURE = {
  id: "competitor-20260801-client-a1",
  agentId: "competitor-insight",
  title: "小红书作品抓取",
  platformId: "xiaohongshu",
  platformLabel: "小红书",
  skillId: "xiaohongshu-scraper",
  sourceUrl: "https://www.xiaohongshu.com/explore/abc",
  status: "completed",
  progress: 100,
  currentStep: "成果已登记",
  model: "xiaohongshu-scraper",
  createdAt: "2026-08-01T01:00:00.000Z",
  updatedAt: "2026-08-01T01:02:00.000Z",
  completedAt: "2026-08-01T01:02:00.000Z",
  stoppedAt: null,
  errorSummary: null,
  artifactIds: ["artifact-0000000000000001"],
  inputKind: "account",
  category: "xhs-account",
  bundleId: "bundle-0000000000000001",
};

const ARTIFACT_FIXTURE = {
  id: "artifact-0000000000000001",
  agentId: "competitor-insight",
  taskId: "competitor-20260801-client-a1",
  kind: "excel",
  name: "result.xlsx",
  filename: "result.xlsx",
  absolutePath: "/controlled/outputs/competitor-insight/xiaohongshu/result.xlsx",
  sizeBytes: 128,
  createdAt: "2026-08-01T01:02:00.000Z",
  completedAt: "2026-08-01T01:02:00.000Z",
  previewable: false,
  exists: true,
  isDirectory: false,
  markdown: null,
};

const BUNDLE_FIXTURE = {
  id: "bundle-0000000000000001",
  agentId: "competitor-insight",
  taskId: TASK_FIXTURE.id,
  platformId: "xiaohongshu",
  inputKind: "account",
  category: "xhs-account",
  subjectName: "测试账号",
  itemCount: 1,
  status: "ready",
  rootDirectory: "/controlled/outputs/competitor-insight/xiaohongshu/run",
  primaryReportPath: ARTIFACT_FIXTURE.absolutePath,
  manifestPath: "/controlled/outputs/competitor-insight/xiaohongshu/run/bundle-0000000000000001.manifest.json",
  archivePath: "/controlled/outputs/competitor-insight/xiaohongshu/run/bundle-0000000000000001.zip",
  artifactIds: [ARTIFACT_FIXTURE.id],
  createdAt: "2026-08-01T01:01:00.000Z",
  updatedAt: "2026-08-01T01:02:00.000Z",
};

const LEGACY_ROOT = `/controlled/outputs/competitor-insight/xiaohongshu/${TASK_FIXTURE.id}`;
const LEGACY_ARTIFACT_FIXTURE = {
  ...ARTIFACT_FIXTURE,
  absolutePath: `${LEGACY_ROOT}/report.md`,
  filename: "report.md",
  name: "report.md",
};
const LEGACY_BUNDLE_FIXTURE = {
  id: BUNDLE_FIXTURE.id,
  agentId: "competitor-insight",
  taskId: TASK_FIXTURE.id,
  platformId: "xiaohongshu",
  inputKind: "unknown",
  category: null,
  subjectName: TASK_FIXTURE.title,
  itemCount: 0,
  status: "legacy",
  rootDirectory: LEGACY_ROOT,
  primaryReportPath: LEGACY_ARTIFACT_FIXTURE.absolutePath,
  manifestPath: `${LEGACY_ROOT}/${BUNDLE_FIXTURE.id}.manifest.json`,
  archivePath: `${LEGACY_ROOT}/${BUNDLE_FIXTURE.id}.zip`,
  artifactIds: [LEGACY_ARTIFACT_FIXTURE.id],
  manifestSha256: null,
  archiveSha256: null,
  memberIdentitySha256: null,
  createdAt: TASK_FIXTURE.completedAt,
  updatedAt: TASK_FIXTURE.updatedAt,
};

const jsonResponse = (body, init = {}) => new Response(JSON.stringify(body), {
  status: init.status ?? 200,
  headers: {
    "content-type": "application/json; charset=utf-8",
    ...(init.headers ?? {}),
  },
});

function withRecordsHealth(handler) {
  return async (input, init) => {
    if (String(input).endsWith("/health")) {
      return jsonResponse({
        ok: true,
        stage: "healthy",
        service: "competitor-insight-report",
      });
    }
    return handler(input, init);
  };
}

function task5LegacyStateSnapshots() {
  const runtimeDir = path.join(process.cwd(), "agents", "competitor-insight", "runtime");
  const testDir = path.join(runtimeDir, "tests");
  const script = String.raw`
import json
import sys
from pathlib import Path

sys.path.insert(0, ${JSON.stringify(runtimeDir)})
sys.path.insert(0, ${JSON.stringify(testDir)})
import project_records
from test_project_records import ProjectRecordTests

case = ProjectRecordTests("test_v1_completed_task_migrates_to_one_legacy_bundle_without_moving_files")
case.setUp()
try:
    case.write_v1_store_with_three_artifacts()
    initial = project_records.read_records("competitor-insight")
    bundle_id = initial["bundles"][0]["id"]
    project_records.bundle_archive(bundle_id)
    materialized = project_records.read_records("competitor-insight")
    Path(materialized["bundles"][0]["primaryReportPath"]).unlink()
    missing = project_records.read_records("competitor-insight")
    print(json.dumps({"materialized": materialized, "missing": missing}))
finally:
    case.tearDown()
`;
  return JSON.parse(execFileSync("python3", ["-c", script], {encoding: "utf8"}));
}

test("loads a complete typed competitor snapshot", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = withRecordsHealth(async (url, init) => {
    assert.equal(
      String(url),
      "http://127.0.0.1:8768/project-records?agentId=competitor-insight",
    );
    assert.equal(init?.method, "GET");
    return jsonResponse({
      ok: true,
      tasks: [TASK_FIXTURE],
      artifacts: [ARTIFACT_FIXTURE],
    });
  });

  const snapshot = await loadCompetitorProjectRecords();

  assert.equal(snapshot.tasks[0].sourceUrl, TASK_FIXTURE.sourceUrl);
  assert.equal(snapshot.results[0].kind, "excel");
  assert.equal(snapshot.results[0].absolutePath, ARTIFACT_FIXTURE.absolutePath);
});

test("wrong records health identity fails closed before project records are requested", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let businessRequests = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return jsonResponse({ok: true, stage: "healthy", service: "wrong-service"});
    }
    businessRequests += 1;
    return jsonResponse({ok: true, tasks: [], artifacts: [], bundles: []});
  };

  await assert.rejects(
    loadCompetitorProjectRecords(),
    (error) => error?.code === "BRIDGE_UNAVAILABLE",
  );
  assert.equal(businessRequests, 0);
});

test("parses one bundle with child artifact ids", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = withRecordsHealth(async () => jsonResponse({
    ok: true,
    tasks: [TASK_FIXTURE],
    bundles: [BUNDLE_FIXTURE],
    artifacts: [ARTIFACT_FIXTURE],
  }));

  const snapshot = await loadCompetitorProjectRecords();

  assert.equal(snapshot.bundles[0].category, "xhs-account");
  assert.deepEqual(snapshot.bundles[0].artifactIds, [ARTIFACT_FIXTURE.id]);
  assert.equal(snapshot.bundles[0].primaryArtifactId, ARTIFACT_FIXTURE.id);
});

test("keeps v1 legacy bundles from rejecting compatible task and artifact snapshots", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = withRecordsHealth(async () => jsonResponse({
    ok: true,
    tasks: [{...TASK_FIXTURE, inputKind: "unknown", category: null}],
    artifacts: [LEGACY_ARTIFACT_FIXTURE],
    bundles: [LEGACY_BUNDLE_FIXTURE],
  }));

  const snapshot = await loadCompetitorProjectRecords();

  assert.equal(snapshot.tasks[0].id, TASK_FIXTURE.id);
  assert.equal(snapshot.results[0].id, ARTIFACT_FIXTURE.id);
  assert.equal(snapshot.bundles.length, 1);
  assert.equal(snapshot.bundles[0].status, "legacy");
  assert.equal(snapshot.bundles[0].primaryArtifactId, LEGACY_ARTIFACT_FIXTURE.id);
});

test("filters Task5 materialized and refreshed-missing legacy snapshots without losing history", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const snapshots = task5LegacyStateSnapshots();
  const materialized = snapshots.materialized;
  const missing = snapshots.missing;
  assert.equal(materialized.bundles[0].status, "legacy");
  assert.ok(["manifestSha256", "archiveSha256", "memberIdentitySha256"].every(
    (field) => /^[0-9a-f]{64}$/u.test(materialized.bundles[0][field]),
  ));
  assert.equal(missing.bundles[0].status, "missing");

  for (const body of [materialized, missing]) {
    globalThis.fetch = withRecordsHealth(async () => jsonResponse({ok: true, ...body}));
    const snapshot = await loadCompetitorProjectRecords();
    assert.equal(snapshot.tasks.length, 1);
    assert.equal(snapshot.results.length, 4);
    assert.equal(snapshot.bundles.length, 1);
    assert.equal(snapshot.bundles[0].status, body.bundles[0].status);
  }
});

test("rejects mixed invalid or v2-marked legacy commitments", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const task = {...TASK_FIXTURE, inputKind: "unknown", category: null};
  const hash = "a".repeat(64);
  const malformed = [
    {...LEGACY_BUNDLE_FIXTURE, manifestSha256: hash},
    {...LEGACY_BUNDLE_FIXTURE, manifestSha256: hash, archiveSha256: hash, memberIdentitySha256: "A".repeat(64)},
    {...LEGACY_BUNDLE_FIXTURE, status: "ready"},
  ];
  for (const bundle of malformed) {
    globalThis.fetch = withRecordsHealth(async () => jsonResponse({
      ok: true, tasks: [task], artifacts: [LEGACY_ARTIFACT_FIXTURE], bundles: [bundle],
    }));
    await assert.rejects(
      loadCompetitorProjectRecords(),
      (error) => error instanceof CompetitorProjectRecordsClientError && error.code === "INVALID_BRIDGE_RESPONSE",
    );
  }
});

test("rejects every missing or unexpected field in a legacy bundle", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const base = {
    ok: true,
    tasks: [{...TASK_FIXTURE, inputKind: "unknown", category: null}],
    artifacts: [LEGACY_ARTIFACT_FIXTURE],
  };

  for (const field of Object.keys(LEGACY_BUNDLE_FIXTURE)) {
    const malformed = {...LEGACY_BUNDLE_FIXTURE};
    delete malformed[field];
    globalThis.fetch = withRecordsHealth(async () => jsonResponse({...base, bundles: [malformed]}));
    await assert.rejects(
      loadCompetitorProjectRecords(),
      (error) => error instanceof CompetitorProjectRecordsClientError && error.code === "INVALID_BRIDGE_RESPONSE",
      `missing legacy field ${field}`,
    );
  }
  globalThis.fetch = withRecordsHealth(async () => jsonResponse({
    ...base,
    bundles: [{...LEGACY_BUNDLE_FIXTURE, unexpected: "not-a-task5-field"}],
  }));
  await assert.rejects(
    loadCompetitorProjectRecords(),
    (error) => error instanceof CompetitorProjectRecordsClientError && error.code === "INVALID_BRIDGE_RESPONSE",
  );
});

test("rejects legacy bundles with broken task artifact or controlled-path relations", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const task = {...TASK_FIXTURE, inputKind: "unknown", category: null};
  const cases = [
    {name: "bundle id", bundle: {...LEGACY_BUNDLE_FIXTURE, id: "bundle-invalid"}},
    {name: "agent", bundle: {...LEGACY_BUNDLE_FIXTURE, agentId: "other-agent"}},
    {name: "task", bundle: {...LEGACY_BUNDLE_FIXTURE, taskId: "competitor-20260801-client-z9"}},
    {name: "platform", bundle: {...LEGACY_BUNDLE_FIXTURE, platformId: "douyin"}},
    {name: "root", bundle: {...LEGACY_BUNDLE_FIXTURE, rootDirectory: "/tmp/uncontrolled"}},
    {name: "primary report", bundle: {...LEGACY_BUNDLE_FIXTURE, primaryReportPath: `${LEGACY_ROOT}/outside.txt`}},
    {name: "primary report artifact membership", bundle: {...LEGACY_BUNDLE_FIXTURE, primaryReportPath: `${LEGACY_ROOT}/not-an-artifact.md`}},
    {name: "manifest", bundle: {...LEGACY_BUNDLE_FIXTURE, manifestPath: `${LEGACY_ROOT}/not-the-bundle.json`}},
    {name: "archive", bundle: {...LEGACY_BUNDLE_FIXTURE, archivePath: `${LEGACY_ROOT}/not-the-bundle.zip`}},
    {name: "artifact ids", bundle: {...LEGACY_BUNDLE_FIXTURE, artifactIds: ["artifact-0000000000000002"]}},
  ];
  for (const {name, bundle} of cases) {
    globalThis.fetch = withRecordsHealth(async () => jsonResponse({ok: true, tasks: [task], artifacts: [LEGACY_ARTIFACT_FIXTURE], bundles: [bundle]}));
    await assert.rejects(
      loadCompetitorProjectRecords(),
      (error) => error instanceof CompetitorProjectRecordsClientError && error.code === "INVALID_BRIDGE_RESPONSE",
      `broken legacy ${name}`,
    );
  }
  globalThis.fetch = withRecordsHealth(async () => jsonResponse({
    ok: true,
    tasks: [{...task, bundleId: "bundle-0000000000000002"}],
    artifacts: [LEGACY_ARTIFACT_FIXTURE],
    bundles: [LEGACY_BUNDLE_FIXTURE],
  }));
  await assert.rejects(
    loadCompetitorProjectRecords(),
    (error) => error instanceof CompetitorProjectRecordsClientError && error.code === "INVALID_BRIDGE_RESPONSE",
    "broken legacy task bundle reverse relation",
  );
});

test("finalizes loads reveals and safely downloads a bundle by id", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = withRecordsHealth(async (url, init) => {
    calls.push({url: String(url), init});
    if (String(url).endsWith("/download")) {
      return new Response(new Uint8Array([0x50, 0x4b, 3, 4]), {
        status: 200,
        headers: {
          "content-type": "application/zip",
          "content-length": "4",
          "content-disposition": 'attachment; filename="bundle.zip"',
        },
      });
    }
    if (String(url).endsWith("/reveal")) return jsonResponse({ok: true, bundleId: BUNDLE_FIXTURE.id});
    if (init?.method === "POST") return jsonResponse({ok: true, tasks: [TASK_FIXTURE], artifacts: [ARTIFACT_FIXTURE], bundles: [BUNDLE_FIXTURE]});
    return jsonResponse({ok: true, bundle: BUNDLE_FIXTURE, task: TASK_FIXTURE, artifacts: [ARTIFACT_FIXTURE], markdown: "# preview", previewable: true});
  });

  const finalized = await finalizeCompetitorBundle(TASK_FIXTURE.id, {
    platformId: "xiaohongshu", inputKind: "account", category: "xhs-account",
    outputDir: BUNDLE_FIXTURE.rootDirectory, primaryReportPath: ARTIFACT_FIXTURE.absolutePath,
    explicitPaths: [ARTIFACT_FIXTURE.absolutePath], subjectName: "测试账号", itemCount: 1,
  });
  const detail = await loadCompetitorBundleDetail(BUNDLE_FIXTURE.id);
  const download = await downloadCompetitorBundle(BUNDLE_FIXTURE.id);
  await revealCompetitorBundle(BUNDLE_FIXTURE.id);

  assert.equal(finalized.bundle.id, BUNDLE_FIXTURE.id);
  assert.equal(detail.markdown, "# preview");
  assert.equal(download.filename, "bundle.zip");
  assert.equal(await download.blob.text(), "PK\u0003\u0004");
  assert.deepEqual(calls.map((call) => call.init?.method), ["POST", "GET", "GET", "POST"]);
});

test("rejects invalid bundle download media length and ZIP signature", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  for (const response of [
    new Response("not zip", {status: 200, headers: {"content-type": "text/plain", "content-length": "7"}}),
    new Response(new Uint8Array([0x50, 0x4b]), {status: 200, headers: {"content-type": "application/zip", "content-length": String(513 * 1024 * 1024)}}),
    new Response(new Uint8Array([1, 2, 3, 4]), {status: 200, headers: {"content-type": "application/zip", "content-length": "4"}}),
  ]) {
    globalThis.fetch = withRecordsHealth(async () => response.clone());
    await assert.rejects(
      downloadCompetitorBundle(BUNDLE_FIXTURE.id),
      (error) => error instanceof CompetitorProjectRecordsClientError && error.code === "INVALID_BRIDGE_RESPONSE",
    );
  }
});

test("normalizes unknown download errors and stalled ZIP aborts", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = withRecordsHealth(async () => jsonResponse({error: "SECRET_FROM_BODY", message: "sensitive"}, {status: 500}));
  await assert.rejects(
    downloadCompetitorBundle(BUNDLE_FIXTURE.id),
    (error) => error instanceof CompetitorProjectRecordsClientError && error.code === "INTERNAL_ERROR" && !/SECRET_FROM_BODY|sensitive/u.test(error.message),
  );

  let canceled = false;
  const stalled = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([0x50, 0x4b])); },
    cancel() { canceled = true; },
  });
  globalThis.fetch = withRecordsHealth(async () => new Response(stalled, {
    status: 200,
    headers: {"content-type": "application/zip", "content-length": "4"},
  }));
  const controller = new AbortController();
  const pending = downloadCompetitorBundle(BUNDLE_FIXTURE.id, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  await assert.rejects(pending, (error) => error instanceof DOMException && error.name === "AbortError");
  assert.equal(canceled, true);
});

test("normalizes non-2xx error-body aborts during done, read rejection, and cancel rejection", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const partialError = new TextEncoder().encode('{"error":"');
  const scenarios = [
    {
      name: "done after cancel",
      makeBody: () => new ReadableStream({start(controller) { controller.enqueue(partialError); }}),
    },
    {
      name: "read rejection after cancel",
      makeBody: () => new ReadableStream({
        start(controller) { controller.enqueue(partialError); },
        cancel() { throw new Error("reader rejected while aborting"); },
      }),
    },
    {
      name: "cancel rejection",
      makeBody: () => new ReadableStream({
        start(controller) { controller.enqueue(partialError); },
        cancel() { return Promise.reject(new Error("cancel rejected")); },
      }),
    },
  ];
  for (const {name, makeBody} of scenarios) {
    globalThis.fetch = withRecordsHealth(async () => new Response(makeBody(), {
      status: 500,
      headers: {"content-type": "application/json"},
    }));
    const controller = new AbortController();
    const pending = downloadCompetitorBundle(BUNDLE_FIXTURE.id, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await assert.rejects(
      pending,
      (error) => error instanceof DOMException && error.name === "AbortError",
      `non-2xx ${name}`,
    );
  }
});

test("cancels a genuinely oversized streamed ZIP body without allocating 512 MiB", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const chunk = new Uint8Array(1024 * 1024);
  chunk.set([0x50, 0x4b]);
  let sent = 0;
  let canceled = false;
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(chunk);
      sent += 1;
    },
    cancel() { canceled = true; },
  });
  globalThis.fetch = withRecordsHealth(async () => new Response(body, {
    status: 200,
    headers: {"content-type": "application/zip", "content-length": String(512 * 1024 * 1024)},
  }));

  await assert.rejects(
    downloadCompetitorBundle(BUNDLE_FIXTURE.id),
    (error) => error instanceof CompetitorProjectRecordsClientError && error.code === "INVALID_BRIDGE_RESPONSE",
  );
  assert.equal(canceled, true);
  assert.ok(sent >= 513);
});

test("rejects inconsistent bundle detail preview tuples", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = withRecordsHealth(async () => jsonResponse({
    ok: true, bundle: BUNDLE_FIXTURE, task: TASK_FIXTURE, artifacts: [ARTIFACT_FIXTURE],
    markdown: null, previewable: true,
  }));
  await assert.rejects(
    loadCompetitorBundleDetail(BUNDLE_FIXTURE.id),
    (error) => error instanceof CompetitorProjectRecordsClientError && error.code === "INVALID_BRIDGE_RESPONSE",
  );
});

test("creates updates and registers one task through exact bridge contracts", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const calls = [];
  globalThis.fetch = withRecordsHealth(async (url, init) => {
    calls.push({url: String(url), init});
    if (String(url).endsWith("/project-tasks")) {
      return jsonResponse({ok: true, task: {...TASK_FIXTURE, status: "waiting", progress: 10}});
    }
    if (init?.method === "PATCH") {
      return jsonResponse({ok: true, task: {...TASK_FIXTURE, status: "running", progress: 60}});
    }
    return jsonResponse({ok: true, tasks: [TASK_FIXTURE], artifacts: [ARTIFACT_FIXTURE]});
  });

  const created = await createCompetitorTask({
    id: TASK_FIXTURE.id,
    title: TASK_FIXTURE.title,
    platformId: TASK_FIXTURE.platformId,
    platformLabel: TASK_FIXTURE.platformLabel,
    skillId: TASK_FIXTURE.skillId,
    sourceUrl: TASK_FIXTURE.sourceUrl,
  });
  const updated = await updateCompetitorTask(TASK_FIXTURE.id, {
    status: "running",
    progress: 60,
    currentStep: "正在抓取平台数据",
  });
  const snapshot = await registerCompetitorArtifacts(TASK_FIXTURE.id, {
    outputDir: "/controlled/outputs/competitor-insight/xiaohongshu",
    explicitPaths: [ARTIFACT_FIXTURE.absolutePath],
  });

  assert.equal(created.status, "waiting");
  assert.equal(updated.progress, 60);
  assert.equal(snapshot.results[0].id, ARTIFACT_FIXTURE.id);
  assert.deepEqual(calls.map((call) => call.init?.method), ["POST", "PATCH", "POST"]);
  assert.equal(
    JSON.parse(calls[0].init.body).agentId,
    "competitor-insight",
  );
});

test("reveals an artifact by id with an empty JSON body", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  let request;
  globalThis.fetch = withRecordsHealth(async (url, init) => {
    request = {url: String(url), init};
    return jsonResponse({ok: true, artifactId: ARTIFACT_FIXTURE.id});
  });

  await revealCompetitorArtifact(ARTIFACT_FIXTURE.id);

  assert.equal(
    request.url,
    `http://127.0.0.1:8768/project-artifacts/${ARTIFACT_FIXTURE.id}/reveal`,
  );
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.body, "{}");
});

test("rejects malformed tasks artifacts and unsafe source URLs", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  for (const body of [
    {ok: true, tasks: [{...TASK_FIXTURE, sourceUrl: "file:///tmp/private"}], artifacts: []},
    {ok: true, tasks: [TASK_FIXTURE], artifacts: [{...ARTIFACT_FIXTURE, kind: "executable"}]},
    {ok: true, tasks: [TASK_FIXTURE], artifacts: [{...ARTIFACT_FIXTURE, id: "bad-id"}]},
  ]) {
    globalThis.fetch = withRecordsHealth(async () => jsonResponse(body));
    await assert.rejects(
      loadCompetitorProjectRecords(),
      (error) =>
        error instanceof CompetitorProjectRecordsClientError
        && error.code === "INVALID_BRIDGE_RESPONSE",
    );
  }
});

test("maps bridge errors without echoing a response body", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = withRecordsHealth(async () => jsonResponse({
    ok: false,
    error: "RECORD_STORE_DAMAGED",
    message: "sensitive server detail",
  }, {status: 503}));

  await assert.rejects(
    loadCompetitorProjectRecords(),
    (error) => {
      assert.ok(error instanceof CompetitorProjectRecordsClientError);
      assert.equal(error.code, "RECORD_STORE_DAMAGED");
      assert.doesNotMatch(error.message, /sensitive server detail/);
      return true;
    },
  );
});
