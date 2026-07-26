"use client";

import { useEffect, useState } from "react";
import type { ContentMatrixSessionConfig } from "./ContentMatrixConfigPanel";

export type ContentMatrixStageResult = {
  stage: 2 | 3 | 4 | 5;
  markdown: string;
};

export type ContentMatrixRunOperation = {
  stage: 2 | 3 | 4 | 5;
  mode: "advance" | "regenerate";
};

const STAGE_TITLES = {
  2: "第二阶段 · 战略判断",
  3: "第三阶段 · 账号分层与人设包装",
  4: "第四阶段 · 内容裂变与起号 SOP",
  5: "第五阶段 · 正式矩阵方案",
} as const;

const NEXT_BUTTON_LABELS = {
  2: "开始战略分析",
  3: "确认战略并进入账号设计",
  4: "确认战术并进入执行 SOP",
  5: "确认执行方案并生成正式成品",
} as const;

const RETRY_BUTTON_LABELS = {
  2: "重试战略分析",
  3: "重试账号设计",
  4: "重试执行 SOP",
  5: "重试正式成品",
} as const;

const RUNNING_BUTTON_LABELS = {
  2: "正在生成战略分析…",
  3: "正在生成账号设计…",
  4: "正在生成执行 SOP…",
  5: "正在生成正式成品…",
} as const;

type ContentMatrixRunnerProps = {
  config: ContentMatrixSessionConfig | null;
  diagnosisReady: boolean;
  stages: ContentMatrixStageResult[];
  feedback: Record<number, string>;
  error: (ContentMatrixRunOperation & { message: string }) | null;
  runningOperation: ContentMatrixRunOperation | null;
  onOpenConfig: () => void;
  onFeedbackChange: (stage: 2 | 3 | 4, value: string) => void;
  onAdvanceStage: (stage: 2 | 3 | 4 | 5) => void;
  onRegenerateStage: (stage: 2 | 3 | 4) => void;
};

export function ContentMatrixRunner({
  config,
  diagnosisReady,
  stages,
  feedback,
  error,
  runningOperation,
  onOpenConfig,
  onFeedbackChange,
  onAdvanceStage,
  onRegenerateStage,
}: ContentMatrixRunnerProps) {
  const finalMarkdown = stages.find((result) => result.stage === 5)?.markdown;

  const nextStage = Math.min(5, stages.length + 2) as 2 | 3 | 4 | 5;
  const isComplete = stages.some((result) => result.stage === 5);
  const isRunning = runningOperation !== null;
  const canRun = Boolean(config) && diagnosisReady && !isRunning && !isComplete;
  const isAdvanceRetry =
    error?.mode === "advance" && error.stage === nextStage;

  return (
    <section className="matrix-runner" aria-labelledby="matrix-runner-title">
      <div className="matrix-model-status" role="status" aria-label="内容矩阵模型状态">
        <div>
          <span className="panel-label">当前模型状态</span>
          {config ? (
            <strong>{config.model} · 已连接，可运行</strong>
          ) : (
            <strong>尚未配置当前会话模型</strong>
          )}
        </div>
        {!config ? (
          <button onClick={onOpenConfig} type="button">前往 Agent 配置</button>
        ) : null}
      </div>

      <div className="matrix-runner-heading">
        <div>
          <span className="panel-label">分阶段生成</span>
          <h3 id="matrix-runner-title">战略、战术、执行与正式方案</h3>
        </div>
        <p>第二至第四阶段逐步确认，第五阶段生成正式 Markdown。</p>
      </div>

      {stages.map((result) => {
        const isCurrentCheckpoint =
          result.stage < 5 && result.stage === nextStage - 1;
        return (
          <article className="matrix-stage-output" key={result.stage}>
            <h3>{STAGE_TITLES[result.stage]}</h3>
            <pre>{result.markdown}</pre>
            {isCurrentCheckpoint ? (
              <>
                <label className="matrix-feedback">
                  {`第${["", "", "二", "三", "四"][result.stage]}阶段修改意见`}
                  <textarea
                    aria-label={`${STAGE_TITLES[result.stage].slice(0, 4)}修改意见`}
                    onChange={(event) =>
                      onFeedbackChange(
                        result.stage as 2 | 3 | 4,
                        event.target.value,
                      )
                    }
                    placeholder="填写后可重生成当前阶段；确认推进是单独动作。"
                    value={feedback[result.stage] ?? ""}
                  />
                </label>
                <div className="matrix-stage-actions">
                  <button
                    disabled={
                      !canRun
                      || !(feedback[result.stage] ?? "").trim()
                    }
                    onClick={() =>
                      onRegenerateStage(result.stage as 2 | 3 | 4)
                    }
                    type="button"
                  >
                    {runningOperation?.mode === "regenerate"
                      && runningOperation.stage === result.stage
                      ? "正在按意见重生成…"
                      : error?.mode === "regenerate"
                          && error.stage === result.stage
                        ? "重试按意见重生成当前阶段"
                        : "按意见重生成当前阶段"}
                  </button>
                  <button
                    className="primary"
                    disabled={
                      !canRun
                      || Boolean((feedback[result.stage] ?? "").trim())
                    }
                    onClick={() => onAdvanceStage(nextStage)}
                    type="button"
                  >
                    {runningOperation?.mode === "advance"
                      && runningOperation.stage === nextStage
                      ? RUNNING_BUTTON_LABELS[nextStage]
                      : isAdvanceRetry
                        ? RETRY_BUTTON_LABELS[nextStage]
                        : NEXT_BUTTON_LABELS[nextStage]}
                  </button>
                </div>
              </>
            ) : null}
            {result.stage === 5 && finalMarkdown ? (
              <MarkdownDownload key={finalMarkdown} markdown={finalMarkdown} />
            ) : null}
          </article>
        );
      })}

      {error ? <div className="matrix-run-error" role="alert">{error.message}</div> : null}
      {diagnosisReady && !config ? (
        <p className="matrix-run-hint">
          请先完成当前会话模型配置，再从 Agent 配置返回继续运行。
        </p>
      ) : null}
      {diagnosisReady && !isComplete && stages.length === 0 ? (
        <button
          className="matrix-run-button"
          disabled={!canRun}
          onClick={() => onAdvanceStage(nextStage)}
          type="button"
        >
          {runningOperation?.mode === "advance"
            && runningOperation.stage === nextStage
            ? RUNNING_BUTTON_LABELS[nextStage]
            : isAdvanceRetry
              ? RETRY_BUTTON_LABELS[nextStage]
              : NEXT_BUTTON_LABELS[nextStage]}
        </button>
      ) : null}
    </section>
  );
}

function MarkdownDownload({ markdown }: { markdown: string }) {
  const [downloadUrl] = useState(() =>
    URL.createObjectURL(
      new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
    ),
  );

  useEffect(
    () => () => URL.revokeObjectURL(downloadUrl),
    [downloadUrl],
  );

  return (
    <a download="内容矩阵正式方案.md" href={downloadUrl}>
      下载 Markdown
    </a>
  );
}
