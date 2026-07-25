"use client";

import { useState } from "react";

const PROVIDERS = [
  ["OpenAI", "GPT 系列"],
  ["Anthropic", "Claude 系列"],
  ["Google AI", "Gemini 系列"],
  ["阿里云百炼", "通义千问系列"],
  ["DeepSeek", "DeepSeek 系列"],
  ["火山方舟", "豆包系列"],
] as const;

type ModelConfigPanelProps = {
  scope: "global" | "agent";
  agentTitle?: string;
  onPreview: (message: string) => void;
};

export function ModelConfigPanel({
  scope,
  agentTitle,
  onPreview,
}: ModelConfigPanelProps) {
  const [selectedProvider, setSelectedProvider] = useState(0);
  const selected = PROVIDERS[selectedProvider];

  const selectProvider = (index: number) => {
    setSelectedProvider(index);
    onPreview("当前为设计预览，未填写或保存任何模型密钥");
  };

  return (
    <section className="design-preview" aria-label={`${scope} 模型配置`}>
      <span className="eyebrow">DESIGN PREVIEW</span>
      <h2>{scope === "global" ? "全局可用模型" : `${agentTitle} · Agent 默认模型`}</h2>
      <p>密钥仅在后续接口阶段通过服务端保存，当前页面不收集、不显示。</p>
      <p>{scope === "global" ? "为整个工作台准备可选模型池。" : "仅为当前 Agent 项目预览默认模型。"}</p>

      <div className="task-list" aria-label="模型服务商选择">
        {PROVIDERS.map(([provider, family], index) => (
          <button
            aria-pressed={selectedProvider === index}
            className={selectedProvider === index ? "active" : ""}
            key={provider}
            onClick={() => selectProvider(index)}
            type="button"
          >
            <strong>{provider}</strong>
            <span>{family}</span>
          </button>
        ))}
      </div>

      <p>当前设计选择：{selected[0]} · {selected[1]}</p>
    </section>
  );
}
