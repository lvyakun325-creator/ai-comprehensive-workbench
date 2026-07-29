"use client";

import { GlobalModelSettings } from "./GlobalModelSettings";
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

export function ModelConfigPanel(props: ModelConfigPanelProps) {
  const { scope, onPreview } = props;
  const {
    enabledModels,
    getAgentSelectedModelId,
    setAgentSelectedModelId,
  } = useModelRegistry();

  if (scope === "global") {
    return <GlobalModelSettings onPreview={onPreview} />;
  }

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
}
