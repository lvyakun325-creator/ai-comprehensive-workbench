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

const STORAGE_KEY = "ai-workbench:model-registry:v2";
const LEGACY_MODEL_STORAGE_KEY = "ai-workbench:model-registry:v1";
const CREDENTIAL_STORAGE_KEY = "ai-workbench:model-credentials:v1";
const CREDENTIAL_REVISION_STORAGE_KEY = "ai-workbench:model-credential-revisions:v1";
const IMAGE_CONFIG_STORAGE_KEY = "ai-workbench:image-model-config:v1";
const IMAGE_CREDENTIAL_STORAGE_KEY = "ai-workbench:image-model-credential:v1";
const IMAGE_CREDENTIAL_REVISION_STORAGE_KEY =
  "ai-workbench:image-model-credential-revision:v1";
const CHAT_SELECTION_STORAGE_KEY = "ai-workbench:chat-model-selection:v1";
const AGENT_SELECTIONS_STORAGE_KEY = "ai-workbench:agent-model-selections:v1";
const ADDED_MODEL_ID = "anthropic-claude-test";
const SECOND_MODEL_ID = "google-gemini-test";
const AGENT_A_ID = "competitor-insight";
const AGENT_B_ID = "topic-planning";

function RegistryHarness() {
  const registry = useModelRegistry();
  const {
    models,
    enabledModels,
    chatSelectedModel,
    chatSelectedModelId,
    connectedModels,
    addModel,
    getCredential,
    getMaskedCredential,
    getAgentSelectedModelId,
    removeModel,
    setAgentSelectedModelId,
    setChatSelectedModelId,
    setModelEnabled,
    saveCredential,
    saveModelConfig,
    imageConfig,
    imageCredential,
    saveImageConfig,
    saveImageCredential,
  } = registry;
  const getCredentialRevision =
    "getCredentialRevision" in registry
    && typeof registry.getCredentialRevision === "function"
      ? registry.getCredentialRevision as (id: string) => string
      : () => "missing";
  const imageCredentialRevision =
    "imageCredentialRevision" in registry
      ? String(registry.imageCredentialRevision)
      : "missing";

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
      <output aria-label="已连接模型数量">{connectedModels.length}</output>
      <output aria-label="可选择模型数量">{enabledModels.length}</output>
      <output aria-label="默认模型密钥">
        {getCredential("openai-gpt-5-6") ?? "none"}
      </output>
      <output aria-label="默认模型脱敏密钥">
        {getMaskedCredential("openai-gpt-5-6") ?? "none"}
      </output>
      <output aria-label="默认模型密钥版本">
        {getCredentialRevision("openai-gpt-5-6") || "none"}
      </output>
      <output aria-label="默认模型配置">
        {JSON.stringify(models.find((model) => model.id === "openai-gpt-5-6") ?? null)}
      </output>
      <output aria-label="生图配置">{JSON.stringify(imageConfig)}</output>
      <output aria-label="生图密钥">{imageCredential ?? "none"}</output>
      <output aria-label="生图密钥版本">{imageCredentialRevision || "none"}</output>
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
      <button onClick={() => saveCredential("openai-gpt-5-6", "sk-fake-first-1234", false)}>
        保存第一密钥
      </button>
      <button onClick={() => saveCredential("openai-gpt-5-6", "", false)}>
        保留第一密钥
      </button>
      <button onClick={() => saveCredential("openai-gpt-5-6", "  sk-fake-second-5678  ", false)}>
        替换第一密钥
      </button>
      <button onClick={() => saveCredential("openai-gpt-5-6", "", true)}>
        清空第一密钥
      </button>
      <button
        onClick={() =>
          saveModelConfig("openai-gpt-5-6", {
            baseUrl: " https://changed-models.example.test/v1 ",
            modelId: " gpt-changed ",
          })
        }
      >
        保存已变更模型配置
      </button>
      <button
        onClick={() =>
          saveModelConfig("openai-gpt-5-6", {
            connectionStatus: "connected",
            testedFingerprint: JSON.stringify([
              "https://changed-models.example.test/v1",
              "gpt-changed",
              getCredentialRevision("openai-gpt-5-6"),
            ]),
          })
        }
      >
        保存模型测试结果
      </button>
      <button
        onClick={() =>
          saveModelConfig("openai-gpt-5-6", {
            connectionStatus: "connected",
            testedFingerprint:
              "[\"https://models.example.test/v1\",\"gpt-5.6\",\"revision-stale\"]",
          })
        }
      >
        保存过期模型测试结果
      </button>
      <button
        onClick={() =>
          saveImageConfig({
            baseUrl: " https://images.example.test/v1 ",
            modelId: " image-test ",
            enabled: true,
          })
        }
      >
        保存生图配置
      </button>
      <button onClick={() => saveImageCredential("sk-image-fake-4321", false)}>
        保存生图密钥
      </button>
      <button
        onClick={() =>
          saveImageConfig({
            connectionStatus: "connected",
            testedFingerprint:
              "[\"https://images.example.test/v1\",\"image-model\",\"revision-stale\"]",
          })
        }
      >
        保存过期生图测试结果
      </button>
    </section>
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.body.innerHTML = "";
});

