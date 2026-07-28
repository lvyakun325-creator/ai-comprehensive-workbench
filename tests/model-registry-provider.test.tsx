import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
});

Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  Node: { configurable: true, value: dom.window.Node },
  MutationObserver: { configurable: true, value: dom.window.MutationObserver },
  getComputedStyle: {
    configurable: true,
    value: dom.window.getComputedStyle.bind(dom.window),
  },
  IS_REACT_ACT_ENVIRONMENT: {
    configurable: true,
    value: true,
    writable: true,
  },
});

const { cleanup, render, screen, waitFor } = await import("@testing-library/react");
const { default: userEvent } = await import("@testing-library/user-event");
const { ModelRegistryProvider, useModelRegistry } = await import(
  "../app/components/ModelRegistryProvider"
);

const STORAGE_KEY = "ai-workbench:model-registry:v1";
const ADDED_MODEL_ID = "anthropic-claude-test";

function RegistryHarness() {
  const {
    models,
    selectedModel,
    selectedModelId,
    addModel,
    setModelEnabled,
    setSelectedModelId,
  } = useModelRegistry();

  return (
    <section>
      <output aria-label="已选模型">{selectedModel?.id ?? "none"}</output>
      <output aria-label="已选模型 ID">{selectedModelId ?? "none"}</output>
      <output aria-label="模型数量">{models.length}</output>
      <button
        onClick={() =>
          addModel({
            id: ADDED_MODEL_ID,
            provider: "Anthropic",
            displayName: "Claude Test",
            modelId: "claude-test",
            enabled: true,
            isDefault: false,
          })
        }
      >
        添加模型
      </button>
      <button onClick={() => setSelectedModelId(ADDED_MODEL_ID)}>选择新增模型</button>
      <button onClick={() => setModelEnabled(ADDED_MODEL_ID, false)}>停用新增模型</button>
    </section>
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.body.innerHTML = "";
});

test("persists added models and falls back when the selected model is disabled", async () => {
  const user = userEvent.setup({ document });
  const firstRender = render(
    <ModelRegistryProvider>
      <RegistryHarness />
    </ModelRegistryProvider>,
  );

  await waitFor(() => {
    assert.equal(screen.getByLabelText("已选模型").textContent, "openai-gpt-5-6");
  });
  await user.click(screen.getByRole("button", { name: "添加模型" }));
  await user.click(screen.getByRole("button", { name: "选择新增模型" }));
  assert.equal(screen.getByLabelText("已选模型").textContent, ADDED_MODEL_ID);

  firstRender.unmount();
  render(
    <ModelRegistryProvider>
      <RegistryHarness />
    </ModelRegistryProvider>,
  );

  await waitFor(() => {
    assert.equal(screen.getByLabelText("模型数量").textContent, "2");
  });
  await user.click(screen.getByRole("button", { name: "选择新增模型" }));
  assert.equal(screen.getByLabelText("已选模型").textContent, ADDED_MODEL_ID);

  await user.click(screen.getByRole("button", { name: "停用新增模型" }));
  assert.equal(screen.getByLabelText("已选模型").textContent, "openai-gpt-5-6");
  assert.equal(screen.getByLabelText("已选模型 ID").textContent, "openai-gpt-5-6");
  assert.ok(window.localStorage.getItem(STORAGE_KEY)?.includes(ADDED_MODEL_ID));
});
