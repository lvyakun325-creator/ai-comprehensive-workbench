"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  COMPETITOR_PLATFORM_ROUTES,
  detectCompetitorPlatform,
  type CompetitorBundleCategory,
} from "../lib/competitor-platform-router.mjs";
import {
  CompetitorReportRunner,
  type CompetitorAnalysisRequest,
  type PreEvidenceTerminationReason,
  type ReportWorkflowStage,
} from "./CompetitorReportRunner";
import {
  createCompetitorTask,
  createCompetitorTaskId,
  finalizeCompetitorBundle,
  registerCompetitorArtifacts,
  updateCompetitorTask,
  type CompetitorTaskPatch,
} from "../lib/competitor-project-records-client";
import {
  scrapeCompetitorLink,
  ScrapeClientError,
  type ScrapeReadyResponse,
} from "../lib/competitor-scrape-client";
import type { ReportReadyResponse } from "../lib/competitor-report-client";

type CompetitorInsightPanelProps = {
  mode: "overview" | "run";
  onPreview: (message: string) => void;
  onStart?: () => void;
  onRecordsChanged?: () => void;
  onTaskCompleted?: (taskId: string, bundleId: string) => void;
};

type PendingAnalysis = {
  taskId: string;
  scrape: ScrapeReadyResponse | null;
  epoch: number;
  evidenceReady: boolean;
  terminalWriteStarted: boolean;
};

type AnalysisTaskPatch = CompetitorTaskPatch & {
  inputKind?: "account" | "content";
  category?: CompetitorBundleCategory;
};

const WORKFLOW = [
  "识别平台",
  "调用抓取 Skill",
  "整理账号数据",
  "生成洞察报告",
  "整理成果包",
] as const;

type AnalysisPhase =
  | "idle"
  | "connecting"
  | "scraping"
  | "normalizing"
  | "generating"
  | "bundling"
  | "completed"
  | "failed";

type WorkflowStepStatus = "pending" | "active" | "completed" | "failed";

function getWorkflowStepStatuses(
  phase: AnalysisPhase,
  lastActivePhase: AnalysisPhase,
  platformReady: boolean,
): WorkflowStepStatus[] {
  const statuses: WorkflowStepStatus[] = Array.from({length: WORKFLOW.length}, () => "pending");
  if (platformReady) statuses[0] = "completed";
  const sourcePhase = phase === "failed" ? lastActivePhase : phase;
  const activeIndex = workflowIndex(sourcePhase);
  if (activeIndex < 0) return statuses;
  for (let index = 0; index < activeIndex; index += 1) statuses[index] = "completed";
  if (sourcePhase === "completed") {
    statuses.fill("completed");
  } else {
    statuses[activeIndex] = phase === "failed" ? "failed" : "active";
  }
  return statuses;
}

function getAnalysisProgress(
  phase: AnalysisPhase,
  lastActivePhase: AnalysisPhase,
  platformReady: boolean,
  message: string,
) {
  const sourcePhase = phase === "failed" ? lastActivePhase : phase;
  const step = workflowIndex(sourcePhase) + 1;
  if (message) return {step, message};
  if (phase === "completed") return {step: 5, message: "成果包已就绪"};
  return platformReady
    ? {step: 1, message: "平台已识别，等待开始"}
    : {step: 0, message: "等待识别平台"};
}

function workflowIndex(phase: AnalysisPhase): number {
  if (phase === "connecting" || phase === "scraping") return 1;
  if (phase === "normalizing") return 2;
  if (phase === "generating") return 3;
  if (phase === "bundling") return 4;
  if (phase === "completed") return 4;
  return -1;
}

