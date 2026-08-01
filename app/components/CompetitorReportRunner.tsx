"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  analyzeReportPath,
  analyzeReportUpload,
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

export type CompetitorReportPathRequest = {
  requestId: number;
  excelPath: string;
};

export type ReportStage =
  | "idle"
  | "reading"
  | "calculating"
  | "evidence-ready"
  | "generating"
  | "validating"
  | "saving"
  | "completed"
  | "failed"
  | "stopped";

type RunContext = {
  token: number;
  controller: AbortController;
  modelId: string | null;
  credentialRevision: string;
  evidenceId: string | null;
  completedBatchIds: CompetitorBatchId[];
};

const BATCH_IDS: readonly CompetitorBatchId[] = [
  "strategy",
  "performance",
  "execution",
];
const BATCH_LABELS: Record<CompetitorBatchId, string> = {
  strategy: "战略判断批次",
  performance: "数据表现批次",
  execution: "执行方案批次",
};
const STAGE_ITEMS = [
  ["reading", "读取 Excel"],
  ["calculating", "计算证据"],
  ["generating", "生成三批"],
  ["validating", "校验章节"],
  ["saving", "保存报告"],
] as const;
const ACTIVE_STAGES = new Set<ReportStage>([
  "reading",
  "calculating",
  "generating",
  "validating",
  "saving",
]);
const MAX_EXCEL_BYTES = 50 * 1024 * 1024;

