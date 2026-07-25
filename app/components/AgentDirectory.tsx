import { AGENT_PROJECTS } from "../lib/agent-catalog.mjs";

type AgentDirectoryProps = {
  onOpenAgent: (agentId: string) => void;
};

export function AgentDirectory({ onOpenAgent }: AgentDirectoryProps) {
  return (
    <section className="agent-directory" aria-labelledby="agent-directory-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">AGENT PROJECTS</span>
          <h2 id="agent-directory-title">9 个独立 Agent 项目</h2>
        </div>
        <p>每个 Agent 只会操作本项目资料与交付结果。</p>
      </div>

      <div className="agent-grid">
        {AGENT_PROJECTS.map((agent) => (
          <button
            className={`agent-card ${agent.accent}`}
            key={agent.id}
            onClick={() => onOpenAgent(agent.id)}
          >
            <div className="agent-card-head">
              <span className="agent-icon">{agent.icon}</span>
              <span className="isolation-state">项目隔离已开启</span>
              <span>{agent.index}</span>
            </div>
            <h3>{agent.title}</h3>
            <p>{agent.responsibility}</p>
            <dl>
              <div><dt>输入</dt><dd>{agent.input}</dd></div>
              <div><dt>输出</dt><dd>{agent.output}</dd></div>
            </dl>
            <div className="agent-card-footer">
              <span>进入独立项目</span><b>↗</b>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
