import {
  normalizeTaskConcurrency,
  scheduleTasks,
} from "./workbench-state.mjs";

export const PREVIEW_TASKS = Object.freeze([
  {
    id: "task-01",
    agentId: "content-matrix",
    title: "规划本月内容矩阵",
    status: "running",
  },
  {
    id: "task-02",
    agentId: "competitor-insight",
    title: "拆解竞品内容路径",
    status: "running",
  },
  {
    id: "task-03",
    agentId: "topic-planning",
    title: "整理选题优先级",
    status: "running",
  },
  {
    id: "task-04",
    agentId: "title-planning",
    title: "生成标题方向",
    status: "queued",
  },
  {
    id: "task-05",
    agentId: "media-article",
    title: "准备图文内容包",
    status: "queued",
  },
]);

export function createTaskSchedulePreview(tasks, concurrency = 3) {
  const schedule = scheduleTasks(tasks, concurrency);
  const runningCount = schedule.running.length;
  const queuedCount = schedule.queued.length;
  const maxConcurrency = normalizeTaskConcurrency(concurrency);

  return {
    ...schedule,
    runningCount,
    queuedCount,
    summaryLabel: `运行中 ${runningCount} · 排队中 ${queuedCount}`,
    capacityLabel: `运行中 ${runningCount} · 排队中 ${queuedCount} · 最大并发 ${maxConcurrency}`,
  };
}

export const PREVIEW_TASK_SCHEDULE = Object.freeze(
  createTaskSchedulePreview(PREVIEW_TASKS, 3),
);
