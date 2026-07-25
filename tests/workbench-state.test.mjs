import assert from "node:assert/strict";
import test from "node:test";
import {
  canAgentAccessProject,
  createHandoffPreview,
  createInitialState,
  navigateTo,
  openAgent,
  scheduleTasks,
} from "../app/lib/workbench-state.mjs";

test("opens only known Agent projects", () => {
  const state = createInitialState();
  assert.deepEqual(state, { view: "control", activeAgentId: null });
  assert.equal(navigateTo(state, "tasks").view, "tasks");
  assert.equal(openAgent(state, "competitor-insight").activeAgentId, "competitor-insight");
  assert.throws(() => openAgent(state, "unknown"), /Unknown Agent/);
});

test("prevents an Agent from accessing another Agent private project", () => {
  const ownProject = { id: "p-1", ownerAgentId: "topic-planning", visibility: "private" };
  const publicAsset = { id: "a-1", ownerAgentId: "control", visibility: "public-readonly" };
  assert.equal(canAgentAccessProject("topic-planning", ownProject), true);
  assert.equal(canAgentAccessProject("title-planning", ownProject), false);
  assert.equal(canAgentAccessProject("title-planning", publicAsset), true);
});

test("runs three tasks and queues the rest", () => {
  const tasks = ["t1", "t2", "t3", "t4", "t5"].map((id) => ({ id }));
  const result = scheduleTasks(tasks, 3);
  assert.deepEqual(result.running.map((task) => task.id), ["t1", "t2", "t3"]);
  assert.deepEqual(result.queued.map((task) => task.id), ["t4", "t5"]);
});

test("handoff preview contains no source project write permission", () => {
  assert.deepEqual(
    createHandoffPreview("competitor-insight", "content-matrix", "artifact-12"),
    {
      sourceAgentId: "competitor-insight",
      targetAgentId: "content-matrix",
      artifactId: "artifact-12",
      access: "readonly-copy",
      confirmed: false,
    },
  );
});
