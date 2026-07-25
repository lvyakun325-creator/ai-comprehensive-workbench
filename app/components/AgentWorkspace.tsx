import type { AgentProject } from "../lib/agent-catalog.mjs";

const PROJECT_TABS = [
  "项目总览",
  "Agent 对话",
  "任务列表",
  "项目资料",
  "执行过程",
  "成果文件",
  "成果交接",
  "Agent 配置",
];

const PROJECT_STATUS = "等待接收本项目任务";

type AgentWorkspaceProps = {
  agent: AgentProject;
  onBack: () => void;
  onPreview: (message: string) => void;
};

export function AgentWorkspace({ agent, onBack, onPreview }: AgentWorkspaceProps) {
  return (
    <section className="agent-workspace">
      <div className="agent-workspace-topbar">
        <button className="back-button" onClick={onBack}>← 返回 Agent 项目</button>
        <span>{agent.index}</span>
      </div>

      <div className="isolation-banner">
        <span>✓</span>
        <p>当前位于「{agent.title}」。它只会操作本项目资料，不会修改其他 Agent 项目。</p>
      </div>

      <div className="agent-project-header">
        <span className={`agent-icon ${agent.accent}`}>{agent.icon}</span>
        <div>
          <span className="eyebrow">ISOLATED AGENT PROJECT</span>
          <h1>{agent.title}</h1>
          <p>{agent.responsibility}</p>
        </div>
      </div>

      <nav className="project-tabs" aria-label={`${agent.title} 项目导航`}>
        {PROJECT_TABS.map((tab, index) => (
          <button
            className={index === 0 ? "active" : ""}
            key={tab}
            onClick={() => index > 0 && onPreview(`${tab}将在真实 Agent 接入后启用`)}
          >
            {tab}
          </button>
        ))}
      </nav>

      <div className="agent-project-grid">
        <article className="project-panel">
          <span className="panel-label">本项目输入</span>
          <strong>{agent.input}</strong>
          <p>状态：{PROJECT_STATUS}</p>
        </article>
        <article className="project-panel">
          <span className="panel-label">本项目输出</span>
          <strong>{agent.output}</strong>
          <p>成果会在确认后以只读副本交接给其他项目。</p>
        </article>
      </div>
    </section>
  );
}
