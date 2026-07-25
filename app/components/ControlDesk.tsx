type ControlDeskProps = {
  onOpenAgent: (agentId: string) => void;
  onPreview: (message: string) => void;
};

export function ControlDesk({ onPreview }: ControlDeskProps) {
  return (
    <section className="control-desk">
      <div className="control-hero">
        <span className="eyebrow">TOTAL CONTROL AGENT</span>
        <h1>今天想推进什么经营目标？</h1>
        <p>总控 Agent 只负责拆解、调度和汇总，不直接生产专业内容。</p>
        <div className="capacity-badge">1 个总控台 · 最大并发 3 个子 Agent</div>
      </div>

      <div className="chat-card">
        <div className="chat-label">
          <span className="ai-dot">✦</span>
          <div>
            <strong>总控 Agent</strong>
            <small>描述目标后预览任务拆解、依赖顺序和项目分配</small>
          </div>
        </div>
        <textarea
          aria-label="经营目标输入框"
          placeholder="例如：为新品制定 30 天内容矩阵，并完成图文、口播和复盘方案…"
        />
        <div className="chat-toolbar">
          <span className="model-trigger">✦ GPT-5.6⌄</span>
          <button
            className="dispatch-button"
            onClick={() => onPreview("当前为设计预览，尚未运行真实 Agent")}
          >
            拆解并分配
          </button>
        </div>
      </div>

      <div className="quick-prompts">
        <span>快捷开始</span>
        <button onClick={() => onPreview("已选择：规划本月内容（设计预览）")}>
          规划本月内容
        </button>
        <button onClick={() => onPreview("已选择：拆解竞品账号（设计预览）")}>
          拆解竞品账号
        </button>
        <button onClick={() => onPreview("已选择：复盘上周数据（设计预览）")}>
          复盘上周数据
        </button>
      </div>
    </section>
  );
}
