import assert from "node:assert/strict";
import test from "node:test";
import {
  CompetitorProjectRecordsClientError,
  createCompetitorTask,
  loadCompetitorProjectRecords,
  registerCompetitorArtifacts,
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
