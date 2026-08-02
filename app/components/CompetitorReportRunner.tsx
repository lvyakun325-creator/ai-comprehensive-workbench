"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  analyzeScrapeArtifacts,
  assembleReport,
  CompetitorReportClientError,
  validateReportBatch,
  type EvidenceReadyResponse,
  type ReportReadyResponse,
} from "../lib/competitor-report-client";
import {
  CompetitorReportRuntimeError,
  generateCompetitorBatch,
  generateCompetitorBatchViaProxy,
  type CompetitorBatchId,
} from "../lib/competitor-report-runtime";
import { usesBrowserDirectModelRoute } from "../lib/global-model-runtime";
import { useModelRegistry } from "./ModelRegistryProvider";

export type CompetitorAnalysisRequest = {
  requestId: number;
  taskId: string;
  platformId: "douyin" | "xiaohongshu";
  inputKind: "account" | "content";
  outputDir: string;
  dataPath: string;
  excelPath: string | null;
};

export type ReportStage =
  | "idle"
  | "normalizing"
  | "evidence-ready"
  | "generating"
  | "validating"
  | "saving"
  | "completed"
  | "failed"
  | "stopped";

export type ReportWorkflowStage = "normalizing" | "generating";
export type PreEvidenceTerminationReason = "stopped" | "model-config-changed";

type RunContext = {
  token: number;
  controller: AbortController;
  modelId: string | null;
  credentialRevision: string;
  evidenceId: string | null;
  completedBatchIds: CompetitorBatchId[];
};

const ACCOUNT_BATCH_IDS: readonly CompetitorBatchId[] = [
  "strategy",
  "performance",
  "execution",
];
const CONTENT_BATCH_IDS: readonly CompetitorBatchId[] = ["content"];
const BATCH_LABELS: Record<CompetitorBatchId, string> = {
  strategy: "战略判断批次",
  performance: "数据表现批次",
  execution: "执行方案批次",
  content: "单作品洞察批次",
};
const ACTIVE_STAGES = new Set<ReportStage>([
  "normalizing",
  "generating",
  "validating",
  "saving",
]);

