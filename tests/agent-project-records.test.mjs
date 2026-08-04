import assert from "node:assert/strict";
import test from "node:test";
import * as projectRecords from "../app/lib/agent-project-records.mjs";
import {
  PROJECT_RESULTS,
  PROJECT_TASKS,
  TASK_STATUSES,
  getAgentResults,
  getAgentBundles,
  getBundleArtifacts,
  getAgentTasks,
  getTaskBundle,
  getTaskResults,
  mergeProjectBundles,
  mergeProjectResults,
  mergeProjectTasks,
} from "../app/lib/agent-project-records.mjs";

test("defines every supported task status exactly once", () => {
  assert.deepEqual(TASK_STATUSES, [
    "waiting",
    "running",
    "completed",
    "stopped",
    "failed",
  ]);
  assert.equal(new Set(TASK_STATUSES).size, TASK_STATUSES.length);
});

test("sorts current and historical tasks newest first", () => {
  const tasks = getAgentTasks("content-matrix", "all");

  assert.deepEqual(tasks.map((task) => task.id), [
    "matrix-running",
    "matrix-completed",
  ]);
});

test("filters task status without mutating records", () => {
  const before = PROJECT_TASKS.map((task) => task.id);
  const tasks = getAgentTasks("content-matrix", "running");

  assert.ok(tasks.every((task) => task.status === "running"));
  assert.deepEqual(PROJECT_TASKS.map((task) => task.id), before);
});

