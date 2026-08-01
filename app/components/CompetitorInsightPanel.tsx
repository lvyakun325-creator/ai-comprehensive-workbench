"use client";

import { useMemo, useRef, useState } from "react";
import {
  COMPETITOR_PLATFORM_ROUTES,
  detectCompetitorPlatform,
} from "../lib/competitor-platform-router.mjs";
import {
  CompetitorReportRunner,
  type CompetitorReportPathRequest,
} from "./CompetitorReportRunner";
import {
  createCompetitorTask,
  createCompetitorTaskId,
  registerCompetitorArtifacts,
  updateCompetitorTask,
} from "../lib/competitor-project-records-client";
import type { ReportReadyResponse } from "../lib/competitor-report-client";

type CompetitorInsightPanelProps = {
  mode: "overview" | "run";
  onPreview: (message: string) => void;
  onStart?: () => void;
  onRecordsChanged?: () => void;
  onTaskCompleted?: (taskId: string) => void;
};

type PendingReportTask = {
  taskId: string;
  outputDir: string;
  explicitPaths: string[];
};

const WORKFLOW = ["识别平台", "连接本地 Skill", "抓取平台数据", "保存抓取结果"];

type DispatchPhase =
  | "idle"
  | "connecting"
  | "scraping"
  | "completed"
  | "connection-failed"
  | "scrape-failed";

type WorkflowStepStatus = "pending" | "active" | "completed" | "failed";

function getWorkflowStepStatuses(
  phase: DispatchPhase,
  platformReady: boolean,
): WorkflowStepStatus[] {
  const first: WorkflowStepStatus = platformReady ? "completed" : "pending";
  switch (phase) {
    case "connecting":
      return [first, "active", "pending", "pending"];
    case "scraping":
      return [first, "completed", "active", "pending"];
    case "completed":
      return ["completed", "completed", "completed", "completed"];
    case "connection-failed":
      return [first, "failed", "pending", "pending"];
    case "scrape-failed":
      return [first, "completed", "failed", "pending"];
    default:
      return [first, "pending", "pending", "pending"];
  }
}

function getDispatchProgress(phase: DispatchPhase, platformReady: boolean) {
  switch (phase) {
    case "connecting":
      return { step: 2, message: "正在连接本地 Skill" };
    case "scraping":
      return { step: 3, message: "正在抓取平台数据，请保持页面打开" };
    case "completed":
      return { step: 4, message: "抓取结果已保存" };
    case "connection-failed":
      return { step: 2, message: "连接失败" };
    case "scrape-failed":
      return { step: 3, message: "抓取失败" };
    default:
      return platformReady
        ? { step: 1, message: "平台已识别，等待开始" }
        : { step: 0, message: "等待识别平台" };
  }
}