export function CompetitorReportRunner({
  onCompleted,
  onEvidencePaused,
  onFailed,
  pathRequest,
}: {
  onCompleted?: (report: ReportReadyResponse) => void;
  onEvidencePaused?: (evidence: EvidenceReadyResponse) => void;
  onFailed?: (message: string) => void;
  pathRequest: CompetitorReportPathRequest | null;
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
  const credentialRevision = model
    ? getCredentialRevision(model.id)
    : "";

  const [stage, setStage] = useState<ReportStage>("idle");
  const [lastProgressStage, setLastProgressStage] =
    useState<ReportStage>("idle");
  const [statusMessage, setStatusMessage] = useState(
    "可抓取抖音账号，或选择已有 .xlsx 文件。",
  );
  const [errorMessage, setErrorMessage] = useState("");
  const [failedBatchId, setFailedBatchId] =
    useState<CompetitorBatchId | "assemble" | null>(null);
  const [evidence, setEvidence] = useState<EvidenceReadyResponse | null>(null);
  const [validatedBatches, setValidatedBatches] = useState<
    Record<string, unknown>[]
  >([]);
  const [report, setReport] = useState<ReportReadyResponse | null>(null);
  const [copyMessage, setCopyMessage] = useState("");

  const tokenRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const liveModelRef = useRef({ modelId, credentialRevision });
  const evidenceRef = useRef<EvidenceReadyResponse | null>(null);
  const batchesRef = useRef<Record<string, unknown>[]>([]);
  const previousModelRef = useRef({ modelId, credentialRevision });
  const lastPathRequestRef = useRef(0);

  const setReportStage = useCallback((nextStage: ReportStage) => {
    if (nextStage !== "failed" && nextStage !== "stopped") {
      setLastProgressStage(nextStage);
    }
    setStage(nextStage);
  }, []);

  useLayoutEffect(() => {
    liveModelRef.current = { modelId, credentialRevision };
  }, [credentialRevision, modelId]);

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
    setReportStage("failed");
    setFailedBatchId(failed);
    setErrorMessage(message);
    setStatusMessage("本次报告未完成，已保留证据包和通过校验的批次。");
    onFailed?.(message);
  }, [isCurrent, onFailed, setReportStage]);

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
      setReportStage("evidence-ready");
      setStatusMessage(
        "证据包已生成；请先在 Agent 配置中选择已连接且已保存凭据的模型。",
      );
      onEvidencePaused?.(readyEvidence);
      return;
    }

    const completed = [...startingBatches];
    for (let index = completed.length; index < BATCH_IDS.length; index += 1) {
      const batchId = BATCH_IDS[index];
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
            setReportStage("generating");
            setStatusMessage(
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

            setReportStage("validating");
            setStatusMessage(`正在校验${BATCH_LABELS[batchId]}的证据引用…`);
            validated = await validateReportBatch(
              readyEvidence.evidenceId,
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
            if (attempt === 0 && isRetryableBatchError(error)) {
              continue;
            }
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
        failRun(
          run,
          `${BATCH_LABELS[batchId]}失败：${safeReportError(error)}`,
          batchId,
        );
        return;
      }
    }

    try {
      setReportStage("saving");
      setStatusMessage("三批章节均已通过校验，正在组装并保存 Markdown…");
      const readyReport = await assembleReport(
        readyEvidence.evidenceId,
        completed,
        run.controller.signal,
      );
      if (!isCurrent(run)) return;
      controllerRef.current = null;
      setReport(readyReport);
      setReportStage("completed");
      setFailedBatchId(null);
      setErrorMessage("");
      setStatusMessage("报告已完成；预览和下载来自同一次组装响应。");
      onCompleted?.(readyReport);
    } catch (error) {
      if (!isCurrent(run)) return;
      failRun(
        run,
        `报告组装失败：${safeReportError(error)}`,
        "assemble",
      );
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
    setReportStage,
  ]);

  const analyzeEvidence = useCallback(async (
    load: (signal: AbortSignal) => Promise<EvidenceReadyResponse>,
    sourceStage: "reading" | "calculating",
  ) => {
    const run = createRun();
    evidenceRef.current = null;
    batchesRef.current = [];
    run.evidenceId = null;
    run.completedBatchIds = [];
    setEvidence(null);
    setValidatedBatches([]);
    setReport(null);
    setCopyMessage("");
    setErrorMessage("");
    setFailedBatchId(null);
    setReportStage(sourceStage);
    setStatusMessage(
      sourceStage === "reading"
        ? "正在读取并安全编码 Excel…"
        : "正在计算账号指标和证据索引…",
    );
    try {
      const readyEvidence = await load(run.controller.signal);
      if (!isCurrent(run)) return;
      evidenceRef.current = readyEvidence;
      run.evidenceId = readyEvidence.evidenceId;
      setEvidence(readyEvidence);
      setReportStage("evidence-ready");
      setStatusMessage("证据包已生成，正在检查 Agent 模型配置…");
      await runReportBatches(run, readyEvidence, []);
    } catch (error) {
      if (!isCurrent(run)) return;
      failRun(run, safeReportError(error), null);
    }
  }, [createRun, failRun, isCurrent, runReportBatches, setReportStage]);

  const retryReport = useCallback(() => {
    const readyEvidence = evidenceRef.current;
    if (!readyEvidence || ACTIVE_STAGES.has(stage) || stage === "completed") {
      return;
    }
    const run = createRun();
    setErrorMessage("");
    setFailedBatchId(null);
    setReport(null);
    setCopyMessage("");
    setReportStage("evidence-ready");
    setStatusMessage("证据包已保留，正在从未完成批次继续…");
    void runReportBatches(run, readyEvidence, batchesRef.current);
  }, [createRun, runReportBatches, setReportStage, stage]);

  const stopReport = useCallback(() => {
    if (!ACTIVE_STAGES.has(stage)) return;
    tokenRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setReportStage("stopped");
    setErrorMessage("");
    setFailedBatchId(null);
    setStatusMessage(
      evidenceRef.current
        ? "已停止；证据包已保留，可从未完成批次继续。"
        : "已停止本次 Excel 分析。",
    );
  }, [setReportStage, stage]);

  const failFileSelection = useCallback((message: string) => {
    tokenRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    evidenceRef.current = null;
    batchesRef.current = [];
    setEvidence(null);
    setValidatedBatches([]);
    setReport(null);
    setCopyMessage("");
    setFailedBatchId(null);
    setErrorMessage(message);
    setLastProgressStage("idle");
    setReportStage("failed");
    setStatusMessage("新选文件未通过校验，未复用上一次证据或报告。");
  }, [setReportStage]);

  const selectExcel = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file) return;
    if (!/\.xlsx$/iu.test(file.name)) {
      failFileSelection("仅支持 .xlsx 文件，请重新选择。");
      return;
    }
    if (file.size > MAX_EXCEL_BYTES) {
      failFileSelection("Excel 文件超过 50 MB 上限，未发送任何请求。");
      return;
    }
    void analyzeEvidence(
      (signal) => analyzeReportUpload(file, signal),
      "reading",
    );
  }, [analyzeEvidence, failFileSelection]);

  const copyReportPath = useCallback(async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report.reportPath);
      setCopyMessage("报告绝对路径已复制。");
    } catch {
      setCopyMessage("复制失败，请手动选择报告路径。");
    }
  }, [report]);

  useEffect(() => {
    if (
      !pathRequest
      || pathRequest.requestId === lastPathRequestRef.current
    ) {
      return;
    }
    lastPathRequestRef.current = pathRequest.requestId;
    void analyzeEvidence(
      (signal) => analyzeReportPath(pathRequest.excelPath, signal),
      "calculating",
    );
  }, [analyzeEvidence, pathRequest]);

  useEffect(() => {
    const previous = previousModelRef.current;
    previousModelRef.current = { modelId, credentialRevision };
    if (
      previous.modelId === modelId
      && previous.credentialRevision === credentialRevision
    ) {
      return;
    }
    if (!controllerRef.current) return;
    tokenRef.current += 1;
    controllerRef.current.abort();
    controllerRef.current = null;
    batchesRef.current = [];
    setValidatedBatches([]);
    setReport(null);
    setErrorMessage("");
    setFailedBatchId(null);
    if (evidenceRef.current) {
      setReportStage("evidence-ready");
      setStatusMessage(
        "模型或凭据已变化；证据包已保留，请使用新配置重新生成三批报告。",
      );
    } else {
      setReportStage("stopped");
      setStatusMessage("模型配置已变化，本次迟到响应已丢弃。");
    }
  }, [credentialRevision, modelId, setReportStage]);

  useEffect(
    () => () => {
      tokenRef.current += 1;
      controllerRef.current?.abort();
    },
    [],
  );

  const active = ACTIVE_STAGES.has(stage);
  const displayedProgressStage = stage === "failed" || stage === "stopped"
    ? lastProgressStage
    : stage;
  const canRetry = Boolean(evidence) && !active && stage !== "completed";
  const completedBatchIds = validatedBatches.map(
    (batch) => batch.batchId as string,
  );
  const missingFields = safeStringArray(evidence?.completeness.missingFields);
  const warnings = safeStringArray(evidence?.completeness.warnings);
  const nickname =
    typeof evidence?.account.nickname === "string"
      ? evidence.account.nickname
      : "未命名账号";

  return (
    <section className="competitor-report-runner" aria-labelledby="competitor-report-title">
      <div className="competitor-report-heading">
        <div>
          <span className="panel-label">第二入口</span>
          <h3 id="competitor-report-title">分析已有 Excel</h3>
          <p>仅支持抖音账号 `.xlsx`，单文件上限 50 MB。</p>
        </div>
        <label className={`competitor-upload-button${active ? " disabled" : ""}`}>
          选择已有 Excel 文件
          <input
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            aria-label="选择已有 Excel 文件"
            disabled={active}
            onChange={selectExcel}
            type="file"
          />
        </label>
      </div>

      <ol className="competitor-report-stages" aria-label="竞品报告五阶段">
        {STAGE_ITEMS.map(([stageId, label], index) => (
          <li
            aria-current={stageClass(displayedProgressStage, stageId) === "current" ? "step" : undefined}
            aria-label={`${label}（${stageStateLabel(displayedProgressStage, stageId)}）`}
            className={stageClass(displayedProgressStage, stageId)}
            key={stageId}
          >
            <span>{index + 1}</span>
            {label}
          </li>
        ))}
      </ol>

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
          {active ? (
            <button onClick={stopReport} type="button">停止生成</button>
          ) : null}
          {canRetry ? (
            <button onClick={retryReport} type="button">
              {stage === "evidence-ready" ? "继续生成报告" : "重试失败批次"}
            </button>
          ) : null}
        </div>
      </div>

      {evidence ? (
        <section className="competitor-evidence-summary" aria-label="证据包完整性摘要">
          <div>
            <span>账号</span>
            <strong>{nickname}</strong>
          </div>
          <div>
            <span>证据会话</span>
            <code>{evidence.evidenceId}</code>
          </div>
          <div>
            <span>已完成批次</span>
            <strong>{completedBatchIds.length} / 3</strong>
          </div>
          <p>
            缺失字段：{missingFields.length ? missingFields.join("、") : "无"}
          </p>
          <p>
            数据提醒：{warnings.length ? warnings.join("；") : "公开数据需人工复核"}
          </p>
        </section>
      ) : null}

      {errorMessage ? (
        <div className="competitor-report-error" role="alert">
          <strong>{failedBatchId ? "可安全重试" : "未完成请求"}</strong>
          <p>{errorMessage}</p>
        </div>
      ) : null}

      {report ? (
        <ReportPreview
          copyMessage={copyMessage}
          onCopy={copyReportPath}
          report={report}
        />
      ) : null}
    </section>
  );
}

