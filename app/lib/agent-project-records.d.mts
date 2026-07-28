export type TaskStatus =
  | "waiting"
  | "running"
  | "completed"
  | "stopped"
  | "failed";
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
  markdown: string | null;
};

export const TASK_STATUSES: readonly TaskStatus[];
export const PROJECT_TASKS: readonly ProjectTask[];
export const PROJECT_RESULTS: readonly ProjectResult[];
export function getAgentTasks(
  agentId: string,
  status?: TaskStatusFilter,
): readonly ProjectTask[];
export function getTaskById(taskId: string): ProjectTask | undefined;
export function isValidProjectResult(result: ProjectResult): boolean;
export function getAgentResults(
  agentId: string,
  results?: readonly ProjectResult[],
): readonly ProjectResult[];
export function getTaskResults(taskId: string): readonly ProjectResult[];
