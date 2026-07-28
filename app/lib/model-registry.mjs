const CREDENTIAL_KEY_PATTERN = /api.?key|token|password|credential/i;

const DEFAULT_MODEL_LIST = [
  {
    id: "openai-gpt-5-6",
    provider: "OpenAI",
    displayName: "GPT-5.6",
    modelId: "gpt-5.6",
    enabled: true,
    isDefault: true,
  },
];

export const DEFAULT_MODELS = Object.freeze(
  DEFAULT_MODEL_LIST.map((model) => Object.freeze(model)),
);

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isModel(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.id === "string" &&
    typeof value.provider === "string" &&
    typeof value.displayName === "string" &&
    typeof value.modelId === "string" &&
    typeof value.enabled === "boolean" &&
    typeof value.isDefault === "boolean"
  );
}

function normalizeModel(value) {
  if (!isModel(value)) return null;

  const model = {
    id: text(value.id),
    provider: text(value.provider),
    displayName: text(value.displayName),
    modelId: text(value.modelId),
    enabled: value.enabled,
    isDefault: value.enabled && value.isDefault,
  };

  return model.id && model.provider && model.displayName && model.modelId
    ? model
    : null;
}

function providerModelKey(model) {
  return `${model.provider.toLocaleLowerCase()}\u0000${model.modelId.toLocaleLowerCase()}`;
}

function ensureDefault(models) {
  const defaultModel = models.find((model) => model.enabled && model.isDefault);
  const defaultId = defaultModel?.id ?? models.find((model) => model.enabled)?.id;

  return models.map((model) => ({
    ...model,
    isDefault: model.enabled && model.id === defaultId,
  }));
}

export function normalizeModels(models) {
  if (!Array.isArray(models)) return [];

  const ids = new Set();
  const providerModels = new Set();
  const normalized = [];

  for (const candidate of models) {
    const model = normalizeModel(candidate);
    if (!model || ids.has(model.id) || providerModels.has(providerModelKey(model))) continue;
    ids.add(model.id);
    providerModels.add(providerModelKey(model));
    normalized.push(model);
  }

  return ensureDefault(normalized);
}

function createId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `model-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function addModel(models, draft) {
  const normalized = normalizeModels(models);
  const provider = text(draft?.provider);
  const displayName = text(draft?.displayName);
  const modelId = text(draft?.modelId);

  if (!provider || !displayName || !modelId) return normalized;
  const duplicate = normalized.some(
    (model) => providerModelKey(model) === providerModelKey({ provider, modelId }),
  );
  if (duplicate) return normalized;

  const id = text(draft?.id) || createId();
  if (normalized.some((model) => model.id === id)) return normalized;

  return normalizeModels([
    ...normalized,
    {
      id,
      provider,
      displayName,
      modelId,
      enabled: draft?.enabled === true,
      isDefault: draft?.enabled === true && draft?.isDefault === true,
    },
  ]);
}

export function setModelEnabled(models, id, enabled) {
  const modelId = text(id);
  return normalizeModels(
    normalizeModels(models).map((model) =>
      model.id === modelId
        ? { ...model, enabled: enabled === true, isDefault: enabled === true && model.isDefault }
        : model,
    ),
  );
}

export function setDefaultModel(models, id) {
  const modelId = text(id);
  const normalized = normalizeModels(models);
  if (!normalized.some((model) => model.id === modelId && model.enabled)) return normalized;

  return normalized.map((model) => ({
    ...model,
    isDefault: model.enabled && model.id === modelId,
  }));
}

export function removeModel(models, id) {
  const modelId = text(id);
  return normalizeModels(normalizeModels(models).filter((model) => model.id !== modelId));
}

export function getEnabledModels(models) {
  return normalizeModels(models).filter((model) => model.enabled);
}

export function resolveSelectedModelId(models, selectedId) {
  const enabled = getEnabledModels(models);
  const requestedId = text(selectedId);
  if (enabled.some((model) => model.id === requestedId)) return requestedId;
  return enabled.find((model) => model.isDefault)?.id ?? null;
}

function hasCredentialKey(value) {
  if (!value || typeof value !== "object") return false;

  return Object.entries(value).some(
    ([key, child]) => CREDENTIAL_KEY_PATTERN.test(key) || hasCredentialKey(child),
  );
}

export function parseStoredModels(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_MODELS;
  }

  if (!Array.isArray(parsed) || parsed.some((model) => !isModel(model) || hasCredentialKey(model))) {
    return DEFAULT_MODELS;
  }

  const normalized = normalizeModels(parsed);
  return normalized.length === parsed.length ? normalized : DEFAULT_MODELS;
}
