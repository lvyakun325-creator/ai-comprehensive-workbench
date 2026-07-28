"use client";

import { useState, type FormEvent } from "react";
import { useModelRegistry } from "./ModelRegistryProvider";

type ModelConfigPanelProps =
  | {
      scope: "global";
      onPreview: (message: string) => void;
    }
  | {
      scope: "agent";
      agentId: string;
      agentTitle: string;
      onPreview: (message: string) => void;
    };

type ModelDraftForm = {
  provider: string;
  displayName: string;
  modelId: string;
  enabled: boolean;
};

const EMPTY_DRAFT: ModelDraftForm = {
  provider: "",
  displayName: "",
  modelId: "",
  enabled: false,
};

function modelKey(provider: string, modelId: string) {
  return `${provider.trim().toLocaleLowerCase()}\u0000${modelId.trim().toLocaleLowerCase()}`;
}

export function ModelConfigPanel(props: ModelConfigPanelProps) {
  const { scope, onPreview } = props;
  const {
    models,
    enabledModels,
    addModel,
    getAgentSelectedModelId,
    removeModel,
    setAgentSelectedModelId,
    setDefaultModel,
    setModelEnabled,
  } = useModelRegistry();
  const [draft, setDraft] = useState<ModelDraftForm>(EMPTY_DRAFT);
  const [error, setError] = useState("");

  const submitModel = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const provider = draft.provider.trim();
    const displayName = draft.displayName.trim();
    const modelId = draft.modelId.trim();

    if (!provider || !displayName || !modelId) {
      setError("请填写服务商、模型显示名称与模型 ID。");
      return;
    }

    if (models.some((model) => modelKey(model.provider, model.modelId) === modelKey(provider, modelId))) {
      setError(`服务商「${provider}」与模型 ID「${modelId}」已存在。`);
      return;
    }

    addModel({ provider, displayName, modelId, enabled: draft.enabled });
    setDraft(EMPTY_DRAFT);
    setError("");
    onPreview(`已添加模型：${displayName}`);
  };

  if (scope === "agent") {
    const { agentId, agentTitle } = props;
    const selectedModelId = getAgentSelectedModelId(agentId);

    return (
      <section className="design-preview" aria-label="agent 模型配置">
        <span className="eyebrow">AGENT MODEL</span>
        <h2>{`${agentTitle} · Agent 默认模型`}</h2>
        <p>仅可选择全局已启用模型；内容矩阵 Agent 使用独立的会话配置。</p>

        {enabledModels.length === 0 ? (
          <p role="alert">请先在模型配置中启用至少一个模型。</p>
        ) : (
          <fieldset className="task-list" aria-label="可选模型">
            <legend>为当前 Agent 选择模型</legend>
            {enabledModels.map((model) => (
              <label key={model.id}>
                <input
                  checked={selectedModelId === model.id}
                  name={`agent-model-${agentId}`}
                  onChange={() => {
                    setAgentSelectedModelId(agentId, model.id);
                    onPreview(`已为${agentTitle}选择 ${model.displayName}`);
                  }}
                  type="radio"
                />
                <strong>{model.displayName}</strong>
                <span>{model.provider} · {model.modelId}</span>
              </label>
            ))}
          </fieldset>
        )}
      </section>
    );
  }

  return (
    <section className="design-preview" aria-label="global 模型配置">
      <span className="eyebrow">MODEL REGISTRY</span>
      <h2>全局可用模型</h2>
      <p>模型列表仅保存服务商与模型标识；连接信息由后续服务端链路处理。</p>

      <form className="model-config-form" onSubmit={submitModel}>
        <label>
          服务商
          <input
            onChange={(event) => setDraft((current) => ({ ...current, provider: event.target.value }))}
            value={draft.provider}
          />
        </label>
        <label>
          模型显示名称
          <input
            onChange={(event) => setDraft((current) => ({ ...current, displayName: event.target.value }))}
            value={draft.displayName}
          />
        </label>
        <label>
          模型 ID
          <input
            onChange={(event) => setDraft((current) => ({ ...current, modelId: event.target.value }))}
            value={draft.modelId}
          />
        </label>
        <label className="model-enabled-toggle">
          <input
            checked={draft.enabled}
            onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))}
            type="checkbox"
          />
          添加后启用
        </label>
        <button type="submit">添加模型</button>
      </form>

      {error ? <p role="alert">{error}</p> : null}

      <ul className="configured-model-list" aria-label="已配置模型">
        {models.map((model) => (
          <li className="configured-model-row" key={model.id}>
            <div>
              <strong>{model.displayName}</strong>
              <span>{model.provider} · {model.modelId}</span>
            </div>
            <div className="model-state-actions">
              <span>{model.enabled ? "已启用" : "已停用"}{model.isDefault ? " · 默认" : ""}</span>
              <button
                onClick={() => setModelEnabled(model.id, !model.enabled)}
                type="button"
              >
                {model.enabled ? `停用 ${model.displayName}` : `启用 ${model.displayName}`}
              </button>
              <button
                aria-label={
                  model.isDefault
                    ? "设为默认"
                    : `设为默认 ${model.displayName}（${model.provider} · ${model.modelId}）`
                }
                disabled={!model.enabled || model.isDefault}
                onClick={() => setDefaultModel(model.id)}
                type="button"
              >
                设为默认
              </button>
              <button onClick={() => removeModel(model.id)} type="button">
                删除 {model.displayName}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
