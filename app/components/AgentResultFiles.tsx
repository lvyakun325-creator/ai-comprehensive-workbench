"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  getAgentResults as queryAgentResults,
  getTaskById as queryTaskById,
  type ProjectResult,
} from "../lib/agent-project-records.mjs";

type AgentResultQuery = (
  agentId: string,
) => ReturnType<typeof queryAgentResults>;

type AgentResultFilesProps = {
  agentId: string;
  initialTaskId?: string | null;
  getAgentResults?: AgentResultQuery;
  getTaskById?: typeof queryTaskById;
  onPreview: (message: string) => void;
  onRevealArtifact?: (artifactId: string) => Promise<void>;
};

const completedAtFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Shanghai",
});

const formatFileSize = (sizeBytes: number) =>
  sizeBytes < 1024
    ? `${sizeBytes} B`
    : `${(sizeBytes / 1024).toFixed(1)} KB`;

const ARTIFACT_LABELS = {
  excel: "Excel",
  markdown: "MD",
  json: "JSON",
  "image-directory": "图片",
  "output-directory": "目录",
} as const;

function resolveResultAccess(
  result: ProjectResult,
  agentId: string,
  getTaskById: typeof queryTaskById,
) {
  const sourceTask = getTaskById(result.taskId);
  const isMarkdown = result.filename.toLowerCase().endsWith(".md");
  const isRegisteredArtifact = Boolean(
    result.kind
    && result.absolutePath
    && ["excel", "markdown", "json", "image-directory", "output-directory"]
      .includes(result.kind),
  );
  const isAccessible =
    (isMarkdown || isRegisteredArtifact) &&
    sourceTask?.id === result.taskId &&
    sourceTask.status === "completed" &&
    sourceTask.agentId === result.agentId &&
    result.agentId === agentId;

  return {
    result,
    sourceTask,
    isMarkdown,
    isRegisteredArtifact,
    isAccessible,
  };
}

