import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MODELS,
  addModel,
  getEnabledModels,
  parseStoredModels,
  removeModel,
  resolveSelectedModelId,
  setDefaultModel,
  setModelEnabled,
} from "../app/lib/model-registry.mjs";

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
    enabled: false,
    isDefault: false,
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
