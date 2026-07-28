"use client";

import { useState } from "react";
import {
  getAgentResults as queryAgentResults,
  type ProjectResult,
} from "../lib/agent-project-records.mjs";

type AgentResultQuery = (
  agentId: string,
) => ReturnType<typeof queryAgentResults>;

type AgentResultFilesProps = {
  agentId: string;
  initialTaskId?: string | null;
  getAgentResults?: AgentResultQuery;
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

const formatFileSize = (sizeBytes: number) =>
  sizeBytes < 1024
    ? `${sizeBytes} B`
    : `${(sizeBytes / 1024).toFixed(1)} KB`;

export function AgentResultFiles({
  agentId,
  initialTaskId = null,
  getAgentResults = queryAgentResults,
  onPreview,
}: AgentResultFilesProps) {
  const results = getAgentResults(agentId).filter((result) =>
    result.filename.toLowerCase().endsWith(".md"),
  );
  const [selectedResult, setSelectedResult] = useState<ProjectResult | null>(
    () => results.find((result) => result.taskId === initialTaskId) ?? null,
  );

  const copyResult = async (result: ProjectResult) => {
    await navigator.clipboard.writeText(result.markdown);
    onPreview("Markdown 内容已复制");
  };

  const downloadResult = (result: ProjectResult) => {
    const blob = new Blob([result.markdown], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = result.filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section
      aria-labelledby="agent-result-files-heading"
      className="agent-results-view"
    >
      <div className="agent-results-heading">
        <div>
          <span className="eyebrow">RESULT FILES</span>
          <h2 id="agent-result-files-heading">Markdown 成果</h2>
        </div>
        <span>{results.length} 个文件</span>
      </div>

      {results.length === 0 ? (
        <p className="agent-results-empty">当前 Agent 暂无 Markdown 成果。</p>
      ) : (
        <div aria-label="Markdown 成果文件" className="agent-result-list">
          {results.map((result) => (
            <article className="result-file-card" key={result.id}>
              <div>
                <span aria-hidden="true" className="result-file-icon">
                  MD
                </span>
                <div>
                  <h3>{result.filename}</h3>
                  <p>
                    {formatFileSize(result.sizeBytes)}
                    <span aria-hidden="true"> · </span>
                    完成于 {completedAtFormatter.format(new Date(result.completedAt))}
                  </p>
                </div>
              </div>
              <button
                aria-label={`查看${result.filename}`}
                onClick={() => setSelectedResult(result)}
                type="button"
              >
                查看成果
              </button>
            </article>
          ))}
        </div>
      )}

      {selectedResult ? (
        <div className="result-preview-backdrop">
          <section
            aria-labelledby="result-preview-title"
            aria-modal="true"
            className="result-preview-dialog"
            role="dialog"
          >
            <header>
              <div>
                <span className="eyebrow">READ-ONLY PREVIEW</span>
                <h2 id="result-preview-title">{selectedResult.filename}</h2>
              </div>
              <button
                aria-label="关闭预览"
                className="result-preview-close"
                onClick={() => setSelectedResult(null)}
                type="button"
              >
                ×
              </button>
            </header>

            <pre className="markdown-result-content">
              {selectedResult.markdown}
            </pre>

            <footer>
              <button
                className="result-preview-secondary"
                onClick={() => void copyResult(selectedResult)}
                type="button"
              >
                复制内容
              </button>
              <button
                className="result-preview-primary"
                onClick={() => downloadResult(selectedResult)}
                type="button"
              >
                下载 MD
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </section>
  );
}
