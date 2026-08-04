"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
type BundleAction = "detail" | "download" | "reveal";

type ActiveBundleAction = {
  controller: AbortController;
  token: number;
};

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

const URL_CONTEXT_BOUNDARIES = new Set([
  "<", ">", "\"", "'", "`",
  "，", "。", "；", "！", "？", "、",
]);
const AUTHORIZATION_BEARER_ASSIGNMENT = /\bauthorization\b[ \t]*[:=][ \t]*bearer[ \t]+[^\s,，;；]+/giu;
const SENSITIVE_ASSIGNMENT = /\b(?:token|credentials?|cookies?|authorization|api[ _-]?key|secret|password|passwd|session)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,，;；]+)/giu;
const HIDDEN_VALUE = "[敏感信息已隐藏]";

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

function sanitizeEmbeddedUrls(value: string): string {
  const schemePattern = /https?:\/\//giu;
  let cursor = 0;
  let output = "";
  let schemeMatch = schemePattern.exec(value);

  while (schemeMatch !== null) {
    const urlStart = schemeMatch.index;
    let urlEnd = urlStart;
    while (urlEnd < value.length) {
      const character = value[urlEnd];
      if (/\s/u.test(character) || URL_CONTEXT_BOUNDARIES.has(character)) break;
      urlEnd += 1;
    }

    const candidate = value.slice(urlStart, urlEnd);
    output += value.slice(cursor, urlStart);
    output += sanitizeSourceUrl(candidate) ?? "[链接已隐藏]";
    cursor = urlEnd;
    schemePattern.lastIndex = urlEnd;
    schemeMatch = schemePattern.exec(value);
  }

  return output + value.slice(cursor);
}

