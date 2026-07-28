import type { ReactNode } from "react";
import type { WorkbenchState, WorkbenchView } from "../lib/workbench-state.mjs";

const NAV_ITEMS = [
  ["control", "AI 对话", "⌂"],
  ["agents", "Agent 项目", "▦"],
  ["tasks", "任务中心", "◷"],
  ["assets", "成果资产库", "◇"],
  ["analytics", "数据概览", "↗"],
  ["models", "模型配置", "⚙"],
  ["settings", "系统设置", "⚙"],
] as const;

type WorkbenchShellProps = {
  state: WorkbenchState;
  children: ReactNode;
  onNavigate: (view: WorkbenchView) => void;
  onPreview: (message: string) => void;
};

export function WorkbenchShell({
  state,
  children,
  onNavigate,
  onPreview,
}: WorkbenchShellProps) {
  return (
    <main className="app-shell">
      <aside className="side-rail" aria-label="主导航">
        <button className="brand-mark" aria-label="返回 AI 对话" onClick={() => onNavigate("control")}>
          <span>A</span>
        </button>
        <nav className="rail-nav" aria-label="主导航">
          {NAV_ITEMS.map(([view, label, icon]) => {
            const isActive =
              state.view === view ||
              (view === "agents" && state.view === "agent");

            return (
              <button
                className={`rail-button ${view === "settings" ? "rail-settings" : ""} ${isActive ? "active" : ""}`}
                key={view}
                aria-current={isActive ? "page" : undefined}
                aria-label={label}
                onClick={() => onNavigate(view)}
              >
                <span>{icon}</span>
                <small>{label}</small>
              </button>
            );
          })}
        </nav>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="wordmark">
            <div>
              <strong>AI 综合工作台</strong>
              <span>经营与内容 AI 工作台</span>
            </div>
          </div>
          <div className="top-actions">
            <div className="status-pill">
              <i />
              本地设计预览
            </div>
            <button className="ghost-button" onClick={() => onPreview("使用指南将在下一阶段接入")}>
              使用指南
            </button>
          </div>
        </header>
        <div className="content">{children}</div>
      </div>
    </main>
  );
}
