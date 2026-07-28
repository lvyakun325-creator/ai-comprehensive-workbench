export type ChatModel = {
  id: string;
  provider: string;
  displayName: string;
  modelId: string;
  enabled: boolean;
  isDefault: boolean;
};

export type ModelDraft = Omit<ChatModel, "id"> & { id?: string };

export const DEFAULT_MODELS: readonly ChatModel[];
export function normalizeModels(models: unknown): ChatModel[];
export function addModel(models: unknown, draft: Partial<ModelDraft>): ChatModel[];
export function setModelEnabled(models: unknown, id: string, enabled: boolean): ChatModel[];
export function setDefaultModel(models: unknown, id: string): ChatModel[];
export function removeModel(models: unknown, id: string): ChatModel[];
export function getEnabledModels(models: unknown): ChatModel[];
export function resolveSelectedModelId(models: unknown, selectedId: string | null | undefined): string | null;
export function parseStoredModels(raw: string): ChatModel[];
