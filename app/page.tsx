"use client";

import { useState } from "react";
import { ControlDesk } from "./components/ControlDesk";
import { PreviewToast } from "./components/PreviewToast";
import { WorkbenchShell } from "./components/WorkbenchShell";
import {
  createInitialState,
  navigateTo,
  openAgent,
} from "./lib/workbench-state.mjs";
import type { WorkbenchView } from "./lib/workbench-state.mjs";

const VIEW_LABELS: Record<Exclude<WorkbenchView, "control" | "settings">, string> = {
  agents: "Agent 项目",
  tasks: "任务中心",
  assets: "成果资产库",
  analytics: "数据概览",
  models: "模型配置",
};

export default function Home() {
  const [state, setState] = useState(createInitialState());
  const [toast, setToast] = useState("");

  const showPreview = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  };

  const content = (() => {
    if (state.view === "control") {
      return <ControlDesk onOpenAgent={(agentId) => setState(openAgent(state, agentId))} onPreview={showPreview} />;
    }

    if (state.view === "settings") {
      return (
        <section className="design-preview">
          <span className="eyebrow">DESIGN PREVIEW</span>
          <h1>系统设置</h1>
          <p>系统设置将在接口与权限阶段启用</p>
        </section>
      );
    }

    return (
      <section className="design-preview">
        <span className="eyebrow">DESIGN PREVIEW</span>
        <h1>{VIEW_LABELS[state.view]}</h1>
        <p>该模块将在对应功能阶段启用。</p>
      </section>
    );
  })();

  return (
    <>
      <WorkbenchShell
        state={state}
        onNavigate={(view) => setState(navigateTo(state, view))}
        onOpenAgent={(agentId) => setState(openAgent(state, agentId))}
        onPreview={showPreview}
      >
        {content}
      </WorkbenchShell>
      <PreviewToast message={toast} />
    </>
  );
}