export function CompetitorReportRunner({
  analysisRequest,
  onCompleted,
  onEvidencePaused,
  onFailed,
  onPreEvidenceTerminated,
  onStopped,
  onBeforeRetry,
  onStageChange,
  retryBlocked = false,
}: {
  analysisRequest: CompetitorAnalysisRequest | null;
  onCompleted?: (report: ReportReadyResponse) => void;
  onEvidencePaused?: (evidence: EvidenceReadyResponse) => void;
  onFailed?: (message: string) => void;
  onPreEvidenceTerminated?: (
    reason: PreEvidenceTerminationReason,
    message: string,
  ) => void;
  onStopped?: (message: string) => Promise<boolean>;
  onBeforeRetry?: () => Promise<boolean>;
  onStageChange?: (stage: ReportWorkflowStage, message: string) => void;
  retryBlocked?: boolean;
}) {
  const {
    connectedModels,
    getAgentSelectedModelId,
    getCredential,
    getCredentialRevision,
  } = useModelRegistry();
  const modelId = getAgentSelectedModelId("competitor-insight");
  const model = connectedModels.find((item) => item.id === modelId) ?? null;
  const credential = model ? getCredential(model.id) : null;
  const credentialRevision = model ? getCredentialRevision(model.id) : "";

  const [stage, setStage] = useState<ReportStage>("idle");
  const [statusMessage, setStatusMessage] = useState("等待链接抓取成果。");
  const [errorMessage, setErrorMessage] = useState("");
  const [failedBatchId, setFailedBatchId] =
    useState<CompetitorBatchId | "assemble" | null>(null);
  const [evidence, setEvidence] = useState<EvidenceReadyResponse | null>(null);
  const [validatedBatches, setValidatedBatches] = useState<Record<string, unknown>[]>([]);
  const [retryPreparing, setRetryPreparing] = useState(false);

  const tokenRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const liveModelRef = useRef({modelId, credentialRevision});
  const evidenceRef = useRef<EvidenceReadyResponse | null>(null);
  const batchesRef = useRef<Record<string, unknown>[]>([]);
  const previousModelRef = useRef({modelId, credentialRevision});
  const lastAnalysisRequestRef = useRef(0);

  useLayoutEffect(() => {
    liveModelRef.current = {modelId, credentialRevision};
  }, [credentialRevision, modelId]);

  const publishStage = useCallback((nextStage: ReportStage, message: string) => {
    setStage(nextStage);
    setStatusMessage(message);
    if (nextStage === "normalizing") {
      onStageChange?.("normalizing", message);
    } else if (
      nextStage === "evidence-ready"
      || nextStage === "generating"
      || nextStage === "validating"
      || nextStage === "saving"
    ) {
      onStageChange?.("generating", message);
    }
  }, [onStageChange]);

  const isCurrent = useCallback((run: RunContext) => {
    const batchIds = batchesRef.current.map(
      (batch) => batch.batchId as CompetitorBatchId,
    );
    return (
      tokenRef.current === run.token
      && controllerRef.current === run.controller
      && !run.controller.signal.aborted
      && liveModelRef.current.modelId === run.modelId
      && liveModelRef.current.credentialRevision === run.credentialRevision
      && (evidenceRef.current?.evidenceId ?? null) === run.evidenceId
      && sameBatchIds(batchIds, run.completedBatchIds)
    );
  }, []);

  const createRun = useCallback((): RunContext => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    tokenRef.current += 1;
    return {
      token: tokenRef.current,
      controller,
      modelId: liveModelRef.current.modelId,
      credentialRevision: liveModelRef.current.credentialRevision,
      evidenceId: evidenceRef.current?.evidenceId ?? null,
      completedBatchIds: batchesRef.current.map(
        (batch) => batch.batchId as CompetitorBatchId,
      ),
    };
  }, []);

  const failRun = useCallback((
    run: RunContext,
    message: string,
    failed: CompetitorBatchId | "assemble" | null,
  ) => {
    if (!isCurrent(run)) return;
    controllerRef.current = null;
    setStage("failed");
    setFailedBatchId(failed);
    setErrorMessage(message);
    setStatusMessage("本次报告未完成，已保留证据包和通过校验的批次。");
    onFailed?.(message);
  }, [isCurrent, onFailed]);

  const runReportBatches = useCallback(async (
    run: RunContext,
    readyEvidence: EvidenceReadyResponse,
    startingBatches: Record<string, unknown>[],
  ) => {
    const selectedModelId = modelId;
    const selectedModel = model;
    const selectedCredential = credential;
    const selectedRevision = credentialRevision;

    if (
      !selectedModelId
      || !selectedModel
      || !selectedCredential
      || !selectedRevision
      || selectedModel.connectionStatus !== "connected"
      || run.modelId !== selectedModelId
      || run.credentialRevision !== selectedRevision
    ) {
      if (!isCurrent(run)) return;
      controllerRef.current = null;
      publishStage("evidence-ready", "证据包已生成，等待配置模型。");
      onEvidencePaused?.(readyEvidence);
      return;
    }

    const batchIds = batchIdsForEvidence(readyEvidence);
    const completed = [...startingBatches];
    for (let index = completed.length; index < batchIds.length; index += 1) {
      const batchId = batchIds[index];
      try {
        const batchInput = recordValue(readyEvidence.batchInputs[batchId]);
        if (!batchInput) {
          throw new CompetitorReportClientError(
            "INVALID_BRIDGE_RESPONSE",
            "本地报告服务返回了无效响应。",
          );
        }
        const config = {
          baseUrl: selectedModel.baseUrl,
          apiKey: selectedCredential,
          model: selectedModel.modelId,
        };
        let validated: Awaited<ReturnType<typeof validateReportBatch>> | null = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            publishStage(
              "generating",
              attempt === 0
                ? `正在生成${BATCH_LABELS[batchId]}…`
                : `${BATCH_LABELS[batchId]}格式或证据校验未通过，正在自动重试一次…`,
            );
            const generated = usesBrowserDirectModelRoute(selectedModel.baseUrl)
              ? await generateCompetitorBatch(config, batchInput, {
                batchId,
                signal: run.controller.signal,
                egressMode: "browser-direct",
              })
              : await generateCompetitorBatchViaProxy(config, batchInput, {
                batchId,
                signal: run.controller.signal,
              });
            if (!isCurrent(run)) return;

            publishStage("validating", `正在校验${BATCH_LABELS[batchId]}的证据引用…`);
            validated = await validateReportBatch(
              readyEvidence.evidenceId,
              readyEvidence.outputDir,
              generated,
              run.controller.signal,
            );
            if (!isCurrent(run)) return;
            if (
              validated.evidenceId !== readyEvidence.evidenceId
              || validated.batchId !== batchId
            ) {
              throw new CompetitorReportClientError(
                "INVALID_BRIDGE_RESPONSE",
                "本地报告服务返回了无效响应。",
              );
            }
            break;
          } catch (error) {
            if (!isCurrent(run)) return;
            if (attempt === 0 && isRetryableBatchError(error)) continue;
            throw error;
          }
        }
        if (!validated) return;
        completed.push(validated.batch);
        batchesRef.current = [...completed];
        run.completedBatchIds = completed.map(
          (batch) => batch.batchId as CompetitorBatchId,
        );
        setValidatedBatches([...completed]);
      } catch (error) {
        if (!isCurrent(run)) return;
        failRun(run, `${BATCH_LABELS[batchId]}失败：${safeReportError(error)}`, batchId);
        return;
      }
    }

    try {
      publishStage("saving", "报告批次均已通过校验，正在组装内部报告…");
      const readyReport = await assembleReport(
        readyEvidence.evidenceId,
        readyEvidence.outputDir,
        completed,
        run.controller.signal,
      );
      if (!isCurrent(run)) return;
      controllerRef.current = null;
      setStage("completed");
      setFailedBatchId(null);
      setErrorMessage("");
      setStatusMessage("洞察报告已生成，正在登记并封装成果包。");
      onCompleted?.(readyReport);
    } catch (error) {
      if (!isCurrent(run)) return;
      failRun(run, `报告组装失败：${safeReportError(error)}`, "assemble");
    }
  }, [
    credential,
    credentialRevision,
    failRun,
    isCurrent,
    model,
    modelId,
    onCompleted,
    onEvidencePaused,
    publishStage,
  ]);

  const analyzeEvidence = useCallback(async (request: CompetitorAnalysisRequest) => {
    const run = createRun();
    evidenceRef.current = null;
    batchesRef.current = [];
    run.evidenceId = null;
    run.completedBatchIds = [];
    setEvidence(null);
    setValidatedBatches([]);
    setRetryPreparing(false);
    setErrorMessage("");
    setFailedBatchId(null);
    publishStage("normalizing", "正在整理抓取数据和证据索引…");
    try {
      const readyEvidence = await analyzeScrapeArtifacts({
        taskId: request.taskId,
        platformId: request.platformId,
        inputKind: request.inputKind,
        outputDir: request.outputDir,
        dataPath: request.dataPath,
        excelPath: request.excelPath,
      }, run.controller.signal);
      if (!isCurrent(run)) return;
      evidenceRef.current = readyEvidence;
      run.evidenceId = readyEvidence.evidenceId;
      setEvidence(readyEvidence);
      publishStage("evidence-ready", "证据包已生成，正在检查 Agent 模型配置…");
      await runReportBatches(run, readyEvidence, []);
    } catch (error) {
      if (!isCurrent(run)) return;
      failRun(run, safeReportError(error), null);
    }
  }, [createRun, failRun, isCurrent, publishStage, runReportBatches]);

  const retryReport = useCallback(async () => {
    const readyEvidence = evidenceRef.current;
    if (
      !readyEvidence
      || ACTIVE_STAGES.has(stage)
      || stage === "completed"
      || retryBlocked
      || retryPreparing
    ) return;
    setRetryPreparing(true);
    try {
      if (onBeforeRetry && !(await onBeforeRetry())) return;
      if (evidenceRef.current !== readyEvidence) return;
      const run = createRun();
      setErrorMessage("");
      setFailedBatchId(null);
      publishStage("evidence-ready", "证据包已保留，正在从未完成批次继续…");
      await runReportBatches(run, readyEvidence, batchesRef.current);
    } finally {
      setRetryPreparing(false);
    }
  }, [
    createRun,
    onBeforeRetry,
    publishStage,
    retryBlocked,
    retryPreparing,
    runReportBatches,
    stage,
  ]);

  const stopReport = useCallback(async () => {
    if (!ACTIVE_STAGES.has(stage)) return;
    tokenRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setErrorMessage("");
    setFailedBatchId(null);
    const message = evidenceRef.current
      ? "已停止；证据包已保留，可从未完成批次继续。"
      : "已停止本次抓取成果分析。";
    setStatusMessage(message);
    if (evidenceRef.current) {
      setRetryPreparing(true);
      setStatusMessage("模型请求已停止，正在同步停止状态…");
      const persisted = onStopped ? await onStopped(message) : true;
      setStage("stopped");
      setStatusMessage(
        persisted
          ? message
          : "已停止生成，但任务状态同步失败；请检查本地任务服务。",
      );
      setRetryPreparing(false);
    } else {
      setStage("stopped");
      onPreEvidenceTerminated?.("stopped", message);
    }
  }, [onPreEvidenceTerminated, onStopped, stage]);

  useEffect(() => {
    if (!analysisRequest || analysisRequest.requestId === lastAnalysisRequestRef.current) return;
    lastAnalysisRequestRef.current = analysisRequest.requestId;
    void analyzeEvidence(analysisRequest);
  }, [analysisRequest, analyzeEvidence]);

  useEffect(() => {
    const previous = previousModelRef.current;
    previousModelRef.current = {modelId, credentialRevision};
    if (
      previous.modelId === modelId
      && previous.credentialRevision === credentialRevision
    ) return;
    if (!controllerRef.current) return;
    tokenRef.current += 1;
    controllerRef.current.abort();
    controllerRef.current = null;
    batchesRef.current = [];
    setValidatedBatches([]);
    setErrorMessage("");
    setFailedBatchId(null);
    if (evidenceRef.current) {
      publishStage(
        "evidence-ready",
        "模型或凭据已变化；证据包已保留，请使用新配置重新生成报告。",
      );
    } else {
      const message = "模型或凭据已变化，本次整理请求已停止。";
      setStage("stopped");
      setStatusMessage(message);
      onPreEvidenceTerminated?.("model-config-changed", message);
    }
  }, [
    credentialRevision,
    modelId,
    onPreEvidenceTerminated,
    publishStage,
  ]);

  useEffect(
    () => () => {
      tokenRef.current += 1;
      controllerRef.current?.abort();
    },
    [],
  );

  const active = ACTIVE_STAGES.has(stage);
  const canRetry = Boolean(evidence) && !active && stage !== "completed";
  const expectedBatchCount = evidence ? batchIdsForEvidence(evidence).length : 0;

  return (
    <section className="competitor-report-runner" aria-label="竞品报告控制器">
      <div
        aria-label="竞品报告生成状态"
        aria-live="polite"
        className={`competitor-report-status ${stage}`}
        role="status"
      >
        <div>
          <strong>{stageTitle(stage)}</strong>
          <p>{statusMessage}</p>
        </div>
        <div className="competitor-report-actions">
          {active ? <button onClick={() => void stopReport()} type="button">停止生成</button> : null}
          {canRetry ? (
            <button
              disabled={retryBlocked || retryPreparing}
              onClick={() => void retryReport()}
              type="button"
            >
              {stage === "evidence-ready" ? "继续生成报告" : "重试失败批次"}
            </button>
          ) : null}
        </div>
      </div>

      {evidence ? (
        <section className="competitor-evidence-summary" aria-label="证据包完整性摘要">
          <div><span>分析对象</span><strong>{evidence.subjectName}</strong></div>
          <div><span>证据会话</span><code>{evidence.evidenceId}</code></div>
          <div>
            <span>已完成批次</span>
            <strong>{validatedBatches.length} / {expectedBatchCount}</strong>
          </div>
          <p>样本数：{evidence.itemCount}；公开数据不等于成交、销量或真实用户规模，需人工复核。</p>
        </section>
      ) : null}

      {errorMessage ? (
        <div className="competitor-report-error" role="alert">
          <strong>{failedBatchId ? "可安全重试" : "未完成请求"}</strong>
          <p>{errorMessage}</p>
        </div>
      ) : null}
    </section>
  );
}

