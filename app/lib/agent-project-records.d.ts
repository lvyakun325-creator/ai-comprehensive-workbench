export type TaskStatus = "running" | "completed" | "stopped" | "failed";
export type TaskStatusFilter = TaskStatus | "all";

export type ProjectTask = {
  id: string;
  agentId: string;
  title: string;
  status: TaskStatus;
  progress: number;
  currentStep: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  stoppedAt: string | null;
  errorSummary: string | null;
};

export type ProjectResult = {
  id: string;
  agentId: string;
  taskId: string;
  filename: string;
  completedAt: string;
  sizeBytes: number;
  markdown: string;
};

export const TASK_STATUSES: readonly TaskStatus[];
export const PROJECT_TASKS: readonly ProjectTask[];
export const PROJECT_RESULTS: readonly ProjectResult[];
export function getAgentTasks(
  agentId: string,
  status?: TaskStatusFilter,
): readonly ProjectTask[];
export function getAgentResults(agentId: string): readonly ProjectResult[];
export function getTaskResults(taskId: string): readonly ProjectResult[];
