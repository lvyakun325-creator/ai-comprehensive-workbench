"use client";

import { useEffect, useRef } from "react";
import {
  usesApinebulaDirectProbe,
  type ContentMatrixProtocol,
} from "../lib/content-matrix-runtime";

export type ContentMatrixSessionConfig = {
  protocol: ContentMatrixProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type ContentMatrixConnectionState =
  | { kind: "idle"; message: string }
  | { kind: "testing"; message: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

const PROVIDER_PRESETS = {
  openai: {
    label: "OpenAI",
    protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
  },
  anthropic: {
    label: "Anthropic",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-5",
  },
  gemini: {
    label: "Google Gemini",
    protocol: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-2.5-flash",
  },
  deepseek: {
    label: "DeepSeek",
    protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
  },
  "apinebula-codex": {
    label: "APINebula（CODEX）",
    protocol: "openai-compatible",
    baseUrl: "https://api.yhlxj.ai/v1",
    model: "gpt-5.5",
  },
} as const;

export type ContentMatrixPreset = keyof typeof PROVIDER_PRESETS | "custom";

type ContentMatrixConfigPanelProps = {
  draft: ContentMatrixSessionConfig;
  preset: ContentMatrixPreset;
  connection: ContentMatrixConnectionState;
  activeConfig: ContentMatrixSessionConfig | null;
  canApply: boolean;
  onDraftChange: (draft: ContentMatrixSessionConfig) => void;
  onPresetChange: (
    preset: ContentMatrixPreset,
    draft: ContentMatrixSessionConfig,
  ) => void;
  onTest: () => void;
  onApply: () => void;
  onClear: () => void;
};

export function createDefaultContentMatrixConfig(): ContentMatrixSessionConfig {
  const preset = PROVIDER_PRESETS.openai;
  return {
    protocol: preset.protocol,
    baseUrl: preset.baseUrl,
    apiKey: "",
    model: preset.model,
  };
}

export function ContentMatrixConfigPanel({
  draft,
  preset,
  connection,
  activeConfig,
  canApply,
  onDraftChange,
  onPresetChange,
  onTest,
  onApply,
  onClear,
}: ContentMatrixConfigPanelProps) {
  const apiKeyInput = useRef<HTMLInputElement>(null);
  const usesApinebulaProbe = usesApinebulaDirectProbe(
    draft.protocol,
    draft.baseUrl,
  );

  useEffect(() => {
    if (draft.apiKey === "" && apiKeyInput.current) {
      apiKeyInput.current.value = "";
    }
  }, [draft.apiKey]);

  const update = <Key extends keyof ContentMatrixSessionConfig>(
    key: Key,
    value: ContentMatrixSessionConfig[Key],
  ) => {
    onDraftChange({ ...draft, [key]: value });
  };

  const selectPreset = (nextPreset: ContentMatrixPreset) => {
    if (nextPreset === "custom") {
      onPresetChange(nextPreset, draft);
      return;
    }
    const selected = PROVIDER_PRESETS[nextPreset];
    onPresetChange(nextPreset, {
      protocol: selected.protocol,
      baseUrl: selected.baseUrl,
      apiKey: "",
      model: selected.model,
    });
  };

  return (
    <section className="matrix-config-panel" aria-labelledby="matrix-config-title">
      <div className="matrix-config-heading">
        <div>
          <span className="eyebrow">CONTENT MATRIX RUNTIME</span>
          <h2 id="matrix-config-title">内容矩阵 Agent · 当前会话模型</h2>
          <p>
            API Key 只保留在当前页面内存中，刷新即清空；模型请求会经过工作台服务端代理。
          </p>
        </div>
        <span className={`matrix-config-badge ${activeConfig ? "ready" : ""}`}>
          {activeConfig ? "会话已配置" : "尚未应用"}
        </span>
      </div>

      <div className="matrix-config-grid">
        <label>
          服务商预设
          <select
            aria-label="服务商预设"
            onChange={(event) =>
              selectPreset(event.target.value as ContentMatrixPreset)
            }
            value={preset}
          >
            {Object.entries(PROVIDER_PRESETS).map(([value, item]) => (
              <option key={value} value={value}>{item.label}</option>
            ))}
            <option value="custom">自定义 HTTPS 接口</option>
          </select>
        </label>
        <label>
          协议
          <select
            aria-label="协议"
            onChange={(event) =>
              update("protocol", event.target.value as ContentMatrixProtocol)
            }
            value={draft.protocol}
          >
            <option value="openai-compatible">OpenAI-compatible</option>
            <option value="anthropic">Anthropic</option>
            <option value="gemini">Gemini</option>
          </select>
        </label>
        <label className="matrix-config-wide">
          API 地址
          <input
            aria-label="API 地址"
            autoComplete="off"
            inputMode="url"
            onChange={(event) => update("baseUrl", event.target.value)}
            spellCheck="false"
            value={draft.baseUrl}
          />
          <small>仅支持 HTTPS 公网地址；本机、局域网和 .local 地址会被拒绝。</small>
        </label>
        <label>
          API Key
          <input
            aria-label="API Key"
            autoComplete="new-password"
            onChange={(event) => update("apiKey", event.target.value)}
            ref={apiKeyInput}
            type="password"
          />
        </label>
        <label>
          模型名称
          <input
            aria-label="模型名称"
            autoComplete="off"
            onChange={(event) => update("model", event.target.value)}
            spellCheck="false"
            value={draft.model}
          />
        </label>
      </div>

      {connection.message ? (
        <div
          className={`matrix-config-message ${connection.kind}`}
          role={connection.kind === "error" ? "alert" : "status"}
        >
          {connection.message}
        </div>
      ) : null}

      <div className="matrix-config-actions">
        <button
          disabled={connection.kind === "testing"}
          onClick={onTest}
          type="button"
        >
          {connection.kind === "testing"
            ? usesApinebulaProbe
              ? "正在测试文案模型…"
              : "正在测试…"
            : usesApinebulaProbe
              ? "测试文案模型"
              : "测试连接"}
        </button>
        {usesApinebulaProbe ? (
          <small>
            会发送一句固定短消息，可能产生极少量模型调用费用。
          </small>
        ) : null}
        <button
          className="primary"
          disabled={!canApply || connection.kind === "testing"}
          onClick={onApply}
          type="button"
        >
          应用到当前会话
        </button>
        <button className="danger" onClick={onClear} type="button">
          清空当前会话配置
        </button>
      </div>
    </section>
  );
}
