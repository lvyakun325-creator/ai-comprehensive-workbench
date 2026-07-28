"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  connectionFingerprint,
  type ChatModel,
} from "../lib/model-registry.mjs";
import { maskCredential } from "../lib/model-credential-store.mjs";
import {
  safeModelErrorMessage,
  testImageConnection,
  testTextConnection,
  usesBrowserDirectModelRoute,
} from "../lib/global-model-runtime";
import { useModelRegistry } from "./ModelRegistryProvider";

type ConnectionStatus = ChatModel["connectionStatus"];

type TextDraft = {
  provider: string;
  displayName: string;
  baseUrl: string;
  modelId: string;
  apiKeyDraft: string;
  clearCredential: boolean;
  enabled: boolean;
  isDefault: boolean;
};

type ImageDraft = {
  baseUrl: string;
  modelId: string;
  apiKeyDraft: string;
  clearCredential: boolean;
  enabled: boolean;
};

type NewTextDraft = TextDraft & { visible: boolean };

type SettingsBaseline = {
  models: ChatModel[];
  credentials: Record<string, string | null>;
  imageConfig: {
    baseUrl: string;
    modelId: string;
    enabled: boolean;
    connectionStatus: ConnectionStatus;
    testedFingerprint: string;
  };
  imageCredential: string | null;
};

const EMPTY_NEW_TEXT_DRAFT: NewTextDraft = {
  provider: "",
  displayName: "",
  baseUrl: "",
  modelId: "",
  apiKeyDraft: "",
  clearCredential: false,
  enabled: false,
  isDefault: false,
  visible: false,
};

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  untested: "未测试",
  testing: "测试中",
  connected: "连接成功",
  failed: "连接失败",
  changed: "配置已变更",
};

function draftFromModel(model: ChatModel): TextDraft {
  return {
    provider: model.provider,
    displayName: model.displayName,
    baseUrl: model.baseUrl,
    modelId: model.modelId,
    apiKeyDraft: "",
    clearCredential: false,
    enabled: model.enabled,
    isDefault: model.isDefault,
  };
}

function imageDraftFromConfig(config: {
  baseUrl: string;
  modelId: string;
  enabled: boolean;
}): ImageDraft {
  return {
    baseUrl: config.baseUrl,
    modelId: config.modelId,
    apiKeyDraft: "",
    clearCredential: false,
    enabled: config.enabled,
  };
}

async function proxyTest(path: string, config: {
  baseUrl: string;
  apiKey: string;
  model: string;
}) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config }),
  });
  const body = await response.json().catch(() => null) as {
    ok?: boolean;
    message?: string;
  } | null;
  if (!response.ok || body?.ok !== true) {
    throw new Error(body?.message || "连接测试失败，请检查配置后重试。");
  }
}

function safeUiError(error: unknown, apiKey: string) {
  if (error instanceof Error && error.message) {
    return error.message.replaceAll(apiKey, "");
  }
  return safeModelErrorMessage(error, apiKey);
}

