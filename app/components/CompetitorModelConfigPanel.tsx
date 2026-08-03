"use client";

import { useEffect, useRef, useState } from "react";
import {
  SafeModelError,
  testTextConnection,
  usesBrowserDirectModelRoute,
} from "../lib/global-model-runtime";
import {
  clearCompetitorModelSession,
  configureCompetitorModelSession,
  useCompetitorModelSession,
  type CompetitorModelSessionConfig,
} from "../lib/competitor-model-session-store";

type ProviderPreset = "openai" | "apinebula";

const PRESETS: Record<ProviderPreset, {
  label: string;
  baseUrl: string;
  model: string;
}> = {
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
  },
  apinebula: {
    label: "APINebula（CODEX）",
    baseUrl: "https://apinebula.ai/v1",
    model: "gpt-5.5",
  },
};

export function CompetitorModelConfigPanel() {
  const session = useCompetitorModelSession();
  const [preset, setPreset] = useState<ProviderPreset>(() =>
    presetForConfig(session.config));
  const [draft, setDraft] = useState<CompetitorModelSessionConfig>(() =>
    session.config ? {...session.config} : defaultConfig());
  const [testedFingerprint, setTestedFingerprint] = useState("");
  const [connection, setConnection] = useState<{
    kind: "idle" | "testing" | "success" | "error";
    message: string;
  }>({kind: "idle", message: ""});
  const requestRef = useRef(0);
  const apiKeyInput = useRef<HTMLInputElement>(null);
  const fingerprint = configFingerprint(draft);
  const canApply = Boolean(testedFingerprint && testedFingerprint === fingerprint);
  const browserDirect = usesBrowserDirectModelRoute(draft.baseUrl);

  useEffect(() => {
    if (!session.config && apiKeyInput.current) apiKeyInput.current.value = "";
  }, [session.config]);

  const updateDraft = <Key extends keyof CompetitorModelSessionConfig>(
    key: Key,
    value: CompetitorModelSessionConfig[Key],
  ) => {
    requestRef.current += 1;
    setDraft((current) => ({...current, [key]: value}));
    setTestedFingerprint("");
    setConnection({kind: "idle", message: "配置已修改，请重新测试连接。"});
  };

  const selectPreset = (nextPreset: ProviderPreset) => {
    const selected = PRESETS[nextPreset];
    requestRef.current += 1;
    setPreset(nextPreset);
    setDraft({baseUrl: selected.baseUrl, apiKey: "", model: selected.model});
    setTestedFingerprint("");
    setConnection({kind: "idle", message: "已切换服务商，请填写 API Key 后测试。"});
  };

  const testConnection = async () => {
    if (connection.kind === "testing") return;
    const testedDraft = normalizedConfig(draft);
    if (!testedDraft.baseUrl || !testedDraft.apiKey || !testedDraft.model) {
      setConnection({kind: "error", message: "请完整填写 API 地址、API Key 和模型名称。"});
      return;
    }
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setTestedFingerprint("");
    setConnection({
      kind: "testing",
      message: browserDirect
        ? "正在由浏览器直接测试竞品模型…"
        : "正在通过工作台服务端测试竞品模型…",
    });
    try {
      if (browserDirect) {
        await testTextConnection(testedDraft, {
          fetchImpl: fetch,
          egressMode: "browser-direct",
        });
      } else {
        const response = await fetch("/api/models/test-text", {
          method: "POST",
          cache: "no-store",
          headers: {"content-type": "application/json"},
          body: JSON.stringify({config: testedDraft}),
        });
        const payload = await readSafeResponse(response);
        if (!response.ok || payload.ok !== true) {
          throw new Error(safeConnectionMessage(payload));
        }
      }
      if (requestRef.current !== requestId) return;
      setTestedFingerprint(configFingerprint(testedDraft));
      setConnection({kind: "success", message: "连接测试成功，模型可用"});
    } catch (error) {
      if (requestRef.current !== requestId) return;
      setConnection({
        kind: "error",
        message: error instanceof SafeModelError || error instanceof Error
          ? redactSecret(error.message, testedDraft.apiKey)
          : "连接测试失败，请检查网络与配置后重试。",
      });
    }
  };

  const applyConfig = () => {
    if (!canApply) return;
    const active = configureCompetitorModelSession(normalizedConfig(draft));
    setConnection({
      kind: "success",
      message: `竞品洞察已使用独立模型：${active.config?.model ?? ""}`,
    });
  };

  const clearConfig = () => {
    requestRef.current += 1;
    clearCompetitorModelSession();
    setDraft(defaultConfig());
    setPreset("openai");
    setTestedFingerprint("");
    setConnection({kind: "success", message: "竞品洞察独立模型配置已清空。"});
  };

  return (
    <section className="matrix-config-panel" aria-labelledby="competitor-model-config-title">
      <div className="matrix-config-heading">
        <div>
          <span className="eyebrow">COMPETITOR INSIGHT RUNTIME</span>
          <h2 id="competitor-model-config-title">竞品洞察 Agent · 独立模型配置</h2>
          <p>竞品报告只使用这里应用的模型，不会读取或回退到全局模型。</p>
          <p>API Key 只保留在当前页面内存中，刷新页面后需要重新配置。</p>
          <p>{browserDirect
            ? "当前由浏览器直接连接 APINebula，Key 不经过工作台服务端。"
            : "当前通过工作台服务端连接 OpenAI 官方地址。"}</p>
        </div>
        <span className={`matrix-config-badge ${session.config ? "ready" : ""}`}>
          {session.config ? "独立模型已应用" : "尚未应用"}
        </span>
      </div>

      <div className="matrix-config-grid">
        <label>
          服务商
          <select
            aria-label="竞品模型服务商"
            onChange={(event) => selectPreset(event.target.value as ProviderPreset)}
            value={preset}
          >
            {Object.entries(PRESETS).map(([value, item]) => (
              <option key={value} value={value}>{item.label}</option>
            ))}
          </select>
        </label>
        <label className="matrix-config-wide">
          API 地址
          <input
            aria-label="竞品模型 API 地址"
            autoComplete="off"
            inputMode="url"
            onChange={(event) => updateDraft("baseUrl", event.target.value)}
            spellCheck="false"
            value={draft.baseUrl}
          />
        </label>
        <label>
          API Key
          <input
            aria-label="竞品模型 API Key"
            autoComplete="new-password"
            onChange={(event) => updateDraft("apiKey", event.target.value)}
            ref={apiKeyInput}
            type="password"
            value={draft.apiKey}
          />
        </label>
        <label>
          模型名称
          <input
            aria-label="竞品模型名称"
            autoComplete="off"
            onChange={(event) => updateDraft("model", event.target.value)}
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
          onClick={() => void testConnection()}
          type="button"
        >
          {connection.kind === "testing" ? "正在测试竞品模型…" : "测试竞品模型"}
        </button>
        <button
          className="primary"
          disabled={!canApply || connection.kind === "testing"}
          onClick={applyConfig}
          type="button"
        >
          应用到竞品洞察
        </button>
        <button className="danger" onClick={clearConfig} type="button">
          清空独立配置
        </button>
      </div>
    </section>
  );
}

