export type PreviewTaskStatus =
  | "running"
  | "queued"
  | "approval"
  | "completed"
  | "failed"
  | "paused";

export type PreviewTask = {
  id: string;
  agentId: string;
  title: string;
  status: PreviewTaskStatus;
};

export type TaskSchedulePreview<T> = {
  running: T[];
  queued: T[];
  runningCount: number;
  queuedCount: number;
  summaryLabel: string;
  capacityLabel: string;
};

export const PREVIEW_TASKS: readonly PreviewTask[];
export const PREVIEW_TASK_SCHEDULE: Readonly<
  TaskSchedulePreview<PreviewTask>
>;
export function createTaskSchedulePreview<T>(
  tasks: readonly T[],
  concurrency?: number,
): TaskSchedulePreview<T>;