function sanitizeDisplayText(value: string, fallback: string): string {
  const sanitized = sanitizeEmbeddedUrls(value)
    .replace(AUTHORIZATION_BEARER_ASSIGNMENT, HIDDEN_VALUE)
    .replace(SENSITIVE_ASSIGNMENT, HIDDEN_VALUE)
    .trim();
  return sanitized || fallback;
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "name" in error
    && error.name === "AbortError",
  );
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
    markdown: string | null;
  } | null>(null);
  const [loadingBundleId, setLoadingBundleId] = useState<string | null>(null);
  const [downloadingBundleId, setDownloadingBundleId] = useState<string | null>(null);
  const [revealingBundleId, setRevealingBundleId] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState("");
  const [interfaceStatus, setInterfaceStatus] = useState("");
  const mountedRef = useRef(false);
  const actionTokensRef = useRef<Record<BundleAction, number>>({
    detail: 0,
    download: 0,
    reveal: 0,
  });
  const actionLocksRef = useRef<Record<BundleAction, boolean>>({
    detail: false,
    download: false,
    reveal: false,
  });
  const activeActionsRef = useRef<Partial<Record<BundleAction, ActiveBundleAction>>>({});
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

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const action of ["detail", "download", "reveal"] as const) {
        actionTokensRef.current[action] += 1;
        actionLocksRef.current[action] = false;
        activeActionsRef.current[action]?.controller.abort();
        delete activeActionsRef.current[action];
      }
    };
  }, []);

  const beginAction = (action: BundleAction): ActiveBundleAction | null => {
    if (actionLocksRef.current[action]) return null;
    actionLocksRef.current[action] = true;
    const token = actionTokensRef.current[action] + 1;
    actionTokensRef.current[action] = token;
    activeActionsRef.current[action]?.controller.abort();
    const active = {controller: new AbortController(), token};
    activeActionsRef.current[action] = active;
    return active;
  };

  const actionIsCurrent = (action: BundleAction, active: ActiveBundleAction) => (
    mountedRef.current
    && !active.controller.signal.aborted
    && actionTokensRef.current[action] === active.token
    && activeActionsRef.current[action] === active
  );

  const finishAction = (action: BundleAction, active: ActiveBundleAction) => {
    if (
      actionTokensRef.current[action] !== active.token
      || activeActionsRef.current[action] !== active
    ) return;
    delete activeActionsRef.current[action];
    actionLocksRef.current[action] = false;
    if (!mountedRef.current) return;
    if (action === "detail") setLoadingBundleId(null);
    if (action === "download") setDownloadingBundleId(null);
    if (action === "reveal") setRevealingBundleId(null);
  };

  const reportStatus = (message: string) => {
    setActionStatus(message);
    onPreview(message);
  };

  const openReport = async (bundle: ProjectBundle) => {
    const active = beginAction("detail");
    if (!active) return;
    setLoadingBundleId(bundle.id);
    setActionStatus("");
    try {
      const detail = await loadCompetitorBundleDetail(
        bundle.id,
        active.controller.signal,
      );
      if (!actionIsCurrent("detail", active)) return;
      setPreview({
        bundleId: bundle.id,
        markdown: detail.markdown,
      });
      if (!detail.previewable) reportStatus("分析报告暂时无法预览");
    } catch (error) {
      if (isAbortError(error) || !actionIsCurrent("detail", active)) return;
      reportStatus("无法读取分析报告，请稍后重试");
    } finally {
      finishAction("detail", active);
    }
  };

  const downloadBundle = async (bundle: ProjectBundle) => {
    const active = beginAction("download");
    if (!active) return;
    setDownloadingBundleId(bundle.id);
    setActionStatus("");
    let objectUrl: string | null = null;
    let anchor: HTMLAnchorElement | null = null;
    try {
      const download = await downloadCompetitorBundle(
        bundle.id,
        active.controller.signal,
      );
      if (!actionIsCurrent("download", active)) return;
      objectUrl = URL.createObjectURL(download.blob);
      anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = download.filename;
      document.body.appendChild(anchor);
      try {
        anchor.click();
      } finally {
        anchor.remove();
        anchor = null;
      }
      if (!actionIsCurrent("download", active)) return;
      reportStatus("成果包下载已开始");
    } catch (error) {
      if (isAbortError(error) || !actionIsCurrent("download", active)) return;
      reportStatus("成果包下载失败，请稍后重试");
    } finally {
      try {
        anchor?.remove();
      } finally {
        try {
          if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
        } catch {
          // Browser cleanup failures must not keep the action locked.
        } finally {
          finishAction("download", active);
        }
      }
    }
  };

  const revealBundle = async (bundle: ProjectBundle) => {
    const active = beginAction("reveal");
    if (!active) return;
    setRevealingBundleId(bundle.id);
    setActionStatus("");
    try {
      await revealCompetitorBundle(bundle.id, active.controller.signal);
      if (!actionIsCurrent("reveal", active)) return;
      reportStatus("已在访达中显示成果包");
    } catch (error) {
      if (isAbortError(error) || !actionIsCurrent("reveal", active)) return;
      reportStatus("无法在访达中显示成果包");
    } finally {
      finishAction("reveal", active);
    }
  };

  const toggleDetails = (bundleId: string) => {
    const willExpand = !expandedBundleIds.has(bundleId);
    const bundle = bundles.find((item) => item.id === bundleId);
    const safeTitle = sanitizeDisplayText(bundle?.title ?? "", "未命名成果包");
    setExpandedBundleIds((current) => {
      const next = new Set(current);
      if (willExpand) next.add(bundleId);
      else next.delete(bundleId);
      return next;
    });
    setInterfaceStatus(`${safeTitle}明细已${willExpand ? "展开" : "收起"}`);
  };

  const emptyMessage = bundles.length === 0
    ? "暂无竞品成果包"
    : focusedTaskId !== null
      ? "本次成果暂不可用，请查看全部成果或稍后刷新"
      : category !== "all"
        ? "当前分类暂无成果包"
        : "暂无竞品成果包";

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
        <p className="agent-results-empty">{emptyMessage}</p>
      ) : (
        <div aria-label="竞品成果包" className="competitor-bundle-list">
          {visibleBundles.map((bundle) => {
            const children = bundleArtifacts(bundle, artifacts);
            const primary = children.find((artifact) => artifact.id === bundle.primaryArtifactId);
            const sourceUrl = sanitizeSourceUrl(bundle.sourceUrl);
            const safeTitle = sanitizeDisplayText(bundle.title, "未命名成果包");
            const safeSubject = sanitizeDisplayText(bundle.subjectName, "未知主体");
            const expanded = expandedBundleIds.has(bundle.id);
            const available = bundle.status === "ready" || bundle.status === "legacy";
            const complete = bundle.status === "ready"
              && Boolean(primary)
              && primary?.exists !== false;
            const disabled = !available || !bundle.primaryArtifactId;
            const categoryLabel = CATEGORIES.find(([value]) => value === bundle.category)?.[1]
              ?? bundle.platformLabel;
            return (
              <article
                aria-label={`${safeTitle} 成果包`}
                className={`competitor-bundle-card status-${bundle.status}`}
                key={bundle.id}
              >
                <header className="competitor-bundle-card-heading">
                  <div>
                    <span className="competitor-bundle-category">{categoryLabel}</span>
                    <h3>{safeTitle}</h3>
                  </div>
                  <span className={complete ? "bundle-integrity complete" : "bundle-integrity incomplete"}>
                    {complete ? "成果完整" : "成果不完整"}
                  </span>
                </header>
                <dl className="competitor-bundle-meta">
                  <div><dt>主体</dt><dd>{safeSubject}</dd></div>
                  <div><dt>作品数</dt><dd>{bundle.itemCount}</dd></div>
                  <div><dt>生成时间</dt><dd>{completedAtFormatter.format(new Date(bundle.completedAt))}</dd></div>
                  <div><dt>主报告</dt><dd>{primary?.filename ?? "主报告缺失"}</dd></div>
                </dl>
                {sourceUrl ? (
                  <a
                    aria-label={`查看来源链接：${safeSubject}`}
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
                    aria-busy={loadingBundleId === bundle.id}
                    aria-label="查看分析报告"
                    disabled={disabled || loadingBundleId !== null}
                    onClick={() => void openReport(bundle)}
                    type="button"
                  >{loadingBundleId === bundle.id ? "正在读取" : "查看分析报告"}</button>
                  <button
                    aria-busy={downloadingBundleId === bundle.id}
                    aria-label="下载成果包"
                    disabled={!available || downloadingBundleId !== null}
                    onClick={() => void downloadBundle(bundle)}
                    type="button"
                  >{downloadingBundleId === bundle.id ? "正在下载" : "下载成果包"}</button>
                  <button
                    aria-busy={revealingBundleId === bundle.id}
                    aria-label="在访达中显示"
                    disabled={!available || revealingBundleId !== null}
                    onClick={() => void revealBundle(bundle)}
                    type="button"
                  >{revealingBundleId === bundle.id ? "正在定位" : "在访达中显示"}</button>
                  <button
                    aria-expanded={expanded}
                    aria-label="展开明细"
                    onClick={() => toggleDetails(bundle.id)}
                    type="button"
                  >{expanded ? "收起明细" : "展开明细"}</button>
                </div>
                {expanded ? (
                  <ul aria-label={`${safeTitle} 子文件`} className="competitor-bundle-artifacts">
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
                    aria-label={`${safeTitle}报告预览`}
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
      <p
        aria-label="成果包界面状态"
        aria-live="polite"
        className="competitor-bundle-interface-status"
        role="status"
      >{interfaceStatus}</p>
    </section>
  );
}
