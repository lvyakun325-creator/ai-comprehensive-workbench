"use client";

import { useState } from "react";
import { ControlDesk } from "./components/ControlDesk";
import { AgentDirectory } from "./components/AgentDirectory";
import { AgentWorkspace } from "./components/AgentWorkspace";
import { AssetLibrary } from "./components/AssetLibrary";
import { DataOverview } from "./components/DataOverview";
import { ModelConfigPanel } from "./components/ModelConfigPanel";
import { PreviewToast } from "./components/PreviewToast";
import { TaskCenter } from "./components/TaskCenter";
import { WorkbenchShell } from "./components/WorkbenchShell";
import { getAgentById } from "./lib/agent-catalog.mjs";
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

  const activeAgent = state.activeAgentId
    ? getAgentById(state.activeAgentId)
    : null;

  const content = (() => {
    if (state.view === "agent" && activeAgent) {
      return (
        <AgentWorkspace
          agent={activeAgent}
          onBack={() => setState(navigateTo(state, "agents"))}
          onPreview={showPreview}
        />
      );
    }

    if (state.view === "control") {
      return (
        <>
          <ControlDesk onOpenAgent={(agentId) => setState(openAgent(state, agentId))} onPreview={showPreview} />
          <AgentDirectory onOpenAgent={(agentId) => setState(openAgent(state, agentId))} />
        </>
      );
    }

    if (state.view === "agents") {
      return <AgentDirectory onOpenAgent={(agentId) => setState(openAgent(state, agentId))} />;
    }

    if (state.view === "tasks") {
      return <TaskCenter onPreview={showPreview} />;
    }

    if (state.view === "assets") {
      return <AssetLibrary onPreview={showPreview} />;
    }

    if (state.view === "analytics") {
      return <DataOverview />;
    }

    if (state.view === "models") {
      return <ModelConfigPanel scope="global" onPreview={showPreview} />;
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