test("keeps text and image credentials outside ordinary model metadata", async () => {
  const user = userEvent.setup({ document });
  render(
    <ModelRegistryProvider>
      <RegistryHarness />
    </ModelRegistryProvider>,
  );

  await waitFor(() => {
    assert.equal(screen.getByLabelText("已连接模型数量").textContent, "0");
    assert.equal(screen.getByLabelText("可选择模型数量").textContent, "0");
  });

  await user.click(screen.getByRole("button", { name: "保存第一密钥" }));
  await waitFor(() => {
    assert.equal(screen.getByLabelText("默认模型密钥").textContent, "sk-fake-first-1234");
  });
  await user.click(screen.getByRole("button", { name: "保留第一密钥" }));
  assert.equal(screen.getByLabelText("默认模型密钥").textContent, "sk-fake-first-1234");
  await user.click(screen.getByRole("button", { name: "替换第一密钥" }));
  await waitFor(() => {
    assert.equal(screen.getByLabelText("默认模型密钥").textContent, "sk-fake-second-5678");
  });
  assert.match(screen.getByLabelText("默认模型脱敏密钥").textContent ?? "", /^sk-/);
  assert.doesNotMatch(
    screen.getByLabelText("默认模型脱敏密钥").textContent ?? "",
    /fake-second/,
  );
  assert.doesNotMatch(
    window.localStorage.getItem(STORAGE_KEY) ?? "",
    /sk-fake-(first|second)/,
  );
  assert.match(window.localStorage.getItem(CREDENTIAL_STORAGE_KEY) ?? "", /sk-fake-second-5678/);

  await user.click(screen.getByRole("button", { name: "清空第一密钥" }));
  await waitFor(() => {
    assert.equal(screen.getByLabelText("默认模型密钥").textContent, "none");
  });
  assert.deepEqual(
    JSON.parse(window.localStorage.getItem(CREDENTIAL_STORAGE_KEY) ?? "null"),
    {},
  );

  await user.click(screen.getByRole("button", { name: "保存生图配置" }));
  await user.click(screen.getByRole("button", { name: "保存生图密钥" }));
  await waitFor(() => {
    assert.match(window.localStorage.getItem(IMAGE_CONFIG_STORAGE_KEY) ?? "", /image-test/);
    assert.equal(window.localStorage.getItem(IMAGE_CREDENTIAL_STORAGE_KEY), "sk-image-fake-4321");
  });
  assert.doesNotMatch(window.localStorage.getItem(IMAGE_CONFIG_STORAGE_KEY) ?? "", /sk-image/);
  assert.doesNotMatch(window.localStorage.getItem(STORAGE_KEY) ?? "", /sk-image/);
});

