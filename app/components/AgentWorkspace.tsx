import type { AgentProject } from "../lib/agent-catalog.mjs";
import type { TaskStatusFilter } from "../lib/agent-project-records.mjs";
import { useEffect, useRef, useState } from "react";
import { AgentResultFiles } from "./AgentResultFiles";
import { AgentTaskList } from "./AgentTaskList";
import {
  ContentMatrixConfigPanel,
  createDefaultContentMatrixConfig,
  type ContentMatrixConnectionState,
  type ContentMatrixPreset,
  type ContentMatrixSessionConfig,
} from "./ContentMatrixConfigPanel";
import {
  ContentMatrixRunner,
  type ContentMatrixRunOperation,
  type ContentMatrixStageResult,
} from "./ContentMatrixRunner";
import {
  ContentMatrixRuntimeError,
  createContentMatrixRuntime,
  usesApinebulaDirectProbe,
} from "../lib/content-matrix-runtime";
import { ModelConfigPanel } from "./ModelConfigPanel";

const PROJECT_TABS = [
  "项目总览",
  "Agent 对话",
  "任务列表",
  "成果文件",
  "Agent 配置",
];

const PROJECT_STATUS = "等待接收本项目任务";
const APINEBULA_GENERATION_TIMEOUT_MS = 180_000;

const MATRIX_DIAGNOSIS_FIELDS = [
  ["platform", "主攻平台"],
  ["product", "产品/服务描述"],
  ["region", "地域属性"],
  ["conversion", "终极转化"],
  ["decisionMaker", "决策者与使用者"],
  ["concerns", "客户核心顾虑"],
  ["resources", "人力与预算"],
  ["ip", "核心 IP"],
  ["ownership", "账号归属"],
  ["stage", "当前矩阵阶段"],
  ["competitorFormation", "竞品阵型"],
  ["risk", "行业风控"],
] as const;

const MATRIX_FLOW = ["需求澄清", "战略判断", "战术设计", "执行 SOP", "结果固化"];

type MatrixDiagnosisValues = Record<string, string>;

function matrixConfigsMatch(
  first: ContentMatrixSessionConfig | null,
  second: ContentMatrixSessionConfig,
) {
  return Boolean(
    first
    && first.protocol === second.protocol
    && first.baseUrl === second.baseUrl
    && first.apiKey === second.apiKey
    && first.model === second.model,
  );
}

