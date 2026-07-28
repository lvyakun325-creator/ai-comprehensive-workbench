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
const CHAT_SELECTION_STORAGE_KEY = "ai-workbench:chat-model-selection:v1";
const AGENT_SELECTIONS_STORAGE_KEY = "ai-workbench:agent-model-selections:v1";
const ADDED_MODEL_ID = "anthropic-claude-test";
const SECOND_MODEL_ID = "google-gemini-test";
const AGENT_A_ID = "competitor-insight";
const AGENT_B_ID = "topic-planning";

function RegistryHarness() {
  const {
    models,
    chatSelectedModel,
    chatSelectedModelId,
    addModel,
    getAgentSelectedModelId,
    removeModel,
    setAgentSelectedModelId,
    setChatSelectedModelId,
    setModelEnabled,
  } = useModelRegistry();

  return (
    <section>
      <output aria-label="聊天已选模型">{chatSelectedModel?.id ?? "none"}</output>
      <output aria-label="聊天已选模型 ID">{chatSelectedModelId ?? "none"}</output>
      <output aria-label="Agent A 已选模型">
        {getAgentSelectedModelId(AGENT_A_ID) ?? "none"}
      </output>
      <output aria-label="Agent B 已选模型">
        {getAgentSelectedModelId(AGENT_B_ID) ?? "none"}
      </output>
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
      <button
        onClick={() =>
          addModel({
            id: SECOND_MODEL_ID,
            provider: "Google",
            displayName: "Gemini Test",
            modelId: "gemini-test",
            enabled: true,
            isDefault: false,
          })
        }
      >
        添加第二模型
      </button>
      <button onClick={() => setChatSelectedModelId(ADDED_MODEL_ID)}>
        聊天选择新增模型
      </button>
      <button onClick={() => setAgentSelectedModelId(AGENT_A_ID, SECOND_MODEL_ID)}>
        Agent A 选择第二模型
      </button>
      <button onClick={() => setAgentSelectedModelId(AGENT_B_ID, ADDED_MODEL_ID)}>
        Agent B 选择新增模型
      </button>
      <button onClick={() => setModelEnabled(ADDED_MODEL_ID, false)}>停用新增模型</button>
      <button onClick={() => removeModel(SECOND_MODEL_ID)}>删除第二模型</button>
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
    assert.equal(screen.getByLabelText("聊天已选模型").textContent, "openai-gpt-5-6");
  });
  await user.click(screen.getByRole("button", { name: "添加模型" }));
  await user.click(screen.getByRole("button", { name: "聊天选择新增模型" }));
  assert.equal(screen.getByLabelText("聊天已选模型").textContent, ADDED_MODEL_ID);

  firstRender.unmount();
  render(
    <ModelRegistryProvider>
      <RegistryHarness />
    </ModelRegistryProvider>,
  );

  await waitFor(() => {
    assert.equal(screen.getByLabelText("模型数量").textContent, "2");
  });
  assert.equal(screen.getByLabelText("聊天已选模型").textContent, ADDED_MODEL_ID);

  await user.click(screen.getByRole("button", { name: "停用新增模型" }));
  assert.equal(screen.getByLabelText("聊天已选模型").textContent, "openai-gpt-5-6");
  assert.equal(screen.getByLabelText("聊天已选模型 ID").textContent, "openai-gpt-5-6");
  assert.ok(window.localStorage.getItem(STORAGE_KEY)?.includes(ADDED_MODEL_ID));
});

test("hydrates the enabled stored default instead of keeping the demo selection", async () => {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify([
      {
        id: "openai-gpt-5-6",
        provider: "OpenAI",
        displayName: "GPT-5.6",
        modelId: "gpt-5.6",
        enabled: true,
        isDefault: false,
      },
      {
        id: "anthropic-claude-stored",
        provider: "Anthropic",
        displayName: "Claude Stored",
        modelId: "claude-stored",
        enabled: true,
        isDefault: true,
      },
    ]),
  );

  render(
    <ModelRegistryProvider>
      <RegistryHarness />
    </ModelRegistryProvider>,
  );

  await waitFor(() => {
    assert.equal(
      screen.getByLabelText("聊天已选模型").textContent,
      "anthropic-claude-stored",
    );
  });
  assert.equal(
    screen.getByLabelText("聊天已选模型 ID").textContent,
    "anthropic-claude-stored",
  );
});

test("persists independent chat and per-Agent selections and reconciles each fallback", async () => {
  const user = userEvent.setup({ document });
  const firstRender = render(
    <ModelRegistryProvider>
      <RegistryHarness />
    </ModelRegistryProvider>,
  );

  await waitFor(() => {
    assert.equal(
      screen.getByLabelText("聊天已选模型 ID").textContent,
      "openai-gpt-5-6",
    );
  });
  await user.click(screen.getByRole("button", { name: "添加模型" }));
  await user.click(screen.getByRole("button", { name: "添加第二模型" }));
  await user.click(screen.getByRole("button", { name: "聊天选择新增模型" }));
  await user.click(screen.getByRole("button", { name: "Agent A 选择第二模型" }));
  await user.click(screen.getByRole("button", { name: "Agent B 选择新增模型" }));

  assert.equal(screen.getByLabelText("聊天已选模型 ID").textContent, ADDED_MODEL_ID);
  assert.equal(screen.getByLabelText("Agent A 已选模型").textContent, SECOND_MODEL_ID);
  assert.equal(screen.getByLabelText("Agent B 已选模型").textContent, ADDED_MODEL_ID);

  await waitFor(() => {
    assert.equal(window.localStorage.getItem(CHAT_SELECTION_STORAGE_KEY), ADDED_MODEL_ID);
    assert.deepEqual(
      JSON.parse(window.localStorage.getItem(AGENT_SELECTIONS_STORAGE_KEY) ?? "null"),
      {
        [AGENT_A_ID]: SECOND_MODEL_ID,
        [AGENT_B_ID]: ADDED_MODEL_ID,
      },
    );
  });
  const storedAgentSelections =
    window.localStorage.getItem(AGENT_SELECTIONS_STORAGE_KEY) ?? "";
  assert.doesNotMatch(
    storedAgentSelections,
    /content-matrix|chat|provider|displayName|endpoint|header|api.?key|token|password|credential/i,
  );

  firstRender.unmount();
  render(
    <ModelRegistryProvider>
      <RegistryHarness />
    </ModelRegistryProvider>,
  );

  await waitFor(() => {
    assert.equal(screen.getByLabelText("聊天已选模型 ID").textContent, ADDED_MODEL_ID);
    assert.equal(screen.getByLabelText("Agent A 已选模型").textContent, SECOND_MODEL_ID);
    assert.equal(screen.getByLabelText("Agent B 已选模型").textContent, ADDED_MODEL_ID);
  });

  await user.click(screen.getByRole("button", { name: "停用新增模型" }));
  assert.equal(
    screen.getByLabelText("聊天已选模型 ID").textContent,
    "openai-gpt-5-6",
  );
  assert.equal(screen.getByLabelText("Agent A 已选模型").textContent, SECOND_MODEL_ID);
  assert.equal(
    screen.getByLabelText("Agent B 已选模型").textContent,
    "openai-gpt-5-6",
  );

  await user.click(screen.getByRole("button", { name: "删除第二模型" }));
  assert.equal(
    screen.getByLabelText("Agent A 已选模型").textContent,
    "openai-gpt-5-6",
  );
});