test("persists opaque credential revisions and changes them only for replacement or clear", async () => {
  const user = userEvent.setup({ document });
  const firstRender = render(
    <ModelRegistryProvider>
      <RegistryHarness />
    </ModelRegistryProvider>,
  );

  await user.click(screen.getByRole("button", { name: "保存第一密钥" }));
  const firstRevision = screen.getByLabelText("默认模型密钥版本").textContent ?? "";
  assert.notEqual(firstRevision, "missing");
  assert.notEqual(firstRevision, "none");
  assert.doesNotMatch(firstRevision, /fake|first|1234|sk-/i);

  await user.click(screen.getByRole("button", { name: "保留第一密钥" }));
  assert.equal(
    screen.getByLabelText("默认模型密钥版本").textContent,
    firstRevision,
  );

  await user.click(screen.getByRole("button", { name: "替换第一密钥" }));
  const replacementRevision =
    screen.getByLabelText("默认模型密钥版本").textContent ?? "";
  assert.notEqual(replacementRevision, firstRevision);
  assert.doesNotMatch(replacementRevision, /fake|second|5678|sk-/i);

  await user.click(screen.getByRole("button", { name: "清空第一密钥" }));
  const clearedRevision =
    screen.getByLabelText("默认模型密钥版本").textContent ?? "";
  assert.notEqual(clearedRevision, replacementRevision);
  assert.notEqual(clearedRevision, "none");

  await user.click(screen.getByRole("button", { name: "保存生图密钥" }));
  const imageRevision = screen.getByLabelText("生图密钥版本").textContent ?? "";
  assert.notEqual(imageRevision, "missing");
  assert.notEqual(imageRevision, "none");
  assert.doesNotMatch(imageRevision, /image|fake|4321|sk-/i);

  await waitFor(() => {
    assert.equal(
      JSON.parse(
        window.localStorage.getItem(CREDENTIAL_REVISION_STORAGE_KEY) ?? "{}",
      )["openai-gpt-5-6"],
      clearedRevision,
    );
    assert.equal(
      window.localStorage.getItem(IMAGE_CREDENTIAL_REVISION_STORAGE_KEY),
      imageRevision,
    );
  });
  assert.doesNotMatch(
    window.localStorage.getItem(CREDENTIAL_REVISION_STORAGE_KEY) ?? "",
    /sk-fake|first|second|1234|5678/i,
  );

  firstRender.unmount();
  render(
    <ModelRegistryProvider>
      <RegistryHarness />
    </ModelRegistryProvider>,
  );
  await waitFor(() => {
    assert.equal(
      screen.getByLabelText("默认模型密钥版本").textContent,
      clearedRevision,
    );
    assert.equal(
      screen.getByLabelText("生图密钥版本").textContent,
      imageRevision,
    );
  });
});

test("replacing a credential immediately removes a previously connected model from availability", async () => {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify([
      {
        id: "openai-gpt-5-6",
        provider: "OpenAI",
        displayName: "GPT-5.6",
        modelId: "gpt-5.6",
        baseUrl: "https://models.example.test/v1",
        enabled: true,
        isDefault: true,
        connectionStatus: "connected",
        testedFingerprint:
          "[\"https://models.example.test/v1\",\"gpt-5.6\",\"revision-original\"]",
      },
    ]),
  );
  window.localStorage.setItem(
    CREDENTIAL_STORAGE_KEY,
    JSON.stringify({ "openai-gpt-5-6": "sk-original-text" }),
  );
  window.localStorage.setItem(
    CREDENTIAL_REVISION_STORAGE_KEY,
    JSON.stringify({ "openai-gpt-5-6": "revision-original" }),
  );
  const user = userEvent.setup({ document });
  render(
    <ModelRegistryProvider>
      <RegistryHarness />
    </ModelRegistryProvider>,
  );

  await waitFor(() => {
    assert.equal(screen.getByLabelText("已连接模型数量").textContent, "1");
  });
  await user.click(screen.getByRole("button", { name: "替换第一密钥" }));

  await waitFor(() => {
    assert.equal(screen.getByLabelText("已连接模型数量").textContent, "0");
    const model = JSON.parse(
      screen.getByLabelText("默认模型配置").textContent ?? "null",
    );
    assert.equal(model.connectionStatus, "changed");
  });
});