export function CompetitorInsightPanel({
  mode,
  onPreview,
  onStart,
  onRecordsChanged,
  onTaskCompleted,
}: CompetitorInsightPanelProps) {
  const [source, setSource] = useState("");
  const [dispatchMessage, setDispatchMessage] = useState("");
  const [isDispatching, setIsDispatching] = useState(false);
  const [dispatchPhase, setDispatchPhase] = useState<DispatchPhase>("idle");
  const [reportPathRequest, setReportPathRequest] =
    useState<CompetitorReportPathRequest | null>(null);
  const pendingReportTaskRef = useRef<PendingReportTask | null>(null);
  const detection = useMemo(
    () => detectCompetitorPlatform(source),
    [source],
  );
  const platformReady = detection.kind === "ready";
  const workflowStepStatuses = getWorkflowStepStatuses(
    dispatchPhase,
    platformReady,
  );
  const dispatchProgress = getDispatchProgress(dispatchPhase, platformReady);

  const failPersistedTask = async (
    taskId: string | null,
    errorSummary: string,
  ) => {
    if (!taskId) return;
    try {
      await updateCompetitorTask(taskId, {
        status: "failed",
        errorSummary,
      });
      onRecordsChanged?.();
    } catch {
      // The original bridge failure remains the primary user-facing error.
    }
  };

  const completePendingReport = async (report: ReportReadyResponse) => {
    const pending = pendingReportTaskRef.current;
    if (!pending) return;
    pendingReportTaskRef.current = null;
    try {
      await registerCompetitorArtifacts(pending.taskId, {
        outputDir: pending.outputDir,
        explicitPaths: [...pending.explicitPaths, report.reportPath],
      });
      await updateCompetitorTask(pending.taskId, {
        status: "completed",
        progress: 100,
        currentStep: "账号报告与抓取成果已登记",
      });
      onRecordsChanged?.();
      onTaskCompleted?.(pending.taskId);
    } catch {
      await failPersistedTask(
        pending.taskId,
        "报告已生成，但成果登记失败，请检查本地任务服务。",
      );
      setDispatchPhase("scrape-failed");
      setDispatchMessage("报告已生成，但成果登记失败，请检查本地任务服务。");
    }
  };

  const pausePendingReport = async () => {
    const pending = pendingReportTaskRef.current;
    if (!pending) return;
    try {
      await updateCompetitorTask(pending.taskId, {
        status: "running",
        progress: 92,
        currentStep: "证据包已生成，等待配置模型",
      });
      onRecordsChanged?.();
    } catch {
      setDispatchMessage("证据包已生成，但任务状态同步失败，请检查本地任务服务。");
    }
  };

  const failPendingReport = async (message: string) => {
    const pending = pendingReportTaskRef.current;
    if (!pending) return;
    pendingReportTaskRef.current = null;
    await failPersistedTask(pending.taskId, message);
  };

  const submit = async () => {
    if (
      detection.kind === "ready"
      && detection.platformId
      && detection.skillId
      && detection.bridgeUrl
    ) {
      const message = `已自动路由：${detection.platformLabel} → ${detection.skillId}`;
      let taskId: string | null = null;
      setIsDispatching(true);
      setDispatchPhase("connecting");
      setDispatchMessage(`${message}。正在创建可追踪任务…`);
      let healthConfirmed = false;
      try {
        const createdTask = await createCompetitorTask({
          id: createCompetitorTaskId(),
          title: `${detection.platformLabel}${detection.reportMode === "douyin-account" ? "账号" : "作品"}抓取`,
          platformId: detection.platformId,
          platformLabel: detection.platformLabel,
          skillId: detection.skillId,
          sourceUrl: detection.normalizedUrl,
        });
        taskId = createdTask.id;
        onRecordsChanged?.();
        await updateCompetitorTask(taskId, {
          status: "running",
          progress: 25,
          currentStep: "正在连接本地 Skill",
        });
        onRecordsChanged?.();
        setDispatchMessage(`${message}。正在连接本地采集桥…`);
        const healthResponse = await fetch(`${detection.bridgeUrl}/health`, {
          method: "GET",
          credentials: "omit",
          cache: "no-store",
        });
        if (!healthResponse.ok) {
          throw new Error("bridge_health_failed");
        }
        healthConfirmed = true;
        await updateCompetitorTask(taskId, {
          status: "running",
          progress: 60,
          currentStep: "正在抓取平台数据",
        });
        onRecordsChanged?.();
        setDispatchPhase("scraping");
        setDispatchMessage(`${message}。本地服务已连接，正在抓取平台数据…`);
        const response = await fetch(`${detection.bridgeUrl}/scrape`, {
          method: "POST",
          credentials: "omit",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: detection.normalizedUrl }),
        });
        const payload = await response.json() as {
          ok?: boolean;
          message?: string;
          outputDir?: string;
          inputType?: string;
          excelPath?: string;
        };
        if (!response.ok || payload.ok !== true) {
          const failure = payload.message
            ?? `${message}。本地采集桥未完成任务，请确认本地工作台和抓取服务已启动。`;
          await failPersistedTask(taskId, failure);
          setDispatchPhase("scrape-failed");
          setDispatchMessage(failure);
          return;
        }
        if (!payload.outputDir) {
          await failPersistedTask(taskId, "抓取完成，但没有返回成果目录。");
          setDispatchPhase("scrape-failed");
          setDispatchMessage("抓取完成，但没有返回成果目录，未登记任务成果。");
          return;
        }
        await updateCompetitorTask(taskId, {
          status: "running",
          progress: 90,
          currentStep: "正在登记成果",
        });
        onRecordsChanged?.();
        const explicitPaths = typeof payload.excelPath === "string"
          ? [payload.excelPath]
          : [];
        await registerCompetitorArtifacts(taskId, {
          outputDir: payload.outputDir,
          explicitPaths,
        });
        onRecordsChanged?.();
        setDispatchPhase("completed");
        if (
          detection.reportMode === "douyin-account"
          && payload.inputType === "作品链接"
        ) {
          const completed = `${message}。单作品抓取完成，结果已保存到 ${payload.outputDir ?? "竞品洞察输出目录"}；单作品不会进入账号报告。`;
          setDispatchMessage(completed);
          await updateCompetitorTask(taskId, {
            status: "completed",
            progress: 100,
            currentStep: "单作品抓取成果已登记",
          });
          onRecordsChanged?.();
          onPreview("抖音单作品抓取完成");
          onTaskCompleted?.(taskId);
          return;
        }
        if (detection.reportMode === "douyin-account") {
          if (
            payload.inputType !== "账号链接/账号标识"
            || typeof payload.excelPath !== "string"
            || !/\.xlsx$/iu.test(payload.excelPath)
          ) {
            setDispatchMessage(
              `${message}。账号抓取已返回，但没有得到有效的账号 Excel，未启动报告分析。`,
            );
            await failPersistedTask(taskId, "账号抓取未返回有效的账号 Excel。");
            return;
          }
          pendingReportTaskRef.current = {
            taskId,
            outputDir: payload.outputDir,
            explicitPaths,
          };
          await updateCompetitorTask(taskId, {
            status: "running",
            progress: 90,
            currentStep: "抓取完成，正在生成账号报告",
          });
          onRecordsChanged?.();
          setReportPathRequest((current) => ({
            requestId: (current?.requestId ?? 0) + 1,
            excelPath: payload.excelPath as string,
          }));
          setDispatchMessage(`${message}。抓取完成，正在生成账号报告…`);
          onPreview("抖音账号抓取完成，正在生成报告");
          return;
        }
        const completed = `${message}。抓取完成，结果已保存到 ${payload.outputDir ?? "竞品洞察输出目录"}。`;
        setDispatchMessage(completed);
        await updateCompetitorTask(taskId, {
          status: "completed",
          progress: 100,
          currentStep: "抓取成果已登记",
        });
        onRecordsChanged?.();
        onPreview(`${detection.platformLabel}竞品数据抓取完成`);
        onTaskCompleted?.(taskId);
      } catch {
        const failure = taskId
          ? healthConfirmed
            ? `${message}。本地服务已连接，但抓取任务中断；请检查平台登录或验证状态后重试。`
            : `${message}。浏览器未能访问本机采集服务：可能是服务未启动，或本站的本地网络访问被浏览器拦截。请刷新页面后重试；若服务已运行，请允许本站访问本地网络。`
          : "无法创建可追踪任务，请确认本地任务服务 8768 已启动。";
        await failPersistedTask(taskId, failure);
        if (healthConfirmed) {
          setDispatchPhase("scrape-failed");
          setDispatchMessage(
            `${message}。本地服务已连接，但抓取任务中断；请检查平台登录或验证状态后重试。`,
          );
        } else {
          setDispatchPhase("connection-failed");
          setDispatchMessage(
            taskId
              ? `${message}。浏览器未能访问本机采集服务：可能是服务未启动，或本站的本地网络访问被浏览器拦截。请刷新页面后重试；若服务已运行，请允许本站访问本地网络。`
              : failure,
          );
        }
      } finally {
        setIsDispatching(false);
      }
      return;
    }
    setDispatchMessage(detection.message);
  };

  return (
    <section className={`competitor-console ${mode}`} aria-labelledby="competitor-console-title">
      <header className="competitor-console-heading">
        <div>
          <span className="panel-label">
            {mode === "overview" ? "能力总览" : "竞品采集入口"}
          </span>
          <h2 id="competitor-console-title">
            {mode === "overview" ? "跨平台竞品洞察工作流" : "粘贴链接，自动选择抓取 Skill"}
          </h2>
          <p>
            先识别链接所属平台，再调用该平台专用 Skill；不跨平台混用登录态和抓取逻辑。
          </p>
        </div>
        <span className="competitor-live-badge">Agent 已启动</span>
      </header>

      <div className="competitor-capability-grid">
        {COMPETITOR_PLATFORM_ROUTES.map((route) => (
          <article className={`competitor-skill-card ${route.status}`} key={route.id}>
            <div>
              <span>{route.label}</span>
              <b>{route.status === "ready" ? "已接入" : "待接入"}</b>
            </div>
            <strong>{route.skillId}</strong>
            <p>
              {route.status === "ready"
                ? route.id === "douyin"
                  ? "账号主页、作品列表和 Excel 导出已就绪；账号 Excel → Markdown 证据报告"
                  : "账号主页、作品列表和 Excel 导出已就绪"
                : "平台识别规则已预留，安装后自动启用"}
            </p>
          </article>
        ))}
      </div>

      <ol className="competitor-workflow" aria-label="竞品洞察处理流程">
        {WORKFLOW.map((step, index) => (
          <li
            aria-label={`${step}（${
              workflowStepStatuses[index] === "completed"
                ? "已完成"
                : workflowStepStatuses[index] === "active"
                  ? "进行中"
                  : workflowStepStatuses[index] === "failed"
                    ? "失败"
                    : "未开始"
            }）`}
            className={workflowStepStatuses[index]}
            key={step}
          >
            <span>{index + 1}</span>
            {step}
          </li>
        ))}
      </ol>

      {mode === "run" ? (
        <div
          aria-label="竞品抓取进度"
          aria-live="polite"
          className={`competitor-capture-progress ${dispatchPhase}`}
          role="status"
        >
          <strong>
            {dispatchProgress.step > 0
              ? `第 ${dispatchProgress.step}/4 步`
              : "等待开始"}
          </strong>
          <span>{dispatchProgress.message}</span>
        </div>
      ) : null}

      {mode === "run" ? (
        <>
          <form
            className="competitor-source-form"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
          <label htmlFor="competitor-source">
            竞品主页或作品链接
            <textarea
              id="competitor-source"
              onChange={(event) => {
                setSource(event.target.value);
                setDispatchMessage("");
                setDispatchPhase("idle");
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
            {isDispatching ? "正在抓取…" : "抓取并分析"}
          </button>
          {dispatchMessage ? (
            <div
              className={`competitor-dispatch-result ${detection.kind}`}
              role="alert"
            >
              {dispatchMessage}
            </div>
          ) : null}
          </form>
          <CompetitorReportRunner
            onCompleted={(report) => void completePendingReport(report)}
            onEvidencePaused={() => void pausePendingReport()}
            onFailed={(message) => void failPendingReport(message)}
            pathRequest={reportPathRequest}
          />
        </>
      ) : (
        <>
          <div className="competitor-overview-actions">
            <div>
              <strong>当前可执行：抖音与小红书账号采集</strong>
              <p>登录态只保存在本机；不会要求输入账号密码，也不会展示或导出 Cookie。</p>
            </div>
            <button onClick={onStart} type="button">开始竞品采集</button>
          </div>
          <div
            className="compliance-status data-review"
            role="status"
            aria-label="成果合规状态"
          >
            <strong>数据口径确认</strong>
            <p>当前项目以经营分析为主，仍需人工确认数据口径。</p>
            <small>平台公开互动数据不等于成交、销量或真实用户规模。</small>
          </div>
        </>
      )}
    </section>
  );
}
