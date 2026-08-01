"use client";

import { useMemo, useState } from "react";
import type {
  ProjectBundle,
  ProjectBundleCategory,
  ProjectResult,
} from "../lib/agent-project-records.mjs";
import {
  downloadCompetitorBundle,
  loadCompetitorBundleDetail,
  revealCompetitorBundle,
} from "../lib/competitor-project-records-client";

const CATEGORIES = [
  ["all", "全部成果"],
  ["douyin-account", "抖音账号"],
  ["douyin-content", "抖音作品"],
  ["xhs-account", "小红书账号"],
  ["xhs-note", "小红书笔记"],
] as const;

type CategoryFilter = "all" | ProjectBundleCategory;

type CompetitorResultBundlesProps = {
  bundles: readonly ProjectBundle[];
  artifacts: readonly ProjectResult[];
  initialTaskId?: string | null;
  onPreview: (message: string) => void;
};

const completedAtFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Shanghai",
});

const ARTIFACT_LABELS = {
  excel: "Excel",
  markdown: "MD",
  json: "JSON",
  "image-directory": "图片",
  "output-directory": "目录",
} as const;

function sanitizeSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.search = "";
    url.hash = "";
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return null;
  }
}

function bundleArtifacts(
  bundle: ProjectBundle,
  artifacts: readonly ProjectResult[],
) {
  const allowed = new Set(bundle.artifactIds);
  return artifacts.filter((artifact) => (
    artifact.agentId === bundle.agentId
    && artifact.taskId === bundle.taskId
    && allowed.has(artifact.id)
  ));
}