test("rejects a connected text result bound to a stale credential revision", async () => {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify([
      {
        id: "openai-gpt-5-6",
        provider: "OpenAI",
        displayName: "GPT-5.6",
        modelId: "gpt-5.6",
        baseUrl: "https://models.example.test/v1",
        enabled: true,
        isDefault: true,
        connectionStatus: "changed",
        testedFingerprint: "",
      },
    ]),
  );
  window.localStorage.setItem(
    CREDENTIAL_STORAGE_KEY,
    JSON.stringify({ "openai-gpt-5-6": "sk-current-text" }),
  );
  window.localStorage.setItem(
    CREDENTIAL_REVISION_STORAGE_KEY,
    JSON.stringify({ "openai-gpt-5-6": "revision-current" }),
  );
  const user = userEvent.setup({ document });
  render(
    <ModelRegistryProvider>
      <RegistryHarness />
    </ModelRegistryProvider>,
  );

  await user.click(
    screen.getByRole("button", { name: "保存过期模型测试结果" }),
  );

  await waitFor(() => {
    assert.equal(screen.getByLabelText("已连接模型数量").textContent, "0");
    const model = JSON.parse(
      screen.getByLabelText("默认模型配置").textContent ?? "null",
    );
    assert.equal(model.connectionStatus, "changed");
  });
});

test("rejects a connected image result bound to a stale credential revision", async () => {
  window.localStorage.setItem(
    IMAGE_CONFIG_STORAGE_KEY,
    JSON.stringify({
      baseUrl: "https://images.example.test/v1",
      modelId: "image-model",
      enabled: true,
      connectionStatus: "changed",
      testedFingerprint: "",
    }),
  );
  window.localStorage.setItem(
    IMAGE_CREDENTIAL_STORAGE_KEY,
    "sk-current-image",
  );
  window.localStorage.setItem(
    IMAGE_CREDENTIAL_REVISION_STORAGE_KEY,
    "revision-current",
  );
  const user = userEvent.setup({ document });
  render(
    <ModelRegistryProvider>
      <RegistryHarness />
    </ModelRegistryProvider>,
  );

  await user.click(
    screen.getByRole("button", { name: "保存过期生图测试结果" }),
  );

  await waitFor(() => {
    const config = JSON.parse(
      screen.getByLabelText("生图配置").textContent ?? "null",
    );
    assert.equal(config.connectionStatus, "changed");
  });
});

test("downgrades a stored connected text model when its credential revision mismatches", async () => {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify([
      {
        id: "openai-gpt-5-6",
        provider: "OpenAI",
        displayName: "GPT-5.6",
        modelId: "gpt-5.6",
        baseUrl: "https://models.example.test/v1",
        enabled: true,
        isDefault: true,
        connectionStatus: "connected",
        testedFingerprint:
          "[\"https://models.example.test/v1\",\"gpt-5.6\",\"revision-old\"]",
      },
    ]),
  );
  window.localStorage.setItem(
    CREDENTIAL_STORAGE_KEY,
    JSON.stringify({ "openai-gpt-5-6": "sk-current-text" }),
  );
  window.localStorage.setItem(
    CREDENTIAL_REVISION_STORAGE_KEY,
    JSON.stringify({ "openai-gpt-5-6": "revision-current" }),
  );

  render(
    <ModelRegistryProvider>
      <RegistryHarness />
    </ModelRegistryProvider>,
  );

  await waitFor(() => {
    assert.equal(screen.getByLabelText("已连接模型数量").textContent, "0");
    const model = JSON.parse(
      screen.getByLabelText("默认模型配置").textContent ?? "null",
    );
    assert.equal(model.connectionStatus, "changed");
    assert.equal(
      JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]")[0]
        ?.connectionStatus,
      "changed",
    );
  });
});

