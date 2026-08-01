import assert from "node:assert/strict";
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

const jsonResponse = (body, init = {}) => new Response(JSON.stringify(body), {
  status: init.status ?? 200,
  headers: {
    "content-type": "application/json; charset=utf-8",
    ...(init.headers ?? {}),
  },
});

test("loads a complete typed competitor snapshot", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url, init) => {
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
  };

  const snapshot = await loadCompetitorProjectRecords();

  assert.equal(snapshot.tasks[0].sourceUrl, TASK_FIXTURE.sourceUrl);
  assert.equal(snapshot.results[0].kind, "excel");
  assert.equal(snapshot.results[0].absolutePath, ARTIFACT_FIXTURE.absolutePath);
});

test("parses one bundle with child artifact ids", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => jsonResponse({
    ok: true,
    tasks: [TASK_FIXTURE],
    bundles: [BUNDLE_FIXTURE],
    artifacts: [ARTIFACT_FIXTURE],
  });

  const snapshot = await loadCompetitorProjectRecords();

  assert.equal(snapshot.bundles[0].category, "xhs-account");
  assert.deepEqual(snapshot.bundles[0].artifactIds, [ARTIFACT_FIXTURE.id]);
  assert.equal(snapshot.bundles[0].primaryArtifactId, ARTIFACT_FIXTURE.id);
});

test("finalizes loads reveals and safely downloads a bundle by id", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (url, init) => {
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
  };

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
    globalThis.fetch = async () => response.clone();
    await assert.rejects(
      downloadCompetitorBundle(BUNDLE_FIXTURE.id),
      (error) => error instanceof CompetitorProjectRecordsClientError && error.code === "INVALID_BRIDGE_RESPONSE",
    );
  }
});

test("creates updates and registers one task through exact bridge contracts", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({url: String(url), init});
    if (String(url).endsWith("/project-tasks")) {
      return jsonResponse({ok: true, task: {...TASK_FIXTURE, status: "waiting", progress: 10}});
    }
    if (init?.method === "PATCH") {
      return jsonResponse({ok: true, task: {...TASK_FIXTURE, status: "running", progress: 60}});
    }
    return jsonResponse({ok: true, tasks: [TASK_FIXTURE], artifacts: [ARTIFACT_FIXTURE]});
  };

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
  globalThis.fetch = async (url, init) => {
    request = {url: String(url), init};
    return jsonResponse({ok: true, artifactId: ARTIFACT_FIXTURE.id});
  };

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
    globalThis.fetch = async () => jsonResponse(body);
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
  globalThis.fetch = async () => jsonResponse({
    ok: false,
    error: "RECORD_STORE_DAMAGED",
    message: "sensitive server detail",
  }, {status: 503});

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