export function CompetitorInsightPanel({
  mode,
  onPreview,
  onStart,
  onRecordsChanged,
  onTaskCompleted,
}: CompetitorInsightPanelProps) {
  const [source, setSource] = useState("");
  const [analysisMessage, setAnalysisMessage] = useState("");
  const [isDispatching, setIsDispatching] = useState(false);
  const [analysisPhase, setAnalysisPhase] = useState<AnalysisPhase>("idle");
  const [lastActivePhase, setLastActivePhase] = useState<AnalysisPhase>("idle");
  const [analysisRequest, setAnalysisRequest] =
    useState<CompetitorAnalysisRequest | null>(null);
  const [isTaskStateSettling, setIsTaskStateSettling] = useState(false);
  const pendingAnalysisRef = useRef<PendingAnalysis | null>(null);
  const mountedRef = useRef(false);
  const runEpochRef = useRef(0);
  const taskWriteTailsRef = useRef(new Map<string, Promise<void>>());
  const detection = useMemo(() => detectCompetitorPlatform(source), [source]);
  const platformReady = detection.kind === "ready";
  const workflowStepStatuses = getWorkflowStepStatuses(
    analysisPhase,
    lastActivePhase,
    platformReady,
  );
  const analysisProgress = getAnalysisProgress(
    analysisPhase,
    lastActivePhase,
    platformReady,
    analysisMessage,
  );

  const moveToPhase = (phase: AnalysisPhase, message: string) => {
    if (!mountedRef.current) return;
    if (phase !== "failed") setLastActivePhase(phase);
    setAnalysisPhase(phase);
    setAnalysisMessage(message);
  };

  const isMountedEpoch = (epoch: number) =>
    mountedRef.current && runEpochRef.current === epoch;

  const isCurrentPending = (pending: PendingAnalysis) =>
    isMountedEpoch(pending.epoch)
    && pendingAnalysisRef.current?.epoch === pending.epoch
    && pendingAnalysisRef.current.taskId === pending.taskId;

  const writeTaskState = async (taskId: string, patch: AnalysisTaskPatch) => {
    const previous = taskWriteTailsRef.current.get(taskId) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(async () => {
      await updateCompetitorTask(taskId, patch);
    });
    const tail = write.then(() => undefined, () => undefined);
    taskWriteTailsRef.current.set(taskId, tail);
    try {
      await write;
    } finally {
      if (taskWriteTailsRef.current.get(taskId) === tail) {
        taskWriteTailsRef.current.delete(taskId);
      }
    }
  };

  const settleAbandonedTask = (taskId: string) => {
    void writeTaskState(taskId, {
      status: "failed",
      errorSummary: "页面已关闭，本次竞品分析已取消。",
    }).catch(() => undefined);
  };

  const settleAbandonedPending = (pending: PendingAnalysis) => {
    if (pending.terminalWriteStarted) return;
    pending.terminalWriteStarted = true;
    settleAbandonedTask(pending.taskId);
  };

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      const pending = pendingAnalysisRef.current;
      mountedRef.current = false;
      runEpochRef.current += 1;
      pendingAnalysisRef.current = null;
      if (
        pending
        && !pending.evidenceReady
        && !pending.terminalWriteStarted
      ) {
        settleAbandonedPending(pending);
      }
    };
  }, []);

  const failPersistedTask = async (taskId: string | null, errorSummary: string) => {
    if (!taskId) return;
    await writeTaskState(taskId, {status: "failed", errorSummary});
  };

  const failAnalysis = async (
    taskId: string | null,
    message: string,
    epoch = runEpochRef.current,
    clearPending = false,
  ) => {
    if (!isMountedEpoch(epoch)) return;
    if (!taskId) {
      setIsDispatching(false);
      moveToPhase("failed", message);
      return;
    }
    if (pendingAnalysisRef.current?.epoch === epoch) {
      pendingAnalysisRef.current.terminalWriteStarted = true;
    }
    setIsTaskStateSettling(true);
    setIsDispatching(true);
    moveToPhase("failed", `${message} 正在同步失败状态…`);
    try {
      await failPersistedTask(taskId, message);
      if (!isMountedEpoch(epoch)) return;
      onRecordsChanged?.();
      if (clearPending && pendingAnalysisRef.current?.epoch === epoch) {
        pendingAnalysisRef.current = null;
      }
      setIsTaskStateSettling(false);
      setIsDispatching(false);
      moveToPhase("failed", message);
    } catch {
      if (!isMountedEpoch(epoch)) return;
      setIsTaskStateSettling(true);
      setIsDispatching(false);
      moveToPhase("failed", `${message} 任务终态同步失败，请检查本地任务服务。`);
    }
  };

  const handleReportStageChange = (stage: ReportWorkflowStage, message: string) => {
    if (!mountedRef.current) return;
    if (stage === "generating" && pendingAnalysisRef.current) {
      pendingAnalysisRef.current.evidenceReady = true;
    }
    const nextPhase: AnalysisPhase = stage === "normalizing" ? "normalizing" : "generating";
    setIsDispatching(true);
    moveToPhase(nextPhase, message);
  };

  const preparePendingRetry = async (): Promise<boolean> => {
    const pending = pendingAnalysisRef.current;
    if (!pending || !isCurrentPending(pending) || isTaskStateSettling) return false;
    if (pending.terminalWriteStarted) {
      await submit();
      return false;
    }
    setIsTaskStateSettling(true);
    setIsDispatching(true);
    moveToPhase("generating", "正在恢复任务状态，完成后继续生成报告…");
    try {
      await writeTaskState(pending.taskId, {
        status: "running",
        progress: 70,
        currentStep: "任务状态已恢复，继续生成洞察报告",
        errorSummary: null,
      });
      if (!isCurrentPending(pending)) return false;
      setIsTaskStateSettling(false);
      onRecordsChanged?.();
      return true;
    } catch {
      if (!isCurrentPending(pending)) return false;
      setIsTaskStateSettling(false);
      setIsDispatching(false);
      moveToPhase("failed", "任务状态恢复失败，请检查本地任务服务后重试。");
      return false;
    }
  };

  const terminatePreEvidence = async (
    reason: PreEvidenceTerminationReason,
    message: string,
  ) => {
    const pending = pendingAnalysisRef.current;
    if (!pending || !isCurrentPending(pending)) return;
    const safeMessage = reason === "stopped"
      ? "竞品分析已停止，未生成证据包。"
      : message;
    await failAnalysis(pending.taskId, safeMessage, pending.epoch, true);
  };

  const pausePendingReport = async () => {
    const pending = pendingAnalysisRef.current;
    if (!pending || !isCurrentPending(pending)) return;
    try {
      await writeTaskState(pending.taskId, {
        status: "running",
        progress: 70,
        currentStep: "证据包已生成，等待配置模型",
      });
      if (!isCurrentPending(pending)) return;
      onRecordsChanged?.();
    } catch {
      if (!isCurrentPending(pending)) return;
      setAnalysisMessage("证据包已生成，但任务状态同步失败，请检查本地任务服务。");
    }
  };

  const stopPendingReport = async (message: string): Promise<boolean> => {
    const pending = pendingAnalysisRef.current;
    if (!pending || !isCurrentPending(pending)) return false;
    pending.terminalWriteStarted = true;
    setIsTaskStateSettling(true);
    setIsDispatching(true);
    moveToPhase("generating", "模型请求已停止，正在同步停止状态…");
    try {
      await writeTaskState(pending.taskId, {
        status: "stopped",
        progress: 70,
        currentStep: "用户已停止报告生成",
        errorSummary: null,
      });
      if (!isCurrentPending(pending)) return false;
      onRecordsChanged?.();
      setIsTaskStateSettling(false);
      setIsDispatching(false);
      moveToPhase("failed", message);
      return true;
    } catch {
      if (!isCurrentPending(pending)) return false;
      setIsTaskStateSettling(true);
      setIsDispatching(true);
      moveToPhase("failed", "已停止生成，但任务状态同步失败，请检查本地任务服务。链接入口保持锁定。");
      return false;
    }
  };

  const completePendingReport = async (report: ReportReadyResponse) => {
    const pending = pendingAnalysisRef.current;
    if (!pending || !pending.scrape || !isCurrentPending(pending)) return;
    const {taskId, scrape} = pending;
    const explicitPaths = Array.from(new Set([...scrape.explicitPaths, report.reportPath]));
    moveToPhase("bundling", "报告已生成，正在登记内部产物并封装成果包…");
    try {
      await registerCompetitorArtifacts(taskId, {
        outputDir: scrape.outputDir,
        explicitPaths,
      });
      if (!isCurrentPending(pending)) return;
      onRecordsChanged?.();
      const finalized = await finalizeCompetitorBundle(taskId, {
        platformId: scrape.platformId,
        inputKind: scrape.inputKind,
        category: scrape.category,
        outputDir: scrape.outputDir,
        primaryReportPath: report.reportPath,
        explicitPaths,
        subjectName: scrape.subjectName,
        itemCount: scrape.itemCount,
      });
      if (!isCurrentPending(pending)) return;
      if (finalized.bundle.status !== "ready") {
        throw new Error("bundle_not_ready");
      }
      pendingAnalysisRef.current = null;
      setIsTaskStateSettling(false);
      setIsDispatching(false);
      moveToPhase("completed", "成果包已就绪，可在成果页查看。");
      onRecordsChanged?.();
      onPreview("竞品洞察成果包已就绪");
      onTaskCompleted?.(taskId, finalized.bundle.id);
    } catch {
      await failAnalysis(
        taskId,
        "报告已生成，但成果登记或封装失败，请检查本地任务服务。",
        pending.epoch,
      );
    }
  };

  async function submit() {
    if (
      detection.kind !== "ready"
      || !detection.platformId
      || !detection.skillId
      || !detection.bridgeUrl
    ) {
      setAnalysisMessage(detection.message);
      return;
    }
    const route = COMPETITOR_PLATFORM_ROUTES.find((item) => item.id === detection.platformId);
    if (!route) {
      setAnalysisMessage("未找到对应的本地抓取 Skill。");
      return;
    }

    const routeMessage = `已自动路由：${detection.platformLabel} → ${detection.skillId}`;
    const epoch = runEpochRef.current + 1;
    runEpochRef.current = epoch;
    let taskId: string | null = null;
    let pending: PendingAnalysis | null = null;
    setIsDispatching(true);
    setIsTaskStateSettling(false);
    pendingAnalysisRef.current = null;
    moveToPhase("connecting", `${routeMessage}。正在创建可追踪任务…`);
    try {
      const createdTask = await createCompetitorTask({
        id: createCompetitorTaskId(),
        title: `${detection.platformLabel}竞品洞察`,
        platformId: detection.platformId,
        platformLabel: detection.platformLabel,
        skillId: detection.skillId,
        sourceUrl: detection.normalizedUrl,
      });
      taskId = createdTask.id;
      pending = {
        taskId,
        scrape: null,
        epoch,
        evidenceReady: false,
        terminalWriteStarted: false,
      };
      if (!isMountedEpoch(epoch)) {
        settleAbandonedPending(pending);
        return;
      }
      pendingAnalysisRef.current = pending;
      onRecordsChanged?.();
      moveToPhase("scraping", `${routeMessage}。正在调用本地抓取 Skill…`);
      const scrape = await scrapeCompetitorLink(
        route,
        detection.normalizedUrl,
        taskId,
      );
      if (!isCurrentPending(pending)) {
        settleAbandonedPending(pending);
        return;
      }
      pending.scrape = scrape;

      const authoritativePatch = {
        status: "running" as const,
        progress: 45,
        currentStep: "抓取完成，链接类型与成果分类已确认",
        inputKind: scrape.inputKind,
        category: scrape.category as CompetitorBundleCategory,
      };
      await writeTaskState(taskId, authoritativePatch);
      if (!isCurrentPending(pending)) {
        settleAbandonedPending(pending);
        return;
      }
      onRecordsChanged?.();
      setAnalysisRequest((current) => ({
        requestId: (current?.requestId ?? 0) + 1,
        taskId: createdTask.id,
        platformId: scrape.platformId,
        inputKind: scrape.inputKind,
        outputDir: scrape.outputDir,
        dataPath: scrape.dataPath,
        excelPath: scrape.excelPath,
      }));
      moveToPhase("normalizing", "抓取完成，正在整理账号或作品数据…");
    } catch (error) {
      if (!isMountedEpoch(epoch)) {
        if (pending) settleAbandonedPending(pending);
        else if (taskId) settleAbandonedTask(taskId);
        return;
      }
      await failAnalysis(taskId, safeAnalysisError(error), epoch, true);
    }
  }

  return (
    <section className={`competitor-console ${mode}`} aria-labelledby="competitor-console-title">
      <header className="competitor-console-heading">
        <div>
          <span className="panel-label">{mode === "overview" ? "能力总览" : "竞品分析入口"}</span>
          <h2 id="competitor-console-title">
            {mode === "overview" ? "跨平台竞品洞察工作流" : "粘贴链接，自动抓取、分析并封装"}
          </h2>
          <p>链接是唯一入口；系统按平台调用本地 Skill，并在报告完整后生成成果包。</p>
        </div>
        <span className="competitor-live-badge">Agent 已启动</span>
      </header>

      <div className="competitor-capability-grid">
        {COMPETITOR_PLATFORM_ROUTES.map((route) => (
          <article className={`competitor-skill-card ${route.status}`} key={route.id}>
            <div><span>{route.label}</span><b>{route.status === "ready" ? "已接入" : "待接入"}</b></div>
            <strong>{route.skillId}</strong>
            <p>{route.status === "ready" ? "账号与作品链接均会进入证据分析和成果包流程" : "平台识别规则已预留，安装后自动启用"}</p>
          </article>
        ))}
      </div>

      <ol className="competitor-workflow" aria-label="竞品洞察处理流程">
        {WORKFLOW.map((step, index) => (
          <li
            aria-label={`${step}（${workflowStatusLabel(workflowStepStatuses[index])}）`}
            className={workflowStepStatuses[index]}
            key={step}
          >
            <span>{index + 1}</span>{step}
          </li>
        ))}
      </ol>

      {mode === "run" ? (
        <div
          aria-label="竞品分析进度"
          aria-live="polite"
          className={`competitor-capture-progress ${analysisPhase}`}
          role="status"
        >
          <strong>{analysisProgress.step > 0 ? `第 ${analysisProgress.step}/5 步` : "等待开始"}</strong>
          <span>{analysisProgress.message}</span>
        </div>
      ) : null}

      {mode === "run" ? (
        <>
          <form
            className="competitor-source-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label htmlFor="competitor-source">
              竞品主页或作品链接
              <textarea
                disabled={isDispatching}
                id="competitor-source"
                onChange={(event) => {
                  setSource(event.target.value);
                  setAnalysisMessage("");
                  setAnalysisPhase("idle");
                  setLastActivePhase("idle");
                }}
                placeholder="可直接粘贴抖音或小红书分享文字，系统会提取其中链接"
                value={source}
              />
            </label>
            <div
              aria-label="竞品平台识别状态"
              className={`competitor-detection ${detection.kind}`}
              role="status"
              aria-live="polite"
            >
              <span>{detection.platformLabel}</span>
              <p>{detection.message}</p>
              {detection.skillId ? <code>{detection.skillId}</code> : null}
            </div>
            <button
              className="competitor-dispatch-button"
              disabled={detection.kind === "empty" || isDispatching}
              type="submit"
            >
              {isDispatching ? "正在分析…" : "抓取并分析"}
            </button>
            {analysisMessage && analysisPhase === "failed" ? (
              <div className="competitor-dispatch-result failed" role="alert">{analysisMessage}</div>
            ) : null}
          </form>
          <CompetitorReportRunner
            analysisRequest={analysisRequest}
            onBeforeRetry={preparePendingRetry}
            onCompleted={(report) => void completePendingReport(report)}
            onEvidencePaused={() => void pausePendingReport()}
            onFailed={(message) => {
              const pending = pendingAnalysisRef.current;
              void failAnalysis(
                pending?.taskId ?? null,
                message,
                pending?.epoch ?? runEpochRef.current,
              );
            }}
            onPreEvidenceTerminated={(reason, message) => {
              void terminatePreEvidence(reason, message);
            }}
            onStopped={stopPendingReport}
            onStageChange={handleReportStageChange}
            retryBlocked={isTaskStateSettling}
          />
        </>
      ) : (
        <>
          <div className="competitor-overview-actions">
            <div>
              <strong>当前可执行：抖音与小红书链接分析</strong>
              <p>登录态只保存在本机；不会要求输入账号密码，也不会展示或导出 Cookie。</p>
            </div>
            <button onClick={onStart} type="button">开始竞品分析</button>
          </div>
          <div className="compliance-status data-review" role="status" aria-label="成果合规状态">
            <strong>数据口径确认</strong>
            <p>当前项目以经营分析为主，仍需人工确认数据口径。</p>
            <small>平台公开互动数据不等于成交、销量或真实用户规模。</small>
          </div>
        </>
      )}
    </section>
  );
}

function workflowStatusLabel(status: WorkflowStepStatus): string {
  if (status === "completed") return "已完成";
  if (status === "active") return "进行中";
  if (status === "failed") return "失败";
  return "未开始";
}

function safeAnalysisError(error: unknown): string {
  if (error instanceof ScrapeClientError) return error.message;
  if (error instanceof DOMException && error.name === "AbortError") return "本次竞品分析已取消。";
  return "竞品分析未完成，请检查本地抓取与任务服务后重试。";
}