function normalizedConfig(config: CompetitorModelSessionConfig): CompetitorModelSessionConfig {
  return {
    baseUrl: config.baseUrl.trim(),
    apiKey: config.apiKey.trim(),
    model: config.model.trim(),
  };
}

function defaultConfig(): CompetitorModelSessionConfig {
  return {
    baseUrl: PRESETS.openai.baseUrl,
    apiKey: "",
    model: PRESETS.openai.model,
  };
}

function presetForConfig(config: CompetitorModelSessionConfig | null): ProviderPreset {
  return config?.baseUrl === PRESETS.apinebula.baseUrl ? "apinebula" : "openai";
}

function configFingerprint(config: CompetitorModelSessionConfig): string {
  const normalized = normalizedConfig(config);
  return JSON.stringify([normalized.baseUrl, normalized.model, normalized.apiKey]);
}

async function readSafeResponse(response: Response): Promise<Record<string, unknown>> {
  try {
    const payload: unknown = await response.json();
    return typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function safeConnectionMessage(payload: Record<string, unknown>): string {
  return typeof payload.message === "string"
    ? payload.message
    : "连接测试失败，请检查网络与配置后重试。";
}

function redactSecret(message: string, apiKey: string): string {
  return apiKey ? message.split(apiKey).join("[已隐藏]") : message;
}