test("downgrades stored testing metadata without a current credential revision to untested", async () => {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify([
      {
        id: "openai-gpt-5-6",
        provider: "OpenAI",
        displayName: "GPT-5.6",
        modelId: "gpt-5.6",
        baseUrl: "https://models.example.test/v1",
        enabled: true,
        isDefault: true,
        connectionStatus: "testing",
        testedFingerprint: "",
      },
    ]),
  );

  render(
    <ModelRegistryProvider>
      <RegistryHarness />
    </ModelRegistryProvider>,
  );

  await waitFor(() => {
    const model = JSON.parse(
      screen.getByLabelText("默认模型配置").textContent ?? "null",
    );
    assert.equal(model.connectionStatus, "untested");
    assert.equal(
      JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]")[0]
        ?.connectionStatus,
      "untested",
    );
  });
});

test("legacy credential revision migration invalidates its old connected fingerprint", async () => {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify([
      {
        id: "openai-gpt-5-6",
        provider: "OpenAI",
        displayName: "GPT-5.6",
        modelId: "gpt-5.6",
        baseUrl: "https://models.example.test/v1",
        enabled: true,
        isDefault: true,
        connectionStatus: "connected",
        testedFingerprint:
          "[\"https://models.example.test/v1\",\"gpt-5.6\",\"\"]",
      },
    ]),
  );
  window.localStorage.setItem(
    CREDENTIAL_STORAGE_KEY,
    JSON.stringify({ "openai-gpt-5-6": "sk-legacy-text" }),
  );

  render(
    <ModelRegistryProvider>
      <RegistryHarness />
    </ModelRegistryProvider>,
  );

  await waitFor(() => {
    const migratedRevision =
      screen.getByLabelText("默认模型密钥版本").textContent ?? "";
    assert.notEqual(migratedRevision, "none");
    assert.doesNotMatch(migratedRevision, /legacy|sk-/i);
    const model = JSON.parse(
      screen.getByLabelText("默认模型配置").textContent ?? "null",
    );
    assert.equal(model.connectionStatus, "changed");
    assert.equal(screen.getByLabelText("已连接模型数量").textContent, "0");
  });
});

test("downgrades a connected image model when its credential revision mismatches", async () => {
  window.localStorage.setItem(
    IMAGE_CONFIG_STORAGE_KEY,
    JSON.stringify({
      baseUrl: "https://images.example.test/v1",
      modelId: "image-model",
      enabled: true,
      connectionStatus: "connected",
      testedFingerprint:
        "[\"https://images.example.test/v1\",\"image-model\",\"revision-old\"]",
    }),
  );
  window.localStorage.setItem(
    IMAGE_CREDENTIAL_STORAGE_KEY,
    "sk-current-image",
  );
  window.localStorage.setItem(
    IMAGE_CREDENTIAL_REVISION_STORAGE_KEY,
    "revision-current",
  );

  render(
    <ModelRegistryProvider>
      <RegistryHarness />
    </ModelRegistryProvider>,
  );

  await waitFor(() => {
    const config = JSON.parse(
      screen.getByLabelText("生图配置").textContent ?? "null",
    );
    assert.equal(config.connectionStatus, "changed");
    assert.equal(
      JSON.parse(
        window.localStorage.getItem(IMAGE_CONFIG_STORAGE_KEY) ?? "null",
      ).connectionStatus,
      "changed",
    );
  });
});

