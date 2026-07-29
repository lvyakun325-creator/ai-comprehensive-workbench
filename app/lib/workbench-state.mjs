import { getAgentById } from "./agent-catalog.mjs";

export const WORKBENCH_VIEWS = Object.freeze([
  "control",
  "agents",
  "tasks",
  "assets",
  "analytics",
  "models",
  "settings",
]);

export function createInitialState() {
  return { view: "control", activeAgentId: null };
}

export function navigateTo(state, view) {
  if (!WORKBENCH_VIEWS.includes(view)) {
    throw new Error(`Unknown view: ${view}`);
  }
  return { ...state, view, activeAgentId: null };
}

export function openAgent(state, agentId) {
  if (!getAgentById(agentId)) {
    throw new Error(`Unknown Agent: ${agentId}`);
  }
  return { ...state, view: "agent", activeAgentId: agentId };
}

export function canAgentAccessProject(agentId, project) {
  return (
    project.ownerAgentId === agentId ||
    project.visibility === "public-readonly"
  );
}

export function normalizeTaskConcurrency(concurrency = 3) {
  return Number.isFinite(concurrency)
    ? Math.max(0, Math.min(3, Math.floor(concurrency)))
    : 3;
}

export function scheduleTasks(tasks, concurrency = 3) {
  const effectiveConcurrency = normalizeTaskConcurrency(concurrency);
  return {
    running: tasks.slice(0, effectiveConcurrency),
    queued: tasks.slice(effectiveConcurrency),
  };
}

export function createHandoffPreview(sourceAgentId, targetAgentId, artifactId) {
  return {
    sourceAgentId,
    targetAgentId,
    artifactId,
    access: "readonly-copy",
    confirmed: false,
  };
}