function ReportPreview({
  copyMessage,
  onCopy,
  report,
}: {
  copyMessage: string;
  onCopy: () => Promise<void>;
  report: ReportReadyResponse;
}) {
  const downloadRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    const anchor = downloadRef.current;
    if (!anchor) return undefined;
    const nextUrl = URL.createObjectURL(
      new Blob([report.markdown], { type: "text/markdown;charset=utf-8" }),
    );
    anchor.href = nextUrl;
    return () => {
      if (anchor.getAttribute("href") === nextUrl) {
        anchor.removeAttribute("href");
      }
      URL.revokeObjectURL(nextUrl);
    };
  }, [report.markdown]);

  return (
    <section
      aria-label="Markdown 报告预览"
      className="competitor-report-preview"
    >
      <div className="competitor-report-preview-heading">
        <div>
          <span className="panel-label">本地报告</span>
          <h3>Markdown 报告预览</h3>
        </div>
        <a download={report.filename} ref={downloadRef}>下载 Markdown</a>
      </div>
      <pre>{report.markdown}</pre>
      <div className="competitor-report-path">
        <code>{report.reportPath}</code>
        <button onClick={() => void onCopy()} type="button">
          复制报告路径
        </button>
      </div>
      {copyMessage ? (
        <p aria-live="polite" className="competitor-copy-message">
          {copyMessage}
        </p>
      ) : null}
    </section>
  );
}

