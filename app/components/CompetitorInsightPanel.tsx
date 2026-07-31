"use client";

import { useMemo, useState } from "react";
import {
  COMPETITOR_PLATFORM_ROUTES,
  detectCompetitorPlatform,
} from "../lib/competitor-platform-router.mjs";
import {
  CompetitorReportRunner,
  type CompetitorReportPathRequest,
} from "./CompetitorReportRunner";

type CompetitorInsightPanelProps = {
  mode: "overview" | "run";
  onPreview: (message: string) => void;
  onStart?: () => void;
};

const WORKFLOW = ["识别平台", "调用抓取 Skill", "整理账号数据", "生成洞察报告"];

export function CompetitorInsightPanel({
  mode,
  onPreview,
  onStart,
}: CompetitorInsightPanelProps) {
  const [source, setSource] = useState("");
  const [dispatchMessage, setDispatchMessage] = useState("");
  const [isDispatching, setIsDispatching] = useState(false);
  const [reportPathRequest, setReportPathRequest] =
    useState<CompetitorReportPathRequest | null>(null);
  const detection = useMemo(
    () => detectCompetitorPlatform(source),
    [source],
  );

  const submit = async () => {
    if (detection.kind === "ready" && detection.skillId && detection.bridgeUrl) {
      const message = `已自动路由：${detection.platformLabel} → ${detection.skillId}`;
      setIsDispatching(true);
      setDispatchMessage(`${message}。正在连接本地采集桥…`);
      try {
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
          setDispatchMessage(
            payload.message
            ?? `${message}。本地采集桥未完成任务，请确认本地工作台和抓取服务已启动。`,
          );
          return;
        }
        if (
          detection.reportMode === "douyin-account"
          && payload.inputType === "作品链接"
        ) {
          const completed = `${message}。单作品抓取完成，结果已保存到 ${payload.outputDir ?? "竞品洞察输出目录"}；单作品不会进入账号报告。`;
          setDispatchMessage(completed);
          onPreview("抖音单作品抓取完成");
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
            return;
          }
          setReportPathRequest((current) => ({
            requestId: (current?.requestId ?? 0) + 1,
            excelPath: payload.excelPath as string,
          }));
        }
        const completed = `${message}。抓取完成，结果已保存到 ${payload.outputDir ?? "竞品洞察输出目录"}。`;
        setDispatchMessage(completed);
        onPreview(`${detection.platformLabel}竞品数据抓取完成`);
      } catch {
        setDispatchMessage(
          `${message}。无法连接本地采集桥，请在本地工作台启动 ${detection.skillId} 服务。`,
        );
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
          <li key={step}>
            <span>{index + 1}</span>
            {step}
          </li>
        ))}
      </ol>

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
          <CompetitorReportRunner pathRequest={reportPathRequest} />
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
