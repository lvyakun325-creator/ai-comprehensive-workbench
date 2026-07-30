import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MODELS,
  addModel,
  connectionFingerprint,
  getConnectedModels,
  getEnabledModels,
  normalizeModels,
  parseStoredModels,
  removeModel,
  resolveSelectedModelId,
  setDefaultModel,
  setModelEnabled,
} from "../app/lib/model-registry.mjs";

test("migrates the obsolete APINebula placeholder without retaining a stale connection", () => {
  const parsed = parseStoredModels(JSON.stringify([
    {
      id: "openai-gpt-5-6",
      provider: "OpenAI",
      displayName: "gpt-5.6",
      baseUrl: "https://apinebula.ai/v1",
      modelId: "gpt-5.6",
      enabled: true,
      isDefault: true,
      connectionStatus: "connected",
      testedFingerprint:
        "[\"https://apinebula.ai/v1\",\"gpt-5.6\",\"legacy-revision\"]",
    },
  ]));

  assert.deepEqual(parsed[0], {
    id: "openai-gpt-5-6",
    provider: "APINebula",
    displayName: "GPT-5.6 SOL",
    baseUrl: "https://api.yhlxj.ai/v1",
    modelId: "gpt-5.6-sol",
    enabled: true,
    isDefault: true,
    connectionStatus: "changed",
    testedFingerprint: "",
  });
});

test("migrates v1 records with untested connection metadata", () => {
  const v1Model = {
    id: DEFAULT_MODELS[0].id,
    provider: DEFAULT_MODELS[0].provider,
    displayName: DEFAULT_MODELS[0].displayName,
    modelId: DEFAULT_MODELS[0].modelId,
    enabled: DEFAULT_MODELS[0].enabled,
    isDefault: DEFAULT_MODELS[0].isDefault,
  };
  const parsed = parseStoredModels(JSON.stringify([v1Model]));
  assert.deepEqual(
    {
      baseUrl: parsed[0].baseUrl,
      connectionStatus: parsed[0].connectionStatus,
      testedFingerprint: parsed[0].testedFingerprint,
    },
    {
      baseUrl: "",
      connectionStatus: "untested",
      testedFingerprint: "",
    },
  );
});

test("marks a connected model changed when its connection address or model changes", () => {
  const connected = {
    ...DEFAULT_MODELS[0],
    baseUrl: "https://models.example.test/v1",
    modelId: "gpt-tested",
    connectionStatus: "connected",
    testedFingerprint: connectionFingerprint(
      "https://models.example.test/v1",
      "gpt-tested",
      "",
    ),
  };

  assert.equal(
    normalizeModels([{ ...connected, baseUrl: "https://other.example.test/v1" }])[0]
      .connectionStatus,
    "changed",
  );
  assert.equal(
    normalizeModels([{ ...connected, modelId: "gpt-changed" }])[0].connectionStatus,
    "changed",
  );
});

test("keeps an opaque credential revision bound to matching connection metadata", () => {
  const connected = {
    ...DEFAULT_MODELS[0],
    baseUrl: "https://models.example.test/v1",
    modelId: "gpt-tested",
    connectionStatus: "connected",
    testedFingerprint: connectionFingerprint(
      "https://models.example.test/v1",
      "gpt-tested",
      "revision-opaque-7f3a",
    ),
  };

  assert.equal(normalizeModels([connected])[0].connectionStatus, "connected");
  assert.equal(
    normalizeModels([{ ...connected, modelId: "gpt-changed" }])[0].connectionStatus,
    "changed",
  );
});

test("only enabled connected models are available to callers", () => {
  const models = [
    {
      ...DEFAULT_MODELS[0],
      baseUrl: "https://models.example.test/v1",
      connectionStatus: "connected",
      testedFingerprint: connectionFingerprint(
        "https://models.example.test/v1",
        DEFAULT_MODELS[0].modelId,
        "",
      ),
    },
    {
      id: "untested-model",
      provider: "Anthropic",
      displayName: "Untested",
      modelId: "claude-untested",
      baseUrl: "https://models.example.test/v1",
      enabled: true,
      isDefault: false,
      connectionStatus: "untested",
      testedFingerprint: "",
    },
    {
      id: "disabled-model",
      provider: "Google",
      displayName: "Disabled",
      modelId: "gemini-disabled",
      baseUrl: "https://models.example.test/v1",
      enabled: false,
      isDefault: false,
      connectionStatus: "connected",
      testedFingerprint: connectionFingerprint(
        "https://models.example.test/v1",
        "gemini-disabled",
        "",
      ),
    },
  ];

  assert.deepEqual(getConnectedModels(models).map((model) => model.id), [
    DEFAULT_MODELS[0].id,
  ]);
});

test("only enabled models reach the chat picker", () => {
  const disabled = setModelEnabled(DEFAULT_MODELS, DEFAULT_MODELS[0].id, false);
  assert.deepEqual(getEnabledModels(disabled), []);
  assert.equal(resolveSelectedModelId(disabled, DEFAULT_MODELS[0].id), null);
});

test("adding and defaulting a model keeps exactly one default", () => {
  const added = addModel(DEFAULT_MODELS, {
    provider: "Anthropic",
    displayName: "Claude Sonnet",
    modelId: "claude-sonnet",
    enabled: true,
    isDefault: false,
  });
  const selected = setDefaultModel(added, added.at(-1).id);
  assert.equal(selected.filter((model) => model.isDefault).length, 1);
  assert.equal(resolveSelectedModelId(selected, null), added.at(-1).id);
});

test("removing the selected model falls back to an enabled default", () => {
  const remaining = removeModel(DEFAULT_MODELS, DEFAULT_MODELS[0].id);
  assert.equal(resolveSelectedModelId(remaining, DEFAULT_MODELS[0].id), null);
});

test("stored data rejects credential-shaped fields", () => {
  const raw = JSON.stringify([{ ...DEFAULT_MODELS[0], apiKey: "secret" }]);
  assert.deepEqual(parseStoredModels(raw), DEFAULT_MODELS);
});

test("stored data with blank required fields falls back to defaults", () => {
  const raw = JSON.stringify([{ ...DEFAULT_MODELS[0], provider: "   " }]);
  assert.deepEqual(parseStoredModels(raw), DEFAULT_MODELS);
});

test("normalizes trim, duplicate, disabled, and default invariants", () => {
  const added = addModel(DEFAULT_MODELS, {
    provider: "  Anthropic  ",
    displayName: "  Claude Sonnet  ",
    modelId: "  claude-sonnet  ",
    enabled: false,
    isDefault: true,
  });
  const model = added.at(-1);

  assert.deepEqual(model, {
    id: model.id,
    provider: "Anthropic",
    displayName: "Claude Sonnet",
    modelId: "claude-sonnet",
    baseUrl: "",
    enabled: false,
    isDefault: false,
    connectionStatus: "untested",
    testedFingerprint: "",
  });
  assert.equal(
    addModel(added, { ...model, id: undefined }).length,
    added.length,
  );
});

test("stored models promote the first enabled model when no default is enabled", () => {
  const stored = JSON.stringify([
    { ...DEFAULT_MODELS[0], enabled: true, isDefault: false },
    {
      id: "secondary",
      provider: "Anthropic",
      displayName: "Claude Sonnet",
      modelId: "claude-sonnet",
      enabled: true,
      isDefault: false,
    },
  ]);

  const parsed = parseStoredModels(stored);
  assert.equal(parsed[0].isDefault, true);
  assert.equal(parsed[1].isDefault, false);
});
