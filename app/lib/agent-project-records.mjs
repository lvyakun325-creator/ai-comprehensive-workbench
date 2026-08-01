export const TASK_STATUSES = Object.freeze([
  "waiting",
  "running",
  "completed",
  "stopped",
  "failed",
]);

const clampProgress = (progress) => Math.min(100, Math.max(0, progress));

const createTask = (task) =>
  Object.freeze({
    ...task,
    progress: clampProgress(task.progress),
  });

export const PROJECT_TASKS = Object.freeze([
  createTask({
    id: "matrix-running",
    agentId: "content-matrix",
    title: "7 月健康内容矩阵规划",
    status: "running",
    progress: 68,
    currentStep: "整理平台栏目与周更节奏",
    model: "gpt-5.6",
    createdAt: "2026-07-28T01:20:00.000Z",
    updatedAt: "2026-07-28T03:45:00.000Z",
    completedAt: null,
    stoppedAt: null,
    errorSummary: null,
  }),
  createTask({
    id: "matrix-completed",
    agentId: "content-matrix",
    title: "慢病管理内容矩阵初版",
    status: "completed",
    progress: 100,
    currentStep: "已生成成果 Markdown",
    model: "gpt-5.6",
    createdAt: "2026-07-25T01:10:00.000Z",
    updatedAt: "2026-07-25T02:40:00.000Z",
    completedAt: "2026-07-25T02:40:00.000Z",
    stoppedAt: null,
    errorSummary: null,
  }),
  createTask({
    id: "competitor-completed",
    agentId: "competitor-insight",
    title: "OTC 竞品内容机会盘点",
    status: "completed",
    progress: 100,
    currentStep: "已生成成果 Markdown",
    model: "gpt-5.6",
    createdAt: "2026-07-24T03:00:00.000Z",
    updatedAt: "2026-07-24T04:15:00.000Z",
    completedAt: "2026-07-24T04:15:00.000Z",
    stoppedAt: null,
    errorSummary: null,
  }),
]);

const createResult = (result) =>
  Object.freeze({
    ...result,
    sizeBytes:
      typeof result.markdown === "string"
        ? new TextEncoder().encode(result.markdown).byteLength
        : result.sizeBytes,
  });

export const PROJECT_RESULTS = Object.freeze([
  createResult({
    id: "matrix-plan-result",
    agentId: "content-matrix",
    taskId: "matrix-completed",
    filename: "慢病管理内容矩阵初版.md",
    completedAt: "2026-07-25T02:40:00.000Z",
    markdown: "# 内容矩阵方案\n\n## 核心方向\n\n围绕日常健康管理与合规内容教育，建立平台分工和周更节奏。",
  }),
  createResult({
    id: "competitor-report-result",
    agentId: "competitor-insight",
    taskId: "competitor-completed",
    filename: "OTC竞品内容机会盘点.md",
    completedAt: "2026-07-24T04:15:00.000Z",
    markdown: "# OTC 竞品内容机会盘点\n\n## 结论\n\n优先补齐场景化内容与合规表达。",
  }),
]);

const newestFirst = (left, right) =>
  new Date(right.updatedAt ?? right.completedAt).getTime() -
  new Date(left.updatedAt ?? left.completedAt).getTime();

export function mergeProjectTasks(staticTasks, dynamicTasks) {
  const merged = new Map(staticTasks.map((task) => [task.id, task]));
  for (const task of dynamicTasks) merged.set(task.id, task);
  return Array.from(merged.values()).toSorted(newestFirst);
}

export function mergeProjectResults(staticResults, dynamicResults) {
  const merged = new Map(staticResults.map((result) => [result.id, result]));
  for (const result of dynamicResults) merged.set(result.id, result);
  return Array.from(merged.values()).toSorted(newestFirst);
}

export function getAgentTasks(agentId, status = "all", tasks = PROJECT_TASKS) {
  return tasks.filter(
    (task) =>
      task.agentId === agentId && (status === "all" || task.status === status),
  ).toSorted(newestFirst);
}

export function getTaskById(taskId, tasks = PROJECT_TASKS) {
  return tasks.find((task) => task.id === taskId);
}

const isSupportedProjectResult = (result) =>
  result.filename.toLowerCase().endsWith(".md") ||
  ["excel", "markdown", "json", "image-directory", "output-directory"]
    .includes(result.kind);

export function isValidProjectResult(result, tasks = PROJECT_TASKS) {
  const sourceTask = getTaskById(result.taskId, tasks);

  return Boolean(
    sourceTask &&
      sourceTask.status === "completed" &&
      sourceTask.agentId === result.agentId &&
      isSupportedProjectResult(result),
  );
}

export function getAgentResults(agentId, results = PROJECT_RESULTS) {
  return results.filter(
    (result) =>
      result.agentId === agentId &&
      isSupportedProjectResult(result),
  ).toSorted(newestFirst);
}

export function getTaskResults(
  taskId,
  results = PROJECT_RESULTS,
  tasks = PROJECT_TASKS,
) {
  return results.filter(
    (result) =>
      result.taskId === taskId && isValidProjectResult(result, tasks),
  ).toSorted(newestFirst);
}
