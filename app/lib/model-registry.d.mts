export type ChatModel = {
  id: string;
  provider: string;
  displayName: string;
  modelId: string;
  baseUrl: string;
  enabled: boolean;
  isDefault: boolean;
  connectionStatus: "untested" | "testing" | "connected" | "failed" | "changed";
  testedFingerprint: string;
};

export type ModelDraft = Omit<ChatModel, "id"> & { id?: string };

export const DEFAULT_MODELS: readonly ChatModel[];
export function normalizeModels(models: unknown): ChatModel[];
export function addModel(models: unknown, draft: Partial<ModelDraft>): ChatModel[];
export function setModelEnabled(models: unknown, id: string, enabled: boolean): ChatModel[];
export function setDefaultModel(models: unknown, id: string): ChatModel[];
export function removeModel(models: unknown, id: string): ChatModel[];
export function getEnabledModels(models: unknown): ChatModel[];
export function getConnectedModels(models: unknown): ChatModel[];
export function connectionFingerprint(baseUrl: unknown, modelId: unknown, keyRevision: unknown): string;
export function resolveSelectedModelId(models: unknown, selectedId: string | null | undefined): string | null;
export function parseStoredModels(raw: string): ChatModel[];