test("exposes markdown only for completed tasks", () => {
  const results = getAgentResults("content-matrix");
  const completedTasks = getAgentTasks("content-matrix", "completed");

  assert.ok(results.every((result) => result.filename.endsWith(".md")));
  assert.ok(
    results.every((result) =>
      completedTasks.some((task) => task.id === result.taskId),
    ),
  );
  assert.match(results[0].markdown, /^# 内容矩阵方案/);
});

test("looks up source tasks and rejects invalid result relationships", () => {
  assert.equal(typeof projectRecords.getTaskById, "function");
  assert.equal(typeof projectRecords.isValidProjectResult, "function");

  const sourceTask = projectRecords.getTaskById("matrix-completed");
  assert.equal(sourceTask?.title, "慢病管理内容矩阵初版");
  assert.equal(projectRecords.getTaskById("missing-task"), undefined);

  assert.equal(
    projectRecords.isValidProjectResult({
      ...PROJECT_RESULTS[0],
      agentId: "competitor-insight",
    }),
    false,
  );
  assert.equal(
    projectRecords.isValidProjectResult({
      ...PROJECT_RESULTS[0],
      taskId: "matrix-running",
    }),
    false,
  );
  assert.equal(
    projectRecords.isValidProjectResult({
      ...PROJECT_RESULTS[0],
      filename: "not-markdown.txt",
    }),
    false,
  );
  assert.equal(projectRecords.isValidProjectResult(PROJECT_RESULTS[0]), true);
});

test("derives exact result sizes from UTF-8 Markdown content", () => {
  assert.equal(PROJECT_RESULTS[0].sizeBytes, 123);
  assert.equal(PROJECT_RESULTS[1].sizeBytes, 88);
});

test("every queried result belongs to a completed task owned by the same Agent", () => {
  for (const agentId of ["content-matrix", "competitor-insight"]) {
    for (const result of getAgentResults(agentId)) {
      const task = projectRecords.getTaskById(result.taskId);

      assert.ok(task);
      assert.equal(task.status, "completed");
      assert.equal(task.agentId, agentId);
      assert.equal(result.agentId, agentId);
      assert.match(result.filename, /\.md$/i);
    }
  }
});

test("keeps orphan Markdown metadata queryable so the UI can show an abnormal relation", () => {
  const orphanResult = {
    ...PROJECT_RESULTS[0],
    id: "orphan-result",
    taskId: "missing-task",
  };
  const results = getAgentResults("content-matrix", [orphanResult]);

  assert.deepEqual(results.map((result) => result.id), ["orphan-result"]);
  assert.equal(projectRecords.isValidProjectResult(results[0]), false);
});

test("returns result history for a task without changing exported fixtures", () => {
  const before = PROJECT_RESULTS.map((result) => result.id);
  const results = getTaskResults("matrix-completed");

  assert.equal(results.length, 1);
  assert.equal(results[0].taskId, "matrix-completed");
  assert.deepEqual(PROJECT_RESULTS.map((result) => result.id), before);
});

test("merges dynamic task and artifact records without duplicating fixture ids", () => {
  const newerTask = {
    ...PROJECT_TASKS[2],
    title: "真实持久任务",
    updatedAt: "2026-08-01T10:00:00.000Z",
  };
  const dynamicArtifact = {
    id: "artifact-0000000000000001",
    agentId: "competitor-insight",
    taskId: "competitor-completed",
    filename: "result.xlsx",
    completedAt: "2026-08-01T10:00:00.000Z",
    sizeBytes: 128,
    markdown: null,
    kind: "excel",
    absolutePath: "/controlled/result.xlsx",
    exists: true,
    isDirectory: false,
  };

  const tasks = mergeProjectTasks(PROJECT_TASKS, [newerTask]);
  const results = mergeProjectResults(PROJECT_RESULTS, [dynamicArtifact]);

  assert.equal(tasks.filter((task) => task.id === newerTask.id).length, 1);
  assert.equal(tasks.find((task) => task.id === newerTask.id).title, "真实持久任务");
  assert.equal(results[0].id, dynamicArtifact.id);
  assert.equal(PROJECT_TASKS[2].title, "OTC 竞品内容机会盘点");
});

test("queries registered non-Markdown artifacts for a completed competitor task", () => {
  const artifact = {
    ...PROJECT_RESULTS[1],
    id: "artifact-0000000000000002",
    filename: "result.json",
    kind: "json",
    absolutePath: "/controlled/result.json",
    markdown: null,
  };

  const results = getAgentResults("competitor-insight", [artifact]);
  const taskResults = getTaskResults(
    "competitor-completed",
    [artifact],
    PROJECT_TASKS,
  );

  assert.deepEqual(results.map((result) => result.id), [artifact.id]);
  assert.deepEqual(taskResults.map((result) => result.id), [artifact.id]);
});

test("queries completed bundles only when their task relationships are consistent", () => {
  const task = {
    ...PROJECT_TASKS[2],
    id: "competitor-20260801-bundle-a1",
    platformId: "xiaohongshu",
    platformLabel: "小红书",
    inputKind: "account",
    category: "xhs-account",
    bundleId: "bundle-0000000000000001",
  };
  const artifacts = [{
    id: "artifact-0000000000000001",
    agentId: "competitor-insight",
    taskId: task.id,
    filename: "report.md",
    completedAt: "2026-08-01T02:00:00.000Z",
    sizeBytes: 12,
    markdown: null,
    kind: "markdown",
    absolutePath: "/controlled/report.md",
    exists: true,
    isDirectory: false,
    previewable: true,
  }];
  const bundle = {
    id: "bundle-0000000000000001",
    agentId: "competitor-insight",
    taskId: task.id,
    platformId: "xiaohongshu",
    platformLabel: "小红书",
    inputKind: "account",
    category: "xhs-account",
    title: task.title,
    subjectName: "测试账号",
    sourceUrl: "https://www.xiaohongshu.com/user/profile/a",
    status: "ready",
    primaryArtifactId: artifacts[0].id,
    manifestPath: "/controlled/bundle.manifest.json",
    archivePath: "/controlled/bundle.zip",
    rootDirectory: "/controlled",
    artifactIds: [artifacts[0].id],
    itemCount: 1,
    createdAt: "2026-08-01T01:00:00.000Z",
    completedAt: "2026-08-01T02:00:00.000Z",
  };
  const orphan = {...bundle, id: "bundle-0000000000000002", taskId: "missing-task"};

  const bundles = mergeProjectBundles([], [bundle, orphan], [task]);

  assert.deepEqual(bundles.map((item) => item.id), [bundle.id]);
  assert.equal(getAgentBundles("competitor-insight", bundles, [task])[0].id, bundle.id);
  assert.equal(getTaskBundle(task.id, bundles, [task])?.id, bundle.id);
  assert.deepEqual(getBundleArtifacts(bundle.id, bundles, artifacts).map((item) => item.id), artifacts.map((item) => item.id));

  assert.equal(projectRecords.isValidProjectBundle({...bundle, platformId: "douyin", inputKind: "content", category: "douyin-content"}, [task]), false);
  assert.deepEqual(getBundleArtifacts(bundle.id, bundles, [{...artifacts[0], agentId: "other-agent"}]), []);
});