test("migrates browser v1 model metadata into the v2 store without credentials", async () => {
  window.localStorage.setItem(
    LEGACY_MODEL_STORAGE_KEY,
    JSON.stringify([
      {
        id: "legacy-model",
        provider: "Legacy",
        displayName: "Legacy Model",
        modelId: "legacy-model-id",
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
    const migrated = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    assert.equal(migrated[0]?.id, "legacy-model");
    assert.equal(migrated[0]?.connectionStatus, "untested");
    assert.equal(migrated[0]?.testedFingerprint, "");
  });
  assert.equal(screen.getByLabelText("已连接模型数量").textContent, "0");
});

test("marks a connected image configuration changed when its connection fields are saved differently", async () => {
  window.localStorage.setItem(
    IMAGE_CONFIG_STORAGE_KEY,
    JSON.stringify({
      baseUrl: "https://old-images.example.test/v1",
      modelId: "old-image-model",
      enabled: true,
      connectionStatus: "connected",
      testedFingerprint: "[\"https://old-images.example.test/v1\",\"old-image-model\",\"\"]",
    }),
  );
  const user = userEvent.setup({ document });
  render(
    <ModelRegistryProvider>
      <RegistryHarness />
    </ModelRegistryProvider>,
  );

  await waitFor(() => {
    assert.match(screen.getByLabelText("生图配置").textContent ?? "", /old-image-model/);
  });
  await user.click(screen.getByRole("button", { name: "保存生图配置" }));
  assert.match(screen.getByLabelText("生图配置").textContent ?? "", /"connectionStatus":"changed"/);
});

test("saves text connection metadata and invalidates a changed successful configuration", async () => {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify([
      {
        id: "openai-gpt-5-6",
        provider: "OpenAI",
        displayName: "GPT-5.6",
        modelId: "gpt-tested",
        baseUrl: "https://old-models.example.test/v1",
        enabled: true,
        isDefault: true,
        connectionStatus: "connected",
        testedFingerprint:
          "[\"https://old-models.example.test/v1\",\"gpt-tested\",\"revision-provider-save\"]",
      },
    ]),
  );
  window.localStorage.setItem(
    CREDENTIAL_STORAGE_KEY,
    JSON.stringify({ "openai-gpt-5-6": "sk-provider-save" }),
  );
  window.localStorage.setItem(
    CREDENTIAL_REVISION_STORAGE_KEY,
    JSON.stringify({ "openai-gpt-5-6": "revision-provider-save" }),
  );
  const user = userEvent.setup({ document });
  render(
    <ModelRegistryProvider>
      <RegistryHarness />
    </ModelRegistryProvider>,
  );

  await waitFor(() => {
    assert.equal(screen.getByLabelText("已连接模型数量").textContent, "1");
  });
  await user.click(screen.getByRole("button", { name: "保存已变更模型配置" }));
  await waitFor(() => {
    const saved = JSON.parse(screen.getByLabelText("默认模型配置").textContent ?? "null");
    assert.deepEqual(
      {
        baseUrl: saved.baseUrl,
        modelId: saved.modelId,
        connectionStatus: saved.connectionStatus,
        testedFingerprint: saved.testedFingerprint,
      },
      {
        baseUrl: "https://changed-models.example.test/v1",
        modelId: "gpt-changed",
        connectionStatus: "changed",
        testedFingerprint: "",
      },
    );
    assert.equal(screen.getByLabelText("已连接模型数量").textContent, "0");
  });

  await user.click(screen.getByRole("button", { name: "保存模型测试结果" }));
  await waitFor(() => {
    assert.equal(screen.getByLabelText("已连接模型数量").textContent, "1");
    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]")[0];
    assert.equal(persisted.connectionStatus, "connected");
    assert.equal(
      persisted.testedFingerprint,
      "[\"https://changed-models.example.test/v1\",\"gpt-changed\",\"revision-provider-save\"]",
    );
  });
});

