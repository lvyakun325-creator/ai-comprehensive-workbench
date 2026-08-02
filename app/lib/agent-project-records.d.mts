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
  platformId?: string;
  platformLabel?: string;
  skillId?: string;
  sourceUrl?: string;
  artifactIds?: readonly string[];
  inputKind?: "unknown" | "account" | "content";
  category?: ProjectBundleCategory | null;
  bundleId?: string | null;
};

import type { CompetitorBundleCategory } from "./competitor-platform-router.mjs";

export type ProjectBundleStatus = "ready" | "missing" | "legacy";
export type ProjectBundleCategory = CompetitorBundleCategory;

export type ProjectBundle = {
  id: string;
  agentId: string;
  taskId: string;
  platformId: string;
  platformLabel: string;
  inputKind: "unknown" | "account" | "content";
  category: ProjectBundleCategory | null;
  title: string;
  subjectName: string;
  sourceUrl: string;
  status: ProjectBundleStatus;
  primaryArtifactId: string | null;
  manifestPath: string | null;
  archivePath: string | null;
  rootDirectory: string;
  artifactIds: readonly string[];
  itemCount: number;
  createdAt: string;
  completedAt: string;
};

export type ProjectResultKind =
  | "excel"
  | "markdown"
  | "json"
  | "image-directory"
  | "output-directory";

export type ProjectResult = {
  id: string;
  agentId: string;
  taskId: string;
  filename: string;
  completedAt: string;
  sizeBytes: number;
  markdown: string | null;
  kind?: ProjectResultKind;
  absolutePath?: string;
  exists?: boolean;
  isDirectory?: boolean;
  previewable?: boolean;
};

export const TASK_STATUSES: readonly TaskStatus[];
export const PROJECT_TASKS: readonly ProjectTask[];
export const PROJECT_RESULTS: readonly ProjectResult[];
export function getAgentTasks(
  agentId: string,
  status?: TaskStatusFilter,
  tasks?: readonly ProjectTask[],
): readonly ProjectTask[];
export function getTaskById(
  taskId: string,
  tasks?: readonly ProjectTask[],
): ProjectTask | undefined;
export function isValidProjectResult(
  result: ProjectResult,
  tasks?: readonly ProjectTask[],
): boolean;
export function getAgentResults(
  agentId: string,
  results?: readonly ProjectResult[],
): readonly ProjectResult[];
export function getTaskResults(
  taskId: string,
  results?: readonly ProjectResult[],
  tasks?: readonly ProjectTask[],
): readonly ProjectResult[];
export function mergeProjectTasks(
  staticTasks: readonly ProjectTask[],
  dynamicTasks: readonly ProjectTask[],
): readonly ProjectTask[];
export function mergeProjectResults(
  staticResults: readonly ProjectResult[],
  dynamicResults: readonly ProjectResult[],
): readonly ProjectResult[];
export function isValidProjectBundle(
  bundle: ProjectBundle,
  tasks?: readonly ProjectTask[],
): boolean;
export function mergeProjectBundles(
  staticBundles: readonly ProjectBundle[],
  dynamicBundles: readonly ProjectBundle[],
  tasks?: readonly ProjectTask[],
): readonly ProjectBundle[];
export function getAgentBundles(
  agentId: string,
  bundles?: readonly ProjectBundle[],
  tasks?: readonly ProjectTask[],
): readonly ProjectBundle[];
export function getTaskBundle(
  taskId: string,
  bundles?: readonly ProjectBundle[],
  tasks?: readonly ProjectTask[],
): ProjectBundle | undefined;
export function getBundleArtifacts(
  bundleId: string,
  bundles?: readonly ProjectBundle[],
  artifacts?: readonly ProjectResult[],
): readonly ProjectResult[];