function ChoiceGroup({
  legend,
  name,
  options,
  value,
  onChange,
  required = false,
  invalid = false,
}: {
  legend: string;
  name: string;
  options: Array<[string, string]>;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  invalid?: boolean;
}) {
  return (
    <fieldset
      aria-invalid={invalid || undefined}
      aria-required={required || undefined}
      className="matrix-choice-group"
      role="radiogroup"
    >
      <legend>
        {legend}
        {required ? <span className="matrix-required">（必填）</span> : null}
      </legend>
      <div>
        {options.map(([optionValue, label]) => (
          <label key={optionValue}>
            <input
              checked={value === optionValue}
              name={name}
              onChange={() => onChange(optionValue)}
              type="radio"
            />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

type AgentWorkspaceProps = {
  agent: AgentProject;
  onBack: () => void;
  onPreview: (message: string) => void;
};

export function AgentWorkspace({ agent, onBack, onPreview }: AgentWorkspaceProps) {
  const [activeTab, setActiveTab] = useState(PROJECT_TABS[0]);
  const [resultTaskId, setResultTaskId] = useState<string | null>(null);
  const [taskFilter, setTaskFilter] = useState<TaskStatusFilter>("all");
  const [matrixDiagnosis, setMatrixDiagnosis] = useState<MatrixDiagnosisValues>({});
  const [matrixSubmitAttempted, setMatrixSubmitAttempted] = useState(false);
  const [matrixReady, setMatrixReady] = useState(false);
  const [matrixConfigDraft, setMatrixConfigDraft] = useState(
    createDefaultContentMatrixConfig,
  );
  const [matrixConfigPreset, setMatrixConfigPreset] =
    useState<ContentMatrixPreset>("openai");
  const [matrixTestedConfig, setMatrixTestedConfig] =
    useState<ContentMatrixSessionConfig | null>(null);
  const [matrixActiveConfig, setMatrixActiveConfig] =
    useState<ContentMatrixSessionConfig | null>(null);
  const [matrixConnection, setMatrixConnection] =
    useState<ContentMatrixConnectionState>({ kind: "idle", message: "" });
  const [matrixStages, setMatrixStages] = useState<ContentMatrixStageResult[]>([]);
  const [matrixFeedback, setMatrixFeedback] = useState<Record<number, string>>({});
  const [matrixRunningOperation, setMatrixRunningOperation] =
    useState<ContentMatrixRunOperation | null>(null);
  const [matrixRunError, setMatrixRunError] = useState<
    (ContentMatrixRunOperation & { message: string }) | null
  >(null);
  const matrixConfigRevision = useRef(0);
  const matrixConnectionRequest = useRef(0);
  const matrixRunRevision = useRef(0);
  const matrixRunRequest = useRef(0);
  const matrixRunAbortController = useRef<AbortController | null>(null);
  const isContentMatrix = agent.id === "content-matrix";
  const requiresPrivateAssets = matrixDiagnosis.platform === "video-account";
  const requiredMatrixFields = requiresPrivateAssets
    ? [...MATRIX_DIAGNOSIS_FIELDS, ["privateAssets", "私域资产"] as const]
    : MATRIX_DIAGNOSIS_FIELDS;
  const missingMatrixFields = requiredMatrixFields.filter(
    ([key]) => !matrixDiagnosis[key]?.trim(),
  );
  const completedMatrixFields = requiredMatrixFields.length - missingMatrixFields.length;
  const isMatrixFieldInvalid = (key: string) => (
    matrixSubmitAttempted && !matrixDiagnosis[key]?.trim()
  );

  useEffect(
    () => () => matrixRunAbortController.current?.abort(),
    [],
  );

  const abortActiveMatrixRun = () => {
    matrixRunAbortController.current?.abort();
    matrixRunAbortController.current = null;
  };

  const updateMatrixDiagnosis = (key: string, value: string) => {
    abortActiveMatrixRun();
    matrixRunRevision.current += 1;
    matrixRunRequest.current += 1;
    setMatrixDiagnosis((current) => ({ ...current, [key]: value }));
    setMatrixReady(false);
    setMatrixStages([]);
    setMatrixFeedback({});
    setMatrixRunError(null);
    setMatrixRunningOperation(null);
  };

  const submitMatrixDiagnosis = () => {
    setMatrixSubmitAttempted(true);
    setMatrixReady(missingMatrixFields.length === 0);
  };

  const updateMatrixConfigDraft = (draft: ContentMatrixSessionConfig) => {
    matrixConfigRevision.current += 1;
    matrixConnectionRequest.current += 1;
    setMatrixConfigDraft(draft);
    setMatrixTestedConfig(null);
    setMatrixConnection({ kind: "idle", message: "配置已修改，请重新测试连接。" });
  };

  const changeMatrixPreset = (
    preset: ContentMatrixPreset,
    draft: ContentMatrixSessionConfig,
  ) => {
    setMatrixConfigPreset(preset);
    updateMatrixConfigDraft(draft);
  };

  const testMatrixConnection = async () => {
    if (matrixConnection.kind === "testing") return;
    const requestId = matrixConnectionRequest.current + 1;
    matrixConnectionRequest.current = requestId;
    const configRevision = matrixConfigRevision.current;
    const testedDraft = { ...matrixConfigDraft };
    const requestIsCurrent = () => (
      matrixConnectionRequest.current === requestId
      && matrixConfigRevision.current === configRevision
    );
    const directApinebula = usesApinebulaDirectProbe(
      testedDraft.protocol,
      testedDraft.baseUrl,
    );
    setMatrixTestedConfig(null);
    setMatrixConnection({
      kind: "testing",
      message: directApinebula
        ? "正在由浏览器直接测试 APINebula 文案模型…"
        : "正在通过服务端代理测试连接…",
    });
    try {
      if (directApinebula) {
        const result = await createContentMatrixRuntime({
          fetchImpl: fetch,
        }).testConnection(testedDraft);
        if (!requestIsCurrent()) return;
        setMatrixTestedConfig(testedDraft);
        setMatrixConnection({
          kind: "success",
          message: result.modelAvailable
            ? "连接测试成功，模型可用"
            : "连接成功，但模型列表中未找到当前模型，请核对模型名称。",
        });
        return;
      }
      const response = await fetch("/api/agents/content-matrix", {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "test",
          ...testedDraft,
        }),
      });
      const payload = await readMatrixResponse(response);
      if (!requestIsCurrent()) return;
      if (
        !response.ok
        || payload.ok !== true
        || payload.connected !== true
      ) {
        setMatrixConnection({
          kind: "error",
          message: matrixSafeErrorMessage(
            payload,
            testedDraft.apiKey,
            testedDraft.baseUrl,
          ),
        });
        return;
      }
      if (payload.modelAvailable !== true) {
        setMatrixConnection({
          kind: "error",
          message: "连接成功，但模型列表中未找到当前模型，请核对模型名称。",
        });
        return;
      }
      setMatrixTestedConfig(testedDraft);
      setMatrixConnection({
        kind: "success",
        message: "连接测试成功，模型可用",
      });
    } catch (error) {
      if (!requestIsCurrent()) return;
      setMatrixConnection({
        kind: "error",
        message: error instanceof ContentMatrixRuntimeError
          ? error.message
          : "连接测试失败，请检查网络与配置后重试。",
      });
    }
  };

  const applyMatrixConfig = () => {
    if (!matrixTestedConfig) return;
    const configChanged = !matrixConfigsMatch(
      matrixActiveConfig,
      matrixTestedConfig,
    );
    setMatrixActiveConfig({ ...matrixTestedConfig });
    setMatrixConnection({
      kind: "success",
      message: `当前会话已应用：${matrixTestedConfig.model}`,
    });
    if (!configChanged) return;

    abortActiveMatrixRun();
    matrixRunRevision.current += 1;
    matrixRunRequest.current += 1;
    setMatrixStages([]);
    setMatrixFeedback({});
    setMatrixRunError(null);
    setMatrixRunningOperation(null);
  };

  const clearMatrixConfig = () => {
    abortActiveMatrixRun();
    matrixConfigRevision.current += 1;
    matrixConnectionRequest.current += 1;
    matrixRunRevision.current += 1;
    matrixRunRequest.current += 1;
    setMatrixConfigDraft(createDefaultContentMatrixConfig());
    setMatrixConfigPreset("openai");
    setMatrixTestedConfig(null);
    setMatrixActiveConfig(null);
    setMatrixConnection({
      kind: "success",
      message: "当前会话配置已清空；已完成的非敏感阶段结果仍保留。",
    });
    setMatrixRunError(null);
    setMatrixRunningOperation(null);
  };

  const updateMatrixFeedback = (
    stage: 2 | 3 | 4,
    value: string,
  ) => {
    abortActiveMatrixRun();
    matrixRunRevision.current += 1;
    matrixRunRequest.current += 1;
    setMatrixFeedback((current) => ({ ...current, [stage]: value }));
    setMatrixRunError(null);
    setMatrixRunningOperation(null);
  };

  const cancelMatrixRun = () => {
    if (!matrixRunningOperation) return;
    matrixRunRevision.current += 1;
    matrixRunRequest.current += 1;
    abortActiveMatrixRun();
    setMatrixRunError(null);
    setMatrixRunningOperation(null);
  };

  const runMatrixStage = async (
    stage: 2 | 3 | 4 | 5,
    mode: "advance" | "regenerate",
  ) => {
    if (
      matrixRunningOperation !== null
      || !matrixActiveConfig
      || !matrixReady
      || (mode === "regenerate" && !matrixFeedback[stage]?.trim())
    ) {
      return;
    }

    const operation = { stage, mode } as const;
    const requestId = matrixRunRequest.current + 1;
    matrixRunRequest.current = requestId;
    const runRevision = matrixRunRevision.current;
    const activeConfig = { ...matrixActiveConfig };
    const runController = new AbortController();
    matrixRunAbortController.current = runController;
    const requestIsCurrent = () => (
      matrixRunRequest.current === requestId
      && matrixRunRevision.current === runRevision
    );
    setMatrixRunningOperation(operation);
    setMatrixRunError(null);
    const history = matrixStages
      .filter((result) => result.stage < stage)
      .map((result) => ({
        stage: result.stage,
        markdown: result.markdown,
      }));
    const confirmation =
      stage > 2
        ? { confirmed: true, confirmedStage: stage - 1 }
        : {};
    const runPayload = {
      ...activeConfig,
      stage,
      diagnostic: JSON.stringify(matrixDiagnosis),
      history,
      feedback: mode === "regenerate"
        ? matrixFeedback[stage] ?? ""
        : "",
      ...confirmation,
    };

    try {
      if (
        usesApinebulaDirectProbe(
          activeConfig.protocol,
          activeConfig.baseUrl,
        )
      ) {
        const result = await createContentMatrixRuntime({
          fetchImpl: fetch,
          generationTimeoutMs: APINEBULA_GENERATION_TIMEOUT_MS,
          signal: runController.signal,
        }).runStage(runPayload);
        if (!requestIsCurrent()) return;
        setMatrixStages((current) => [
          ...current.filter((stageResult) => stageResult.stage !== stage),
          {
            stage,
            markdown: redactMatrixSecret(result.markdown, activeConfig.apiKey),
          },
        ]);
        if (mode === "regenerate") {
          setMatrixFeedback((current) => ({ ...current, [stage]: "" }));
        }
        return;
      }
      const response = await fetch("/api/agents/content-matrix", {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        signal: runController.signal,
        body: JSON.stringify({
          action: "run",
          ...runPayload,
        }),
      });
      const payload = await readMatrixResponse(response);
      if (!requestIsCurrent()) return;
      if (
        !response.ok
        || payload.ok !== true
        || payload.stage !== stage
        || typeof payload.markdown !== "string"
      ) {
        setMatrixRunError({
          ...operation,
          message: matrixSafeErrorMessage(payload, activeConfig.apiKey),
        });
        return;
      }
      setMatrixStages((current) => [
        ...current.filter((result) => result.stage !== stage),
        {
          stage,
          markdown: redactMatrixSecret(
            payload.markdown as string,
            activeConfig.apiKey,
          ),
        },
      ]);
      if (mode === "regenerate") {
        setMatrixFeedback((current) => ({ ...current, [stage]: "" }));
      }
    } catch (error) {
      if (!requestIsCurrent()) return;
      setMatrixRunError({
        ...operation,
        message: error instanceof ContentMatrixRuntimeError
          ? error.message
          : "模型请求失败，请检查网络后安全重试。",
      });
    } finally {
      if (requestIsCurrent()) {
        if (matrixRunAbortController.current === runController) {
          matrixRunAbortController.current = null;
        }
        setMatrixRunningOperation(null);
      }
    }
  };

  return (
    <section className="agent-workspace">
      <div className="agent-workspace-topbar">
        <button className="back-button" onClick={onBack}>← 返回 Agent 项目</button>
        <span>{agent.index}</span>
      </div>

      <div className="isolation-banner">
        <span>✓</span>
        <p>当前位于「{agent.title}」。它只会操作当前项目，不会修改其他 Agent 项目。</p>
      </div>

      <div className="agent-project-header">
        <span className={`agent-icon ${agent.accent}`}>{agent.icon}</span>
        <div>
          <span className="eyebrow">ISOLATED AGENT PROJECT</span>
          <h1>{agent.title}</h1>
          <p>{agent.responsibility}</p>
        </div>
      </div>

      <nav className="project-tabs" aria-label={`${agent.title} 项目导航`}>
        {PROJECT_TABS.map((tab) => (
          <button
            className={activeTab === tab ? "active" : ""}
            aria-current={activeTab === tab ? "page" : undefined}
            key={tab}
            onClick={() => {
              if (tab === "成果文件") {
                setResultTaskId(null);
              }
              setActiveTab(tab);
              if (tab === "Agent 对话" && !isContentMatrix) {
                onPreview(`${tab}将在真实 Agent 接入后启用`);
              }
            }}
          >
            {tab}
          </button>
        ))}
      </nav>

      {activeTab === "任务列表" ? (
        <AgentTaskList
          agentId={agent.id}
          filter={taskFilter}
          onFilterChange={setTaskFilter}
          onOpenResult={(taskId) => {
            setResultTaskId(taskId);
            setActiveTab("成果文件");
          }}
        />
      ) : activeTab === "成果文件" ? (
        <AgentResultFiles
          agentId={agent.id}
          initialTaskId={resultTaskId}
          onPreview={onPreview}
        />
      ) : activeTab === "Agent 配置" && isContentMatrix ? (
        <ContentMatrixConfigPanel
          activeConfig={matrixActiveConfig}
          canApply={matrixTestedConfig !== null}
          connection={matrixConnection}
          draft={matrixConfigDraft}
          onApply={applyMatrixConfig}
          onClear={clearMatrixConfig}
          onDraftChange={updateMatrixConfigDraft}
          onPresetChange={changeMatrixPreset}
          onTest={testMatrixConnection}
          preset={matrixConfigPreset}
        />
      ) : activeTab === "Agent 配置" ? (
        <ModelConfigPanel
          scope="agent"
          agentId={agent.id}
          agentTitle={agent.title}
          onPreview={onPreview}
        />
      ) : isContentMatrix && activeTab === "Agent 对话" ? (
        <section className="matrix-diagnosis" aria-labelledby="matrix-diagnosis-title">
          <div className="matrix-diagnosis-heading">
            <div>
              <span className="panel-label">第一阶段 · 需求澄清</span>
              <h2 id="matrix-diagnosis-title">企业矩阵基建诊断表</h2>
              <p>请用选择和简答补齐经营底牌；本地预览只校验资料，不会生成矩阵方案。</p>
            </div>
            <p className="matrix-completion" aria-live="polite">
              必填完成度：{completedMatrixFields} / {requiredMatrixFields.length}
            </p>
          </div>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              submitMatrixDiagnosis();
            }}
          >
            <div className="matrix-form-grid">
              <ChoiceGroup
                legend="主攻平台"
                name="platform"
                options={[["xiaohongshu", "小红书"], ["douyin", "抖音"], ["video-account", "视频号"]]}
                value={matrixDiagnosis.platform ?? ""}
                onChange={(value) => updateMatrixDiagnosis("platform", value)}
                required
                invalid={isMatrixFieldInvalid("platform")}
              />
              <label className="matrix-text-field">
                产品/服务描述<span className="matrix-required">（必填）</span>
                <textarea
                  aria-label="产品/服务描述"
                  aria-invalid={isMatrixFieldInvalid("product") || undefined}
                  aria-required="true"
                  onChange={(event) => updateMatrixDiagnosis("product", event.target.value)}
                  placeholder="一句话说明产品、服务或业务"
                  value={matrixDiagnosis.product ?? ""}
                />
              </label>
              <ChoiceGroup
                legend="地域属性"
                name="region"
                options={[["local", "强同城属性"], ["national", "全国可做"]]}
                value={matrixDiagnosis.region ?? ""}
                onChange={(value) => updateMatrixDiagnosis("region", value)}
                required
                invalid={isMatrixFieldInvalid("region")}
              />
              <ChoiceGroup
                legend="终极转化"
                name="conversion"
                options={[["platform", "平台内直接闭环"], ["lead", "获取客资"], ["private", "导流私域"]]}
                value={matrixDiagnosis.conversion ?? ""}
                onChange={(value) => updateMatrixDiagnosis("conversion", value)}
                required
                invalid={isMatrixFieldInvalid("conversion")}
              />
              <ChoiceGroup
                legend="掏钱决策者与实际使用者分离吗？"
                name="decision-maker"
                options={[["same", "不分离"], ["separate", "分离"]]}
                value={matrixDiagnosis.decisionMaker ?? ""}
                onChange={(value) => updateMatrixDiagnosis("decisionMaker", value)}
                required
                invalid={isMatrixFieldInvalid("decisionMaker")}
              />
              <label className="matrix-text-field">
                客户核心顾虑<span className="matrix-required">（必填）</span>
                <textarea
                  aria-label="客户核心顾虑"
                  aria-invalid={isMatrixFieldInvalid("concerns") || undefined}
                  aria-required="true"
                  onChange={(event) => updateMatrixDiagnosis("concerns", event.target.value)}
                  placeholder="填写 1-2 个关键顾虑"
                  value={matrixDiagnosis.concerns ?? ""}
                />
              </label>
              <ChoiceGroup
                legend="人力与预算配置"
                name="resources"
                options={[["well-resourced", "有钱有人"], ["people-no-budget", "有人没钱"], ["budget-no-people", "有钱没人"], ["lean", "没钱没人"]]}
                value={matrixDiagnosis.resources ?? ""}
                onChange={(value) => updateMatrixDiagnosis("resources", value)}
                required
                invalid={isMatrixFieldInvalid("resources")}
              />
              <ChoiceGroup
                legend="核心 IP 资源"
                name="ip"
                options={[["expert", "有极具表达力的创始人/业务专家"], ["none", "无大 IP"]]}
                value={matrixDiagnosis.ip ?? ""}
                onChange={(value) => updateMatrixDiagnosis("ip", value)}
                required
                invalid={isMatrixFieldInvalid("ip")}
              />
              <ChoiceGroup
                legend="账号归属权与全员营销意愿"
                name="ownership"
                options={[["company", "所有账号必须归属公司"], ["open", "允许并鼓励员工用个人身份建号获客"]]}
                value={matrixDiagnosis.ownership ?? ""}
                onChange={(value) => updateMatrixDiagnosis("ownership", value)}
                required
                invalid={isMatrixFieldInvalid("ownership")}
              />
              <ChoiceGroup
                legend="当前矩阵阶段"
                name="stage"
                options={[["zero-to-one", "0到1"], ["one-to-many", "1到N"]]}
                value={matrixDiagnosis.stage ?? ""}
                onChange={(value) => updateMatrixDiagnosis("stage", value)}
                required
                invalid={isMatrixFieldInvalid("stage")}
              />
              <ChoiceGroup
                legend="竞品阵型"
                name="competitor-formation"
                options={[["ip", "重兵 IP"], ["volume", "铺量战术"], ["official", "官方高举高打"], ["unknown", "完全不知道竞品怎么玩的"]]}
                value={matrixDiagnosis.competitorFormation ?? ""}
                onChange={(value) => updateMatrixDiagnosis("competitorFormation", value)}
                required
                invalid={isMatrixFieldInvalid("competitorFormation")}
              />
              <ChoiceGroup
                legend="行业风控"
                name="risk"
                options={[["regular", "常规行业"], ["regulated", "强监管行业"]]}
                value={matrixDiagnosis.risk ?? ""}
                onChange={(value) => updateMatrixDiagnosis("risk", value)}
                required
                invalid={isMatrixFieldInvalid("risk")}
              />
            </div>

            <section className="matrix-optional-fields" aria-labelledby="competitor-details-title">
              <div>
                <span className="panel-label">选填 · 客观竞品资料</span>
                <h3 id="competitor-details-title">竞品名称、简介与爆款标题</h3>
                <p>仅记录你已有的客观资料；空缺时不会猜测或补造。</p>
              </div>
              <label className="matrix-text-field">竞品账号名称<input onChange={(event) => updateMatrixDiagnosis("competitorName", event.target.value)} value={matrixDiagnosis.competitorName ?? ""} /></label>
              <label className="matrix-text-field">竞品主页简介<textarea onChange={(event) => updateMatrixDiagnosis("competitorBio", event.target.value)} value={matrixDiagnosis.competitorBio ?? ""} /></label>
              <label className="matrix-text-field">竞品爆款标题<textarea onChange={(event) => updateMatrixDiagnosis("competitorTitles", event.target.value)} placeholder="可填写 2-3 个标题" value={matrixDiagnosis.competitorTitles ?? ""} /></label>
            </section>

            <section className="matrix-private-assets" aria-labelledby="private-assets-title">
              <div>
                <h3 id="private-assets-title">私域资产</h3>
                <p>{requiresPrivateAssets ? "视频号场景重点提示：请补充私域资产后再提交。" : "选填；选择视频号时会成为必填项。"}</p>
              </div>
              <ChoiceGroup
                legend="私域沉淀情况"
                name="private-assets"
                options={[["established", "已有大量老客户微信/社群"], ["limited", "几乎没有微信私域沉淀"]]}
                value={matrixDiagnosis.privateAssets ?? ""}
                onChange={(value) => updateMatrixDiagnosis("privateAssets", value)}
                required={requiresPrivateAssets}
                invalid={requiresPrivateAssets && isMatrixFieldInvalid("privateAssets")}
              />
            </section>

            {matrixSubmitAttempted && missingMatrixFields.length > 0 ? (
              <div className="matrix-validation" role="alert">
                还缺少：{missingMatrixFields.map(([, label]) => label).join("、")}
              </div>
            ) : null}
            {matrixReady ? (
              <div className="matrix-ready" role="status" aria-label="诊断提交状态">
                诊断资料已就绪，等待下一阶段接入模型进行战略分析
              </div>
            ) : null}
            <button className="matrix-submit-button" type="submit">提交诊断</button>
          </form>
          <ContentMatrixRunner
            config={matrixActiveConfig}
            diagnosisReady={matrixReady}
            error={matrixRunError}
            feedback={matrixFeedback}
            onAdvanceStage={(stage) => runMatrixStage(stage, "advance")}
            onCancel={cancelMatrixRun}
            onFeedbackChange={updateMatrixFeedback}
            onOpenConfig={() => setActiveTab("Agent 配置")}
            onRegenerateStage={(stage) =>
              runMatrixStage(stage, "regenerate")
            }
            runningOperation={matrixRunningOperation}
            stages={matrixStages}
          />
        </section>
      ) : isContentMatrix && activeTab === "项目总览" ? (
        <div className="matrix-overview">
          <article className="project-panel matrix-input-panel">
            <span className="panel-label">本项目输入</span>
            <strong>{agent.input}</strong>
            <p>状态：{PROJECT_STATUS}</p>
          </article>
          <article className="matrix-skill-card">
            <span className="panel-label">已安装技能</span>
            <strong>matrix-designer 已安装</strong>
            <p>矩阵设计专家 · 先收集经营信息，再进入战略判断。</p>
          </article>
          <article className="matrix-flow-card">
            <span className="panel-label">矩阵诊断流程</span>
            <ol aria-label="矩阵诊断五阶段流程">
              {MATRIX_FLOW.map((stage, index) => (
                <li className={index === 0 ? "current" : ""} key={stage}>
                  <span>{index + 1}</span>{stage}{index === 0 ? "（当前）" : ""}
                </li>
              ))}
            </ol>
            <button className="matrix-start-button" onClick={() => setActiveTab("Agent 对话")}>
              开始矩阵诊断
            </button>
          </article>
          <article className="project-panel matrix-output-panel">
            <span className="panel-label">本项目输出</span>
            <strong>{agent.output}</strong>
            <p>已完成的 Markdown 文档会保存在成果文件中。</p>
            <div
              className="compliance-status requires-review"
              role="status"
              aria-label="成果合规状态"
            >
              <strong>待合规检查</strong>
              <p>发布前需人工确认</p>
              <small>重点检查：诊断、疗效承诺、停换药、绝对化表达风险。</small>
            </div>
          </article>
        </div>
      ) : (
        <div className="agent-project-grid">
          <article className="project-panel">
            <span className="panel-label">本项目输入</span>
            <strong>{agent.input}</strong>
            <p>状态：{PROJECT_STATUS}</p>
          </article>
          <article className="project-panel">
            <span className="panel-label">本项目输出</span>
            <strong>{agent.output}</strong>
            <p>已完成的 Markdown 文档会保存在成果文件中。</p>
            <div
              className={`compliance-status ${agent.complianceRequired ? "requires-review" : "data-review"}`}
              role="status"
              aria-label="成果合规状态"
            >
              {agent.complianceRequired ? (
                <>
                  <strong>待合规检查</strong>
                  <p>发布前需人工确认</p>
                  <small>重点检查：诊断、疗效承诺、停换药、绝对化表达风险。</small>
                </>
              ) : (
                <>
                  <strong>数据口径确认</strong>
                  <p>当前项目以经营分析为主，仍需人工确认数据口径。</p>
                </>
              )}
            </div>
          </article>
        </div>
      )}
    </section>
  );
}

async function readMatrixResponse(
  response: Response,
): Promise<Record<string, unknown>> {
  try {
    const payload: unknown = await response.json();
    return typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function matrixSafeErrorMessage(
  payload: Record<string, unknown>,
  apiKey: string,
  baseUrl = "",
): string {
  const error = payload.error;
  if (
    typeof error === "object"
    && error !== null
    && !Array.isArray(error)
  ) {
    const errorRecord = error as Record<string, unknown>;
    if (
      errorRecord.code === "PROVIDER_UNAVAILABLE"
      && isApinebulaBaseUrl(baseUrl)
    ) {
      return "上游服务暂时不可用；APINebula 请确认使用官方 API 地址、CODEX 分组令牌及控制台模型名。";
    }
    if (typeof errorRecord.message !== "string") {
      return "服务暂时不可用，请稍后重试。";
    }
    return redactMatrixSecret(
      errorRecord.message,
      apiKey,
    );
  }
  return "服务暂时不可用，请稍后重试。";
}

function isApinebulaBaseUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "api.yhlxj.ai" || hostname === "apinebula.ai";
  } catch {
    return false;
  }
}

function redactMatrixSecret(value: string, apiKey: string): string {
  return apiKey ? value.split(apiKey).join("[已隐藏]") : value;
}