function sameBatchIds(
  current: readonly CompetitorBatchId[],
  expected: readonly CompetitorBatchId[],
): boolean {
  return (
    current.length === expected.length
    && current.every((batchId, index) => batchId === expected[index])
  );
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
  ) {
    return error.message;
  }
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

function safeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
      .filter((item): item is string => typeof item === "string")
      .slice(0, 20)
    : [];
}

function stageTitle(stage: ReportStage): string {
  const titles: Record<ReportStage, string> = {
    idle: "等待开始",
    reading: "正在读取 Excel",
    calculating: "正在计算证据",
    "evidence-ready": "证据包已生成",
    generating: "正在生成报告批次",
    validating: "正在校验证据引用",
    saving: "正在保存 Markdown",
    completed: "报告已完成",
    failed: "报告生成失败",
    stopped: "已停止",
  };
  return titles[stage];
}

function stageClass(
  current: ReportStage,
  stageId: (typeof STAGE_ITEMS)[number][0],
): string {
  const order = STAGE_ITEMS.map(([id]) => id);
  const normalized = current === "idle"
    ? -1
    : current === "evidence-ready"
      ? 2
      : current === "completed"
        ? order.length
        : current === "failed" || current === "stopped"
          ? -1
          : order.indexOf(current as (typeof order)[number]);
  const index = order.indexOf(stageId);
  return index < normalized ? "completed" : index === normalized ? "current" : "";
}

function stageStateLabel(
  current: ReportStage,
  stageId: (typeof STAGE_ITEMS)[number][0],
): "已完成" | "当前" | "未开始" {
  const className = stageClass(current, stageId);
  if (className === "completed") return "已完成";
  if (className === "current") return "当前";
  return "未开始";
}
