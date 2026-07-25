import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_IDS,
  AGENT_PROJECTS,
  getAgentById,
} from "../app/lib/agent-catalog.mjs";

test("defines exactly nine isolated Agent projects", () => {
  assert.equal(AGENT_PROJECTS.length, 9);
  assert.deepEqual(AGENT_IDS, [
    "content-matrix",
    "competitor-insight",
    "topic-planning",
    "title-planning",
    "media-article",
    "super-writing",
    "viral-speech",
    "lead-video",
    "data-review",
  ]);
  assert.equal(new Set(AGENT_IDS).size, 9);
});

test("every Agent has a stable responsibility and standard output", () => {
  for (const agent of AGENT_PROJECTS) {
    assert.match(agent.index, /^\d{2}$/);
    assert.ok(agent.responsibility.length >= 8);
    assert.ok(agent.output.length >= 4);
    assert.equal(getAgentById(agent.id), agent);
  }
  assert.equal(getAgentById("missing-agent"), null);
});
