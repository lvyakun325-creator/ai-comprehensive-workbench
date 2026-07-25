import assert from "node:assert/strict";
import test from "node:test";
import {
  createTaskSchedulePreview,
  PREVIEW_TASK_SCHEDULE,
} from "../app/lib/workbench-preview.mjs";

test("derives task-center and control summary counts from one schedule", () => {
  const tasks = ["one", "two", "three", "four"].map((id) => ({ id }));
  const preview = createTaskSchedulePreview(tasks, 2);

  assert.deepEqual(preview.running.map(({ id }) => id), ["one", "two"]);
  assert.deepEqual(preview.queued.map(({ id }) => id), ["three", "four"]);
  assert.equal(preview.runningCount, 2);
  assert.equal(preview.queuedCount, 2);
  assert.equal(preview.summaryLabel, "运行中 2 · 排队中 2");
  assert.equal(preview.capacityLabel, "运行中 2 · 排队中 2 · 最大并发 2");
});

test("provides the shared five-task workbench preview", () => {
  assert.equal(PREVIEW_TASK_SCHEDULE.runningCount, 3);
  assert.equal(PREVIEW_TASK_SCHEDULE.queuedCount, 2);
});