export function GlobalModelSettings({
  onPreview,
}: {
  onPreview: (message: string) => void;
}) {
  const {
    models,
    addModel,
    getCredential,
    getMaskedCredential,
    imageConfig,
    imageCredential,
    invalidateImageConnection,
    invalidateModelConnection,
    removeModel,
    saveCredential,
    saveImageConfig,
    saveImageCredential,
    saveModelConfig,
    setDefaultModel,
  } = useModelRegistry();
  const dirtyModelIds = useRef(new Set<string>());
  const imageDirty = useRef(false);
  const baseline = useRef<SettingsBaseline | null>(null);
  const addedModelIds = useRef(new Set<string>());
  const [drafts, setDrafts] = useState<Record<string, TextDraft>>(() =>
    Object.fromEntries(models.map((model) => [model.id, draftFromModel(model)])),
  );
  const [imageDraft, setImageDraft] = useState<ImageDraft>(() =>
    imageDraftFromConfig(imageConfig),
  );
  const [newDraft, setNewDraft] = useState<NewTextDraft>(EMPTY_NEW_TEXT_DRAFT);
  const [textRequests, setTextRequests] = useState<Record<string, boolean>>({});
  const [textErrors, setTextErrors] = useState<Record<string, string>>({});
  const [imageTesting, setImageTesting] = useState(false);
  const [imageError, setImageError] = useState("");
  const [validationError, setValidationError] = useState("");
  const [pendingDeletedIds, setPendingDeletedIds] = useState<Set<string>>(
    () => new Set(),
  );

  const ensureBaseline = () => {
    if (baseline.current) return;
    baseline.current = {
      models: models.map((model) => ({ ...model })),
      credentials: Object.fromEntries(
        models.map((model) => [model.id, getCredential(model.id)]),
      ),
      imageConfig: { ...imageConfig },
      imageCredential,
    };
  };

  useEffect(() => {
    setDrafts((current) =>
      Object.fromEntries(models.map((model) => [
        model.id,
        dirtyModelIds.current.has(model.id)
          ? current[model.id] ?? draftFromModel(model)
          : draftFromModel(model),
      ])),
    );
  }, [models]);

  useEffect(() => {
    if (!imageDirty.current) {
      setImageDraft(imageDraftFromConfig(imageConfig));
    }
  }, [imageConfig]);

  const updateTextDraft = (
    modelId: string,
    patch: Partial<TextDraft>,
    connectionField = false,
  ) => {
    ensureBaseline();
    dirtyModelIds.current.add(modelId);
    setDrafts((current) => ({
      ...current,
      [modelId]: { ...current[modelId], ...patch },
    }));
    if (connectionField) {
      invalidateModelConnection(modelId);
    }
  };

  const updateImageDraft = (
    patch: Partial<ImageDraft>,
    connectionField = false,
  ) => {
    ensureBaseline();
    imageDirty.current = true;
    setImageDraft((current) => ({ ...current, ...patch }));
    if (connectionField) {
      invalidateImageConnection();
    }
  };

  const resolvedTextKey = (id: string, draft: TextDraft) =>
    draft.clearCredential
      ? ""
      : draft.apiKeyDraft.trim() || getCredential(id) || "";

  const testTextModel = async (model: ChatModel) => {
    const draft = drafts[model.id];
    const apiKey = resolvedTextKey(model.id, draft);
    if (!draft.baseUrl.trim() || !draft.modelId.trim() || !apiKey) {
      setTextErrors((current) => ({
        ...current,
        [model.id]: "请先填写文案模型 API Key、接口地址和模型名称。",
      }));
      return;
    }

    setTextRequests((current) => ({ ...current, [model.id]: true }));
    setTextErrors((current) => ({ ...current, [model.id]: "" }));
    const config = {
      baseUrl: draft.baseUrl.trim(),
      apiKey,
      model: draft.modelId.trim(),
    };
    saveModelConfig(model.id, {
      provider: draft.provider,
      displayName: draft.displayName,
      baseUrl: config.baseUrl,
      modelId: config.model,
      connectionStatus: "testing",
      testedFingerprint: "",
    });

    try {
      if (usesBrowserDirectModelRoute(config.baseUrl)) {
        await testTextConnection(config, { egressMode: "browser-direct" });
      } else {
        await proxyTest("/api/models/test-text", config);
      }
      saveCredential(model.id, draft.apiKeyDraft, draft.clearCredential);
      saveModelConfig(model.id, {
        provider: draft.provider,
        displayName: draft.displayName,
        baseUrl: config.baseUrl,
        modelId: config.model,
        enabled: draft.enabled,
        isDefault: draft.isDefault,
        connectionStatus: "connected",
        testedFingerprint: connectionFingerprint(config.baseUrl, config.model, ""),
      });
      dirtyModelIds.current.delete(model.id);
      setDrafts((current) => ({
        ...current,
        [model.id]: {
          ...current[model.id],
          apiKeyDraft: "",
          clearCredential: false,
        },
      }));
      onPreview(`${draft.displayName} 连接成功`);
    } catch (error) {
      saveModelConfig(model.id, {
        connectionStatus: "failed",
        testedFingerprint: "",
      });
      setTextErrors((current) => ({
        ...current,
        [model.id]: safeUiError(error, apiKey),
      }));
    } finally {
      setTextRequests((current) => ({ ...current, [model.id]: false }));
    }
  };

  const testImageModel = async () => {
    const apiKey = imageDraft.clearCredential
      ? ""
      : imageDraft.apiKeyDraft.trim() || imageCredential || "";
    if (!imageDraft.baseUrl.trim() || !imageDraft.modelId.trim() || !apiKey) {
      setImageError("请先填写生图模型 API Key、接口地址和模型名称。");
      return;
    }

    setImageTesting(true);
    setImageError("");
    const config = {
      baseUrl: imageDraft.baseUrl.trim(),
      apiKey,
      model: imageDraft.modelId.trim(),
    };
    saveImageConfig({
      baseUrl: config.baseUrl,
      modelId: config.model,
      connectionStatus: "testing",
      testedFingerprint: "",
    });

    try {
      if (usesBrowserDirectModelRoute(config.baseUrl)) {
        await testImageConnection(config, { egressMode: "browser-direct" });
      } else {
        await proxyTest("/api/models/test-image", config);
      }
      saveImageCredential(imageDraft.apiKeyDraft, imageDraft.clearCredential);
      saveImageConfig({
        baseUrl: config.baseUrl,
        modelId: config.model,
        enabled: imageDraft.enabled,
        connectionStatus: "connected",
        testedFingerprint: connectionFingerprint(config.baseUrl, config.model, ""),
      });
      imageDirty.current = false;
      setImageDraft((current) => ({
        ...current,
        apiKeyDraft: "",
        clearCredential: false,
      }));
      onPreview("生图模型连接成功");
    } catch (error) {
      saveImageConfig({ connectionStatus: "failed", testedFingerprint: "" });
      setImageError(safeUiError(error, apiKey));
    } finally {
      setImageTesting(false);
    }
  };

  const saveSettings = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const visibleModels = models.filter((model) => !pendingDeletedIds.has(model.id));
    for (const model of visibleModels) {
      const draft = drafts[model.id];
      if (!draft.provider.trim() || !draft.displayName.trim() || !draft.modelId.trim()) {
        setValidationError("请填写每个文案模型的服务商、显示名称和模型名称。");
        return;
      }
    }

    for (const model of visibleModels) {
      const draft = drafts[model.id];
      saveCredential(model.id, draft.apiKeyDraft, draft.clearCredential);
      saveModelConfig(model.id, {
        provider: draft.provider,
        displayName: draft.displayName,
        baseUrl: draft.baseUrl,
        modelId: draft.modelId,
        enabled: draft.enabled,
        isDefault: draft.isDefault,
      });
      dirtyModelIds.current.delete(model.id);
    }
    for (const modelId of pendingDeletedIds) {
      removeModel(modelId);
      saveCredential(modelId, "", true);
    }
    const defaultModel = visibleModels.find((model) => drafts[model.id].isDefault);
    if (defaultModel) {
      setDefaultModel(defaultModel.id);
    }
    saveImageCredential(imageDraft.apiKeyDraft, imageDraft.clearCredential);
    saveImageConfig({
      baseUrl: imageDraft.baseUrl,
      modelId: imageDraft.modelId,
      enabled: imageDraft.enabled,
    });
    imageDirty.current = false;
    setDrafts(Object.fromEntries(models.map((model) => [
      model.id,
      { ...drafts[model.id], apiKeyDraft: "", clearCredential: false },
    ])));
    setImageDraft((current) => ({
      ...current,
      apiKeyDraft: "",
      clearCredential: false,
    }));
    baseline.current = null;
    addedModelIds.current.clear();
    setPendingDeletedIds(new Set());
    setValidationError("");
    onPreview("模型设置已保存");
  };

  const cancelSettings = () => {
    const saved = baseline.current;
    if (saved) {
      for (const model of models) {
        if (!saved.models.some((candidate) => candidate.id === model.id)) {
          removeModel(model.id);
          saveCredential(model.id, "", true);
        }
      }
      for (const model of saved.models) {
        if (!models.some((candidate) => candidate.id === model.id)) {
          addModel(model);
        }
        saveCredential(
          model.id,
          saved.credentials[model.id] ?? "",
          saved.credentials[model.id] === null,
        );
        saveModelConfig(model.id, {
          ...model,
          connectionStatus: "changed",
          testedFingerprint: "",
        });
        saveModelConfig(model.id, model);
      }
      const savedDefault = saved.models.find((model) => model.isDefault);
      if (savedDefault) setDefaultModel(savedDefault.id);
      saveImageCredential(
        saved.imageCredential ?? "",
        saved.imageCredential === null,
      );
      saveImageConfig({
        ...saved.imageConfig,
        connectionStatus: "changed",
        testedFingerprint: "",
      });
      saveImageConfig(saved.imageConfig);
    }
    dirtyModelIds.current.clear();
    imageDirty.current = false;
    setDrafts(Object.fromEntries(
      (saved?.models ?? models).map((model) => [model.id, draftFromModel(model)]),
    ));
    setImageDraft(imageDraftFromConfig(saved?.imageConfig ?? imageConfig));
    setNewDraft(EMPTY_NEW_TEXT_DRAFT);
    baseline.current = null;
    addedModelIds.current.clear();
    setPendingDeletedIds(new Set());
    setValidationError("");
    setTextErrors({});
    setImageError("");
    onPreview("已取消本次修改");
  };

  const addTextModel = () => {
    ensureBaseline();
    const provider = newDraft.provider.trim();
    const displayName = newDraft.displayName.trim();
    const modelId = newDraft.modelId.trim();
    const baseUrl = newDraft.baseUrl.trim();
    const apiKey = newDraft.apiKeyDraft.trim();
    if (!provider || !displayName || !modelId || !baseUrl || !apiKey) {
      setValidationError("新增文案模型时，请完整填写服务商、显示名称、API Key、接口地址和模型名称。");
      return;
    }
    if (models.some((model) =>
      model.provider.toLocaleLowerCase() === provider.toLocaleLowerCase()
      && model.modelId.toLocaleLowerCase() === modelId.toLocaleLowerCase()
    )) {
      setValidationError(`服务商「${provider}」与模型名称「${modelId}」已存在。`);
      return;
    }
    const id = globalThis.crypto?.randomUUID?.()
      ?? `model-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    addModel({
      id,
      provider,
      displayName,
      baseUrl,
      modelId,
      enabled: false,
      isDefault: false,
    });
    addedModelIds.current.add(id);
    saveCredential(id, apiKey, false);
    setNewDraft(EMPTY_NEW_TEXT_DRAFT);
    setValidationError("");
    onPreview(`已添加文案模型：${displayName}`);
  };

  return (
    <form className="global-model-settings" onSubmit={saveSettings}>
      <header className="model-settings-header">
        <div>
          <span className="eyebrow">MODEL SETTINGS</span>
          <h1>模型设置</h1>
          <p>分别填写文案模型和生图模型的 API Key、Base URL、模型名称。</p>
        </div>
        <p className="model-settings-security-note">
          浏览器本机保存不是硬件级加密，同源脚本可读取。
        </p>
      </header>

      <section className="model-settings-section" aria-labelledby="text-models-heading">
        <div className="model-settings-section-heading">
          <div>
            <h2 id="text-models-heading">文案模型</h2>
            <p>只有测试成功并启用的模型，才会进入聊天与普通 Agent 的模型选择器。</p>
          </div>
          <button
            onClick={() => setNewDraft((current) => ({ ...current, visible: true }))}
            type="button"
          >
            添加文案模型
          </button>
        </div>

        {newDraft.visible ? (
          <article className="model-settings-card">
            <h3>新增文案模型</h3>
            <div className="model-settings-metadata-fields">
              <label>
                服务商
                <input
                  onChange={(event) =>
                    setNewDraft((current) => ({ ...current, provider: event.target.value }))}
                  value={newDraft.provider}
                />
              </label>
              <label>
                模型显示名称
                <input
                  onChange={(event) =>
                    setNewDraft((current) => ({ ...current, displayName: event.target.value }))}
                  value={newDraft.displayName}
                />
              </label>
            </div>
            <label>
              文案模型 API Key
              <input
                autoComplete="new-password"
                onChange={(event) =>
                  setNewDraft((current) => ({ ...current, apiKeyDraft: event.target.value }))}
                type="password"
                value={newDraft.apiKeyDraft}
              />
            </label>
            <div className="model-settings-connection-fields">
              <label>
                文案接口地址
                <input
                  onChange={(event) =>
                    setNewDraft((current) => ({ ...current, baseUrl: event.target.value }))}
                  value={newDraft.baseUrl}
                />
              </label>
              <label>
                文案模型名称
                <input
                  onChange={(event) =>
                    setNewDraft((current) => ({ ...current, modelId: event.target.value }))}
                  value={newDraft.modelId}
                />
              </label>
            </div>
            <div className="model-settings-actions">
              <button onClick={addTextModel} type="button">添加模型</button>
              <button
                onClick={() => setNewDraft(EMPTY_NEW_TEXT_DRAFT)}
                type="button"
              >
                取消新增
              </button>
            </div>
          </article>
        ) : null}

        <div className="model-settings-card-list">
          {models.filter((model) => !pendingDeletedIds.has(model.id)).map((model) => {
            const draft = drafts[model.id] ?? draftFromModel(model);
            const testing = textRequests[model.id] === true;
            const status = testing ? "testing" : model.connectionStatus;
            const maskedCredential = getMaskedCredential(model.id);
            return (
              <article className="model-settings-card" key={model.id}>
                <div className="model-settings-card-heading">
                  <div>
                    <h3>{draft.displayName}</h3>
                    <span>{draft.provider}</span>
                  </div>
                  <output
                    aria-label={`${draft.displayName} 连接状态`}
                    className={`connection-status ${status}`}
                    role="status"
                  >
                    {STATUS_LABELS[status]}
                  </output>
                </div>
                <div className="model-settings-metadata-fields">
                  <label>
                    服务商
                    <input
                      onChange={(event) =>
                        updateTextDraft(model.id, { provider: event.target.value })}
                      value={draft.provider}
                    />
                  </label>
                  <label>
                    模型显示名称
                    <input
                      onChange={(event) =>
                        updateTextDraft(model.id, { displayName: event.target.value })}
                      value={draft.displayName}
                    />
                  </label>
                </div>
                <label>
                  文案模型 API Key
                  <input
                    autoComplete="new-password"
                    onChange={(event) =>
                      updateTextDraft(
                        model.id,
                        { apiKeyDraft: event.target.value, clearCredential: false },
                        true,
                      )}
                    type="password"
                    value={draft.apiKeyDraft}
                  />
                </label>
                {maskedCredential ? (
                  <p className="credential-saved-line">
                    已保存 Key：<span>{maskedCredential}</span>
                  </p>
                ) : (
                  <p className="credential-saved-line">尚未保存 API Key</p>
                )}
                <label className="model-settings-clear-key">
                  <input
                    checked={draft.clearCredential}
                    onChange={(event) =>
                      updateTextDraft(
                        model.id,
                        { clearCredential: event.target.checked, apiKeyDraft: "" },
                        true,
                      )}
                    type="checkbox"
                  />
                  清空已保存的文案 API Key
                </label>
                <div className="model-settings-connection-fields">
                  <label>
                    文案接口地址
                    <input
                      onChange={(event) =>
                        updateTextDraft(model.id, { baseUrl: event.target.value }, true)}
                      value={draft.baseUrl}
                    />
                  </label>
                  <label>
                    文案模型名称
                    <input
                      onChange={(event) =>
                        updateTextDraft(model.id, { modelId: event.target.value }, true)}
                      value={draft.modelId}
                    />
                  </label>
                </div>
                {textErrors[model.id] ? <p role="alert">{textErrors[model.id]}</p> : null}
                <div className="model-settings-actions">
                  <button
                    disabled={testing}
                    onClick={() => void testTextModel(model)}
                    type="button"
                  >
                    {testing ? "正在测试…" : "测试文案模型"}
                  </button>
                  <label>
                    <input
                      checked={draft.enabled}
                      disabled={status !== "connected"}
                      onChange={(event) =>
                        updateTextDraft(model.id, { enabled: event.target.checked })}
                      type="checkbox"
                    />
                    {`启用 ${draft.displayName}`}
                  </label>
                  <label>
                    <input
                      checked={draft.isDefault}
                      disabled={status !== "connected" || !draft.enabled}
                      name="default-text-model"
                      onChange={() => {
                        for (const candidate of models) {
                          if (pendingDeletedIds.has(candidate.id)) continue;
                          updateTextDraft(candidate.id, {
                            isDefault: candidate.id === model.id,
                          });
                        }
                      }}
                      type="radio"
                    />
                    设为默认
                  </label>
                  <button
                    className="danger"
                    onClick={() => {
                      ensureBaseline();
                      setPendingDeletedIds((current) =>
                        new Set([...current, model.id]));
                    }}
                    type="button"
                  >
                    删除 {draft.displayName}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="model-settings-section" aria-labelledby="image-model-heading">
        <div className="model-settings-section-heading">
          <div>
            <h2 id="image-model-heading">生图模型</h2>
            <p>测试只读取模型列表，不会发起图片生成，也不会产生图片测试费用。</p>
          </div>
        </div>
        <article className="model-settings-card">
          <div className="model-settings-card-heading">
            <h3>全局生图模型</h3>
            <output
              aria-label="生图模型连接状态"
              className={`connection-status ${imageTesting ? "testing" : imageConfig.connectionStatus}`}
              role="status"
            >
              {STATUS_LABELS[imageTesting ? "testing" : imageConfig.connectionStatus]}
            </output>
          </div>
          <label>
            生图模型 API Key
            <input
              autoComplete="new-password"
              onChange={(event) =>
                updateImageDraft(
                  { apiKeyDraft: event.target.value, clearCredential: false },
                  true,
                )}
              type="password"
              value={imageDraft.apiKeyDraft}
            />
          </label>
          {imageCredential ? (
            <p className="credential-saved-line">
              已保存 Key：<span>{maskCredential(imageCredential)}</span>
            </p>
          ) : (
            <p className="credential-saved-line">尚未保存 API Key</p>
          )}
          <label className="model-settings-clear-key">
            <input
              checked={imageDraft.clearCredential}
              onChange={(event) =>
                updateImageDraft(
                  {
                    clearCredential: event.target.checked,
                    apiKeyDraft: "",
                  },
                  true,
                )}
              type="checkbox"
            />
            清空已保存的生图 API Key
          </label>
          <div className="model-settings-connection-fields">
            <label>
              生图接口地址
              <input
                onChange={(event) =>
                  updateImageDraft({ baseUrl: event.target.value }, true)}
                value={imageDraft.baseUrl}
              />
            </label>
            <label>
              生图模型名称
              <input
                onChange={(event) =>
                  updateImageDraft({ modelId: event.target.value }, true)}
                value={imageDraft.modelId}
              />
            </label>
          </div>
          {imageError ? <p role="alert">{imageError}</p> : null}
          <div className="model-settings-actions">
            <button
              disabled={imageTesting}
              onClick={() => void testImageModel()}
              type="button"
            >
              {imageTesting ? "正在测试…" : "测试生图模型"}
            </button>
            <label>
              <input
                checked={imageDraft.enabled}
                disabled={imageConfig.connectionStatus !== "connected"}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  updateImageDraft({ enabled: event.target.checked })}
                type="checkbox"
              />
              启用生图模型
            </label>
          </div>
        </article>
      </section>

      {validationError ? <p role="alert">{validationError}</p> : null}
      <footer className="model-settings-footer">
        <span>设置只保存在当前浏览器本机。</span>
        <div>
          <button onClick={cancelSettings} type="button">取消</button>
          <button type="submit">保存设置</button>
        </div>
      </footer>
    </form>
  );
}
