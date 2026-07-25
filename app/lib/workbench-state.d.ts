export type WorkbenchView =
  | "control"
  | "agents"
  | "tasks"
  | "assets"
  | "analytics"
  | "models"
  | "settings";

export type WorkbenchState = {
  view: WorkbenchView | "agent";
  activeAgentId: string | null;
};

export type ProjectAccess = {
  ownerAgentId: string;
  visibility: "private" | "public-readonly";
};

export const WORKBENCH_VIEWS: readonly WorkbenchView[];
export function createInitialState(): WorkbenchState;
export function navigateTo(
  state: WorkbenchState,
  view: WorkbenchView,
): WorkbenchState;
export function openAgent(
  state: WorkbenchState,
  agentId: string,
): WorkbenchState;
export function canAgentAccessProject(
  agentId: string,
  project: ProjectAccess,
): boolean;
export function scheduleTasks<T>(
  tasks: readonly T[],
  concurrency?: number,
): { running: T[]; queued: T[] };
export function createHandoffPreview(
  sourceAgentId: string,
  targetAgentId: string,
  artifactId: string,
): {
  sourceAgentId: string;
  targetAgentId: string;
  artifactId: string;
  access: "readonly-copy";
  confirmed: false;
};