export function CompetitorResultBundles({
  bundles,
  artifacts,
  initialTaskId = null,
  onPreview,
}: CompetitorResultBundlesProps) {
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [dismissedFocusedTaskId, setDismissedFocusedTaskId] = useState<string | null>(null);
  const [expandedBundleIds, setExpandedBundleIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [preview, setPreview] = useState<{
    bundleId: string;
    title: string;
    markdown: string | null;
  } | null>(null);
  const [loadingBundleId, setLoadingBundleId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState("");
  const focusedTaskId = initialTaskId !== dismissedFocusedTaskId
    ? initialTaskId
    : null;
  const visibleBundles = useMemo(
    () => bundles.filter((bundle) => (
      (focusedTaskId === null || bundle.taskId === focusedTaskId)
      && (category === "all" || bundle.category === category)
    )),
    [bundles, category, focusedTaskId],
  );

  const reportStatus = (message: string) => {
    setActionStatus(message);
    onPreview(message);
  };

  const openReport = async (bundle: ProjectBundle) => {
    if (loadingBundleId) return;
    setLoadingBundleId(bundle.id);
    setActionStatus("");
    try {
      const detail = await loadCompetitorBundleDetail(bundle.id);
      setPreview({
        bundleId: bundle.id,
        title: bundle.title,
        markdown: detail.markdown,
      });
      if (!detail.previewable) reportStatus("分析报告暂时无法预览");
    } catch {
      reportStatus("无法读取分析报告，请稍后重试");
    } finally {
      setLoadingBundleId(null);
    }
  };

  const downloadBundle = async (bundle: ProjectBundle) => {
    const action = `download:${bundle.id}`;
    if (busyAction) return;
    setBusyAction(action);
    setActionStatus("");
    let objectUrl: string | null = null;
    try {
      const download = await downloadCompetitorBundle(bundle.id);
      objectUrl = URL.createObjectURL(download.blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = download.filename;
      anchor.click();
      reportStatus("成果包下载已开始");
    } catch {
      reportStatus("成果包下载失败，请稍后重试");
    } finally {
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
      setBusyAction(null);
    }
  };

  const revealBundle = async (bundle: ProjectBundle) => {
    const action = `reveal:${bundle.id}`;
    if (busyAction) return;
    setBusyAction(action);
    setActionStatus("");
    try {
      await revealCompetitorBundle(bundle.id);
      reportStatus("已在访达中显示成果包");
    } catch {
      reportStatus("无法在访达中显示成果包");
    } finally {
      setBusyAction(null);
    }
  };

  const toggleDetails = (bundleId: string) => {
    setExpandedBundleIds((current) => {
      const next = new Set(current);
      if (next.has(bundleId)) next.delete(bundleId);
      else next.add(bundleId);
      return next;
    });
  };

  return (
    <section aria-labelledby="competitor-result-bundles-heading" className="agent-results-view competitor-bundles-view">
      <div className="agent-results-heading">
        <div>
          <span className="eyebrow">RESULT BUNDLES</span>
          <h2 id="competitor-result-bundles-heading">成果包</h2>
        </div>
        <span>{visibleBundles.length} 个成果包</span>
      </div>

      {focusedTaskId ? (
        <div
          aria-label="正在查看本次成果"
          aria-live="polite"
          className="result-task-focus"
          role="status"
        >
          <span>正在查看本次成果</span>
          <button
            onClick={() => setDismissedFocusedTaskId(focusedTaskId)}
            type="button"
          >查看全部成果</button>
        </div>
      ) : null}

      <div aria-label="成果分类" className="competitor-bundle-filters">
        {CATEGORIES.map(([value, label]) => (
          <button
            aria-pressed={category === value}
            className={category === value ? "active" : ""}
            key={value}
            onClick={() => setCategory(value)}
            type="button"
          >{label}</button>
        ))}
      </div>

      {visibleBundles.length === 0 ? (
        <p className="agent-results-empty">任务完成并封装后，成果包会出现在这里</p>
      ) : (
        <div aria-label="竞品成果包" className="competitor-bundle-list">
          {visibleBundles.map((bundle) => {
            const children = bundleArtifacts(bundle, artifacts);
            const primary = children.find((artifact) => artifact.id === bundle.primaryArtifactId);
            const sourceUrl = sanitizeSourceUrl(bundle.sourceUrl);
            const expanded = expandedBundleIds.has(bundle.id);
            const complete = bundle.status === "ready"
              && Boolean(primary)
              && primary?.exists !== false;
            const disabled = bundle.status !== "ready" || !bundle.primaryArtifactId;
            const categoryLabel = CATEGORIES.find(([value]) => value === bundle.category)?.[1]
              ?? bundle.platformLabel;
            return (
              <article
                aria-label={`${bundle.title} 成果包`}
                className={`competitor-bundle-card status-${bundle.status}`}
                key={bundle.id}
              >
                <header className="competitor-bundle-card-heading">
                  <div>
                    <span className="competitor-bundle-category">{categoryLabel}</span>
                    <h3>{bundle.title}</h3>
                  </div>
                  <span className={complete ? "bundle-integrity complete" : "bundle-integrity incomplete"}>
                    {complete ? "成果完整" : "成果不完整"}
                  </span>
                </header>
                <dl className="competitor-bundle-meta">
                  <div><dt>主体</dt><dd>{bundle.subjectName}</dd></div>
                  <div><dt>作品数</dt><dd>{bundle.itemCount}</dd></div>
                  <div><dt>生成时间</dt><dd>{completedAtFormatter.format(new Date(bundle.completedAt))}</dd></div>
                  <div><dt>主报告</dt><dd>{primary?.filename ?? "主报告缺失"}</dd></div>
                </dl>
                {sourceUrl ? (
                  <a
                    aria-label={`查看来源链接：${bundle.subjectName}`}
                    className="competitor-bundle-source"
                    href={sourceUrl}
                    rel="noreferrer noopener"
                    target="_blank"
                  >{sourceUrl}</a>
                ) : (
                  <p className="competitor-bundle-source unavailable">来源链接不可用</p>
                )}
                <div className="competitor-bundle-actions">
                  <button
                    disabled={disabled || loadingBundleId !== null}
                    onClick={() => void openReport(bundle)}
                    type="button"
                  >{loadingBundleId === bundle.id ? "正在读取" : "查看分析报告"}</button>
                  <button
                    disabled={bundle.status !== "ready" || busyAction !== null}
                    onClick={() => void downloadBundle(bundle)}
                    type="button"
                  >下载成果包</button>
                  <button
                    disabled={bundle.status === "missing" || busyAction !== null}
                    onClick={() => void revealBundle(bundle)}
                    type="button"
                  >在访达中显示</button>
                  <button
                    aria-expanded={expanded}
                    onClick={() => toggleDetails(bundle.id)}
                    type="button"
                  >{expanded ? "收起明细" : "展开明细"}</button>
                </div>
                {expanded ? (
                  <ul aria-label={`${bundle.title} 子文件`} className="competitor-bundle-artifacts">
                    {children.map((artifact) => (
                      <li key={artifact.id}>
                        <span aria-hidden="true">{ARTIFACT_LABELS[artifact.kind ?? "markdown"]}</span>
                        <strong>{artifact.filename}</strong>
                        <small>{artifact.exists === false ? "文件已不存在" : artifact.isDirectory ? "文件夹" : "文件"}</small>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {preview?.bundleId === bundle.id ? (
                  <section
                    aria-label={`${bundle.title}报告预览`}
                    className="competitor-bundle-preview"
                    role="region"
                  >
                    <div>
                      <strong>分析报告预览</strong>
                      <button onClick={() => setPreview(null)} type="button">关闭预览</button>
                    </div>
                    {preview.markdown === null
                      ? <p>分析报告暂时无法预览</p>
                      : <pre>{preview.markdown}</pre>}
                  </section>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
      <p
        aria-label="成果包操作状态"
        aria-live="polite"
        className="result-action-status competitor-bundle-status"
        role="status"
      >{actionStatus}</p>
    </section>
  );
}