test("persists added untested models without making them selectable", async () => {
  const user = userEvent.setup({ document });
  const firstRender = render(
    <ModelRegistryProvider>
      <RegistryHarness />
    </ModelRegistryProvider>,
  );

  await waitFor(() => {
    assert.equal(screen.getByLabelText("聊天已选模型").textContent, "none");
  });
  await user.click(screen.getByRole("button", { name: "添加模型" }));
  await user.click(screen.getByRole("button", { name: "聊天选择新增模型" }));
  assert.equal(screen.getByLabelText("聊天已选模型").textContent, "none");

  firstRender.unmount();
  render(
    <ModelRegistryProvider>
      <RegistryHarness />
    </ModelRegistryProvider>,
  );

  await waitFor(() => {
    assert.equal(screen.getByLabelText("模型数量").textContent, "2");
  });
  assert.equal(screen.getByLabelText("聊天已选模型").textContent, "none");

  await user.click(screen.getByRole("button", { name: "停用新增模型" }));
  assert.equal(screen.getByLabelText("聊天已选模型").textContent, "none");
  assert.equal(screen.getByLabelText("聊天已选模型 ID").textContent, "none");
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
        baseUrl: "https://models.example.test/v1",
        enabled: true,
        isDefault: false,
        connectionStatus: "connected",
        testedFingerprint:
          "[\"https://models.example.test/v1\",\"gpt-5.6\",\"revision-default-openai\"]",
      },
      {
        id: "anthropic-claude-stored",
        provider: "Anthropic",
        displayName: "Claude Stored",
        modelId: "claude-stored",
        baseUrl: "https://models.example.test/v1",
        enabled: true,
        isDefault: true,
        connectionStatus: "connected",
        testedFingerprint:
          "[\"https://models.example.test/v1\",\"claude-stored\",\"revision-default-claude\"]",
      },
    ]),
  );
  window.localStorage.setItem(
    CREDENTIAL_STORAGE_KEY,
    JSON.stringify({
      "openai-gpt-5-6": "sk-default-openai",
      "anthropic-claude-stored": "sk-default-claude",
    }),
  );
  window.localStorage.setItem(
    CREDENTIAL_REVISION_STORAGE_KEY,
    JSON.stringify({
      "openai-gpt-5-6": "revision-default-openai",
      "anthropic-claude-stored": "revision-default-claude",
    }),
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
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify([
      {
        id: "openai-gpt-5-6",
        provider: "OpenAI",
        displayName: "GPT-5.6",
        modelId: "gpt-5.6",
        baseUrl: "https://models.example.test/v1",
        enabled: true,
        isDefault: true,
        connectionStatus: "connected",
        testedFingerprint:
          "[\"https://models.example.test/v1\",\"gpt-5.6\",\"revision-selection-openai\"]",
      },
      {
        id: ADDED_MODEL_ID,
        provider: "Anthropic",
        displayName: "Claude Test",
        modelId: "claude-test",
        baseUrl: "https://models.example.test/v1",
        enabled: true,
        isDefault: false,
        connectionStatus: "connected",
        testedFingerprint:
          "[\"https://models.example.test/v1\",\"claude-test\",\"revision-selection-claude\"]",
      },
      {
        id: SECOND_MODEL_ID,
        provider: "Google",
        displayName: "Gemini Test",
        modelId: "gemini-test",
        baseUrl: "https://models.example.test/v1",
        enabled: true,
        isDefault: false,
        connectionStatus: "connected",
        testedFingerprint:
          "[\"https://models.example.test/v1\",\"gemini-test\",\"revision-selection-gemini\"]",
      },
    ]),
  );
  window.localStorage.setItem(
    CREDENTIAL_STORAGE_KEY,
    JSON.stringify({
      "openai-gpt-5-6": "sk-selection-openai",
      [ADDED_MODEL_ID]: "sk-selection-claude",
      [SECOND_MODEL_ID]: "sk-selection-gemini",
    }),
  );
  window.localStorage.setItem(
    CREDENTIAL_REVISION_STORAGE_KEY,
    JSON.stringify({
      "openai-gpt-5-6": "revision-selection-openai",
      [ADDED_MODEL_ID]: "revision-selection-claude",
      [SECOND_MODEL_ID]: "revision-selection-gemini",
    }),
  );
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