export function AgentResultFiles({
  agentId,
  initialTaskId = null,
  getAgentResults = queryAgentResults,
  getTaskById = queryTaskById,
  onPreview,
  onRevealArtifact,
}: AgentResultFilesProps) {
  const resultAccesses = getAgentResults(agentId).map((result) =>
    resolveResultAccess(result, agentId, getTaskById),
  );
  const markdownResultAccesses = resultAccesses.filter(
    (access) => access.isMarkdown,
  );
  const [dismissedFocusedTaskId, setDismissedFocusedTaskId] = useState<
    string | null
  >(null);
  const focusedTaskId = initialTaskId !== dismissedFocusedTaskId
    ? initialTaskId
    : null;
  const competitorResultAccesses = resultAccesses.filter(
    (access) =>
      access.isRegisteredArtifact
      && (focusedTaskId === null || access.result.taskId === focusedTaskId),
  );
  const [selectedResultId, setSelectedResultId] = useState<string | null>(
    () => agentId === "competitor-insight"
      ? null
      : resultAccesses.find(
        (access) =>
          access.isAccessible && access.result.taskId === initialTaskId,
      )?.result.id ?? null,
  );
  const selectedResult =
    resultAccesses.find(
      (access) =>
        access.isAccessible && access.result.id === selectedResultId,
    )?.result ?? null;
  const [actionStatus, setActionStatus] = useState("");
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const resultTriggerRef = useRef<HTMLButtonElement | null>(null);
  const resultTriggersRef = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    const backdrop = backdropRef.current;
    if (!selectedResult || !backdrop) return;

    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const backgroundStates = Array.from(document.body.children)
      .filter((element) => element !== backdrop)
      .map((element) => {
        const htmlElement = element as HTMLElement;
        const state = {
          element: htmlElement,
          hadInert: htmlElement.hasAttribute("inert"),
          ariaHidden: htmlElement.getAttribute("aria-hidden"),
        };
        htmlElement.inert = true;
        htmlElement.setAttribute("inert", "");
        htmlElement.setAttribute("aria-hidden", "true");
        return state;
      });

    const dialog = dialogRef.current;
    resultTriggerRef.current ??=
      resultTriggersRef.current.get(selectedResult.id) ?? null;
    closeButtonRef.current?.focus();

    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSelectedResultId(null);
        return;
      }

      if (event.key !== "Tab" || !dialog) return;

      const focusableElements = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      );
      const firstFocusable = focusableElements[0];
      const lastFocusable = focusableElements.at(-1);

      if (!firstFocusable || !lastFocusable) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        firstFocusable.focus();
      } else if (event.shiftKey && document.activeElement === firstFocusable) {
        event.preventDefault();
        lastFocusable.focus();
      } else if (!event.shiftKey && document.activeElement === lastFocusable) {
        event.preventDefault();
        firstFocusable.focus();
      }
    };

    document.addEventListener("keydown", handleDialogKeyDown);

    return () => {
      document.removeEventListener("keydown", handleDialogKeyDown);
      document.body.style.overflow = previousBodyOverflow;
      for (const state of backgroundStates) {
        state.element.inert = state.hadInert;
        if (state.hadInert) {
          state.element.setAttribute("inert", "");
        } else {
          state.element.removeAttribute("inert");
        }
        if (state.ariaHidden === null) {
          state.element.removeAttribute("aria-hidden");
        } else {
          state.element.setAttribute("aria-hidden", state.ariaHidden);
        }
      }
      if (resultTriggerRef.current?.isConnected) {
        resultTriggerRef.current.focus();
      }
      resultTriggerRef.current = null;
    };
  }, [selectedResult]);

  const showActionStatus = (message: string) => {
    setActionStatus(message);
    onPreview(message);
  };

  const findAccessibleResult = (resultId: string) =>
    resultAccesses.find(
      (access) => access.isAccessible && access.result.id === resultId,
    )?.result ?? null;

  const copyResult = async (resultId: string) => {
    const result = findAccessibleResult(resultId);
    if (!result) {
      setSelectedResultId(null);
      return;
    }
    if (result.markdown === null) {
      showActionStatus("Markdown 内容暂时不可用，请稍后重试");
      return;
    }
    try {
      await navigator.clipboard.writeText(result.markdown);
      showActionStatus("Markdown 内容已复制");
    } catch {
      showActionStatus("复制失败，请手动选择内容");
    }
  };

  const downloadResult = (resultId: string) => {
    const result = findAccessibleResult(resultId);
    if (!result) {
      setSelectedResultId(null);
      return;
    }
    if (result.markdown === null) {
      const message = "Markdown 内容暂时不可用，请稍后重试";
      showActionStatus(message);
      return;
    }
    setActionStatus("");
    const blob = new Blob([result.markdown], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = result.filename;
    try {
      anchor.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const copyArtifactPath = async (result: ProjectResult) => {
    if (!result.absolutePath) return;
    try {
      await navigator.clipboard.writeText(result.absolutePath);
      showActionStatus("成果路径已复制");
    } catch {
      showActionStatus("复制失败，请手动选择成果路径");
    }
  };

  const revealArtifact = async (result: ProjectResult) => {
    if (!onRevealArtifact || result.exists === false) return;
    try {
      await onRevealArtifact(result.id);
      showActionStatus("已在访达中显示成果");
    } catch {
      showActionStatus("无法在访达中显示该成果");
    }
  };

  return (
    <section
      aria-labelledby="agent-result-files-heading"
      className="agent-results-view"
    >
      {agentId === "competitor-insight" ? (
        <>
          <div className="agent-results-heading">
            <div>
              <span className="eyebrow">RESULT FILES</span>
              <h2 id="agent-result-files-heading">成果文件</h2>
            </div>
            <span>{competitorResultAccesses.length} 个成果</span>
          </div>
          {focusedTaskId ? (
            <div className="result-task-focus" role="status">
              <span>正在查看本次任务成果</span>
              <button
                onClick={() => setDismissedFocusedTaskId(focusedTaskId)}
                type="button"
              >
                查看全部成果
              </button>
            </div>
          ) : null}
          {competitorResultAccesses.length === 0 ? (
            <p className="agent-results-empty">
              抓取任务完成后，成果文件会出现在这里
            </p>
          ) : (
            <div aria-label="竞品成果文件" className="agent-result-list">
              {competitorResultAccesses.map((access) => {
                const {result, sourceTask, isAccessible} = access;
                const missing = result.exists === false;
                const kind = result.kind ?? "markdown";
                return (
                  <article
                    className={`result-file-card artifact-card ${
                      isAccessible ? "" : "result-source-abnormal"
                    } ${missing ? "artifact-missing" : ""}`}
                    key={result.id}
                  >
                    <div>
                      <span aria-hidden="true" className="result-file-icon">
                        {ARTIFACT_LABELS[kind]}
                      </span>
                      <div>
                        <h3>{result.filename}</h3>
                        <p className={isAccessible ? "result-source-task" : "result-source-error"}>
                          来源任务：{isAccessible ? sourceTask?.title : "关联任务异常"}
                        </p>
                        <p>{result.isDirectory ? "文件夹" : formatFileSize(result.sizeBytes)}</p>
                        {result.absolutePath ? <code className="artifact-path">{result.absolutePath}</code> : null}
                        {missing ? <p className="artifact-missing-label">文件已不存在</p> : null}
                      </div>
                    </div>
                    <div className="artifact-actions">
                      <button
                        disabled={!result.absolutePath}
                        onClick={() => void copyArtifactPath(result)}
                        type="button"
                      >
                        复制路径
                      </button>
                      <button
                        aria-label={missing
                          ? `${result.filename} 文件已不存在`
                          : `在访达中显示${result.filename}`}
                        disabled={!isAccessible || missing || !onRevealArtifact}
                        onClick={() => void revealArtifact(result)}
                        type="button"
                      >
                        {missing ? "文件已不存在" : "在访达中显示"}
                      </button>
                      {access.isMarkdown ? (
                        <button
                          disabled={!isAccessible}
                          onClick={(event) => {
                            resultTriggerRef.current = event.currentTarget;
                            setSelectedResultId(result.id);
                          }}
                          ref={(element) => {
                            if (element) resultTriggersRef.current.set(result.id, element);
                            else resultTriggersRef.current.delete(result.id);
                          }}
                          type="button"
                        >
                          查看成果
                        </button>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          {actionStatus ? (
            <p aria-live="polite" className="result-action-status" role="status">
              {actionStatus}
            </p>
          ) : null}
        </>
      ) : (
        <>
          <div className="agent-results-heading">
            <div>
              <span className="eyebrow">RESULT FILES</span>
              <h2 id="agent-result-files-heading">Markdown 成果</h2>
            </div>
            <span>{markdownResultAccesses.length} 个文件</span>
          </div>
          {markdownResultAccesses.length === 0 ? (
            <p className="agent-results-empty">
              任务完成后，Markdown 成果会出现在这里
            </p>
          ) : (
            <div aria-label="Markdown 成果文件" className="agent-result-list">
              {markdownResultAccesses.map((access) => {
            const { result, sourceTask, isAccessible } = access;

            return (
              <article
                className={`result-file-card ${
                  isAccessible ? "" : "result-source-abnormal"
                }`}
                key={result.id}
              >
                <div>
                  <span aria-hidden="true" className="result-file-icon">
                    MD
                  </span>
                  <div>
                    <h3>{result.filename}</h3>
                    <p
                      className={
                        isAccessible ? "result-source-task" : "result-source-error"
                      }
                    >
                      来源任务：
                      {isAccessible ? sourceTask?.title : "关联任务异常"}
                    </p>
                    <p>
                      {formatFileSize(result.sizeBytes)}
                      <span aria-hidden="true"> · </span>
                      完成于{" "}
                      {completedAtFormatter.format(new Date(result.completedAt))}
                    </p>
                  </div>
                </div>
                <button
                  aria-label={
                    isAccessible
                      ? `查看${result.filename}`
                      : `${result.filename} 来源任务异常，无法打开`
                  }
                  disabled={!isAccessible}
                  onClick={(event) => {
                    if (!isAccessible) return;
                    resultTriggerRef.current = event.currentTarget;
                    setActionStatus("");
                    setSelectedResultId(result.id);
                  }}
                  ref={(element) => {
                    if (element) {
                      resultTriggersRef.current.set(result.id, element);
                    } else {
                      resultTriggersRef.current.delete(result.id);
                    }
                  }}
                  type="button"
                >
                  {isAccessible ? "查看成果" : "成果不可用"}
                </button>
              </article>
            );
              })}
            </div>
          )}
        </>
      )}

      {selectedResult && typeof document !== "undefined"
        ? createPortal(
            <div className="result-preview-backdrop" ref={backdropRef}>
              <section
                aria-labelledby="result-preview-title"
                aria-modal="true"
                className="result-preview-dialog"
                ref={dialogRef}
                role="dialog"
                tabIndex={-1}
              >
                <header>
                  <div>
                    <span className="eyebrow">
                      已完成成果 · 只读预览
                    </span>
                    <h2 id="result-preview-title">{selectedResult.filename}</h2>
                  </div>
                  <button
                    aria-label="关闭预览"
                    className="result-preview-close"
                    onClick={() => setSelectedResultId(null)}
                    ref={closeButtonRef}
                    type="button"
                  >
                    ×
                  </button>
                </header>

                {selectedResult.markdown === null ? (
                  <p className="markdown-result-unavailable" role="status">
                    暂时无法预览
                  </p>
                ) : (
                  <pre className="markdown-result-content">
                    {selectedResult.markdown}
                  </pre>
                )}

                {actionStatus ? (
                  <p
                    aria-label="成果操作状态"
                    aria-live="polite"
                    className="result-action-status"
                    role="status"
                  >
                    {actionStatus}
                  </p>
                ) : null}

                <footer>
                  <button
                    className="result-preview-secondary"
                    disabled={selectedResult.markdown === null}
                    onClick={() => void copyResult(selectedResult.id)}
                    type="button"
                  >
                    复制内容
                  </button>
                  <button
                    className="result-preview-primary"
                    onClick={() => downloadResult(selectedResult.id)}
                    type="button"
                  >
                    {selectedResult.markdown === null ? "重试下载" : "下载 MD"}
                  </button>
                </footer>
              </section>
            </div>,
            document.body,
          )
        : null}
    </section>
  );
}
