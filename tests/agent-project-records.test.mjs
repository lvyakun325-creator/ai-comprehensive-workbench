import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_RESULTS,
  PROJECT_TASKS,
  TASK_STATUSES,
  getAgentResults,
  getAgentTasks,
  getTaskResults,
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

test("returns result history for a task without changing exported fixtures", () => {
  const before = PROJECT_RESULTS.map((result) => result.id);
  const results = getTaskResults("matrix-completed");

  assert.equal(results.length, 1);
  assert.equal(results[0].taskId, "matrix-completed");
  assert.deepEqual(PROJECT_RESULTS.map((result) => result.id), before);
});