function batchIdsForEvidence(evidence: EvidenceReadyResponse): readonly CompetitorBatchId[] {
  return evidence.inputKind === "content" ? CONTENT_BATCH_IDS : ACCOUNT_BATCH_IDS;
}

function sameBatchIds(
  current: readonly CompetitorBatchId[],
  expected: readonly CompetitorBatchId[],
): boolean {
  return current.length === expected.length
    && current.every((batchId, index) => batchId === expected[index]);
}

function isRetryableBatchError(error: unknown): boolean {
  return (
    error instanceof CompetitorReportRuntimeError
    && error.code === "INVALID_MODEL_OUTPUT"
  ) || (
    error instanceof CompetitorReportClientError
    && error.code === "INVALID_SECTION"
  );
}

function safeReportError(error: unknown): string {
  if (
    error instanceof CompetitorReportClientError
    || error instanceof CompetitorReportRuntimeError
  ) return error.message;
  if (error instanceof DOMException && error.name === "AbortError") {
    return "本次生成已取消。";
  }
  return "报告处理失败，请检查本地服务和模型连接后重试。";
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stageTitle(stage: ReportStage): string {
  const titles: Record<ReportStage, string> = {
    idle: "等待开始",
    normalizing: "正在整理抓取数据",
    "evidence-ready": "证据包已生成",
    generating: "正在生成报告批次",
    validating: "正在校验证据引用",
    saving: "正在组装内部报告",
    completed: "洞察报告已生成",
    failed: "报告生成失败",
    stopped: "已停止",
  };
  return titles[stage];
}
