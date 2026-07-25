"use client";

import { useState } from "react";

type Tool = {
  index: string;
  title: string;
  description: string;
  tag: string;
  icon: string;
  accent: string;
};

const tools: Tool[] = [
  {
    index: "01",
    title: "内容矩阵设计",
    description: "从业务目标到账号定位，搭建可持续的内容矩阵。",
    tag: "战略",
    icon: "▦",
    accent: "violet",
  },
  {
    index: "02",
    title: "竞品洞察",
    description: "拆解竞品内容、渠道与打法，识别可落地的增长机会。",
    tag: "洞察",
    icon: "⌕",
    accent: "blue",
  },
  {
    index: "03",
    title: "选题策划",
    description: "围绕人群、场景和产品，建立高质量选题池。",
    tag: "策划",
    icon: "✦",
    accent: "orange",
  },
  {
    index: "04",
    title: "标题策划",
    description: "兼顾点击、搜索与合规，批量生成标题方向。",
    tag: "转化",
    icon: "Aa",
    accent: "pink",
  },
  {
    index: "05",
    title: "新媒体图文生成器",
    description: "从文案到配图，一站式产出多平台图文内容。",
    tag: "生产",
    icon: "◫",
    accent: "cyan",
  },
  {
    index: "06",
    title: "超级 AI 写作系统",
    description: "沉淀品牌语气、资料与模板，完成长短内容写作。",
    tag: "写作",
    icon: "✎",
    accent: "indigo",
  },
  {
    index: "07",
    title: "爆款拆解与口播生成",
    description: "拆解内容结构与传播钩子，生成自然口播脚本。",
    tag: "短视频",
    icon: "▶",
    accent: "red",
  },
  {
    index: "08",
    title: "新媒体获客视频工作台",
    description: "串联脚本、配音、画面和成片的完整生产流程。",
    tag: "视频",
    icon: "◉",
    accent: "green",
  },
  {
    index: "09",
    title: "数据复盘",
    description: "围绕流量、转化、产能与复购，找到下一步动作。",
    tag: "经营",
    icon: "↗",
    accent: "yellow",
  },
];

const modelGroups = [
  {
    name: "OpenAI",
    models: ["GPT-5.6", "GPT-5.6 Thinking", "GPT-4.1"],
  },
  {
    name: "Anthropic",
    models: ["Claude Opus 4.7", "Claude Sonnet 4.6"],
  },
  {
    name: "Google",
    models: ["Gemini 3 Pro", "Gemini 3 Flash"],
  },
  {
    name: "国产模型",
    models: ["通义千问 3", "DeepSeek V3.2", "豆包 2.0"],
  },
];

export default function Home() {
  const [selectedModel, setSelectedModel] = useState("GPT-5.6");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [toast, setToast] = useState("");

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  };

  return (
    <main className="app-shell">
      <aside className="side-rail" aria-label="主导航">
        <button className="brand-mark" aria-label="返回工作台首页">
          <span>A</span>
        </button>
        <nav className="rail-nav">
          <button className="rail-button active" aria-label="工作台">
            <span>⌂</span>
            <small>工作台</small>
          </button>
          <button className="rail-button" aria-label="AI 对话">
            <span>✦</span>
            <small>对话</small>
          </button>
          <button className="rail-button" aria-label="项目">
            <span>▱</span>
            <small>项目</small>
          </button>
          <button className="rail-button" aria-label="数据">
            <span>↗</span>
            <small>数据</small>
          </button>
        </nav>
        <button
          className="rail-button rail-bottom"
          aria-label="系统设置"
          onClick={() => setConfigOpen(true)}
        >
          <span>⚙</span>
          <small>设置</small>
        </button>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="wordmark">
            <div className="logo-glyph">A</div>
            <div>
              <strong>AI 综合工作台</strong>
              <span>内容增长与经营决策中心</span>
            </div>
          </div>
          <div className="top-actions">
            <div className="status-pill">
              <i />
              本地设计预览
            </div>
            <button className="ghost-button" onClick={() => notify("使用指南将在下一阶段接入")}>
              使用指南
            </button>
            <button className="avatar-button" aria-label="用户菜单">
              <span>吕</span>
              <b>吕亚坤</b>
              <em>⌄</em>
            </button>
          </div>
        </header>

        <div className="content">
          <section className="hero">
            <div className="hero-copy">
              <span className="eyebrow">YOUR AI OPERATING SYSTEM</span>
              <h1>
                吕亚坤，下午好
                <br />
                <span>今天想推进什么？</span>
              </h1>
              <p>从策略、创作到复盘，把新媒体经营流程集中在一个工作台。</p>
            </div>

            <div className="chat-card">
              <div className="chat-label">
                <span className="ai-dot">✦</span>
                <div>
                  <strong>AI 经营助手</strong>
                  <small>直接描述目标，我会帮你匹配合适的工作台</small>
                </div>
                <button className="expand-button" aria-label="展开对话">
                  ↗
                </button>
              </div>
              <textarea
                aria-label="对话输入框"
                placeholder="例如：帮我规划一套适合医药电商的 30 天内容矩阵…"
              />
              <div className="chat-toolbar">
                <div className="attach-actions">
                  <button aria-label="添加附件">＋</button>
                  <button>
                    <span>◇</span> 工具
                  </button>
                </div>
                <div className="send-actions">
                  <div className="model-select">
                    <button
                      className="model-trigger"
                      aria-expanded={modelMenuOpen}
                      onClick={() => setModelMenuOpen(!modelMenuOpen)}
                    >
                      <span className="model-orb">✦</span>
                      {selectedModel}
                      <em>⌄</em>
                    </button>
                    {modelMenuOpen && (
                      <div className="model-menu">
                        <div className="model-menu-head">
                          <div>
                            <strong>选择模型</strong>
                            <small>按任务切换最合适的模型</small>
                          </div>
                          <button
                            aria-label="配置模型"
                            onClick={() => {
                              setModelMenuOpen(false);
                              setConfigOpen(true);
                            }}
                          >
                            ⚙
                          </button>
                        </div>
                        {modelGroups.map((group) => (
                          <div className="model-group" key={group.name}>
                            <span>{group.name}</span>
                            {group.models.map((model) => (
                              <button
                                className={model === selectedModel ? "selected" : ""}
                                key={model}
                                onClick={() => {
                                  setSelectedModel(model);
                                  setModelMenuOpen(false);
                                }}
                              >
                                {model}
                                {model === selectedModel && <b>✓</b>}
                              </button>
                            ))}
                          </div>
                        ))}
                        <button
                          className="configure-row"
                          onClick={() => {
                            setModelMenuOpen(false);
                            setConfigOpen(true);
                          }}
                        >
                          ＋ 配置新的模型服务
                        </button>
                      </div>
                    )}
                  </div>
                  <button className="voice-button" aria-label="语音输入">
                    ◉
                  </button>
                  <button
                    className="send-button"
                    aria-label="发送"
                    onClick={() => notify("当前为 UI 设计稿，模型能力尚未接入")}
                  >
                    ↑
                  </button>
                </div>
              </div>
            </div>

            <div className="quick-prompts">
              <span>快捷开始</span>
              <button onClick={() => notify("已选择：规划本月内容")}>规划本月内容</button>
              <button onClick={() => notify("已选择：拆解竞品账号")}>拆解竞品账号</button>
              <button onClick={() => notify("已选择：复盘上周数据")}>复盘上周数据</button>
            </div>
          </section>

          <section className="tools-section">
            <div className="section-heading">
              <div>
                <span className="eyebrow">CONTENT GROWTH WORKFLOW</span>
                <h2>九大核心工作台</h2>
                <p>按经营链路排列：先定方向，再做内容，最后看结果。</p>
              </div>
              <div className="workflow-legend" aria-label="工作流阶段">
                <span><i className="strategy" />策略洞察</span>
                <b>→</b>
                <span><i className="production" />内容生产</span>
                <b>→</b>
                <span><i className="review" />经营复盘</span>
              </div>
            </div>

            <div className="tools-grid">
              {tools.map((tool) => (
                <button
                  className={`tool-card ${tool.accent}`}
                  key={tool.title}
                  onClick={() => notify(`${tool.title}：当前展示为 UI 入口`)}
                >
                  <div className="card-topline">
                    <span className="tool-icon">{tool.icon}</span>
                    <span className="tool-tag">{tool.tag}</span>
                    <span className="tool-index">{tool.index}</span>
                  </div>
                  <h3>{tool.title}</h3>
                  <p>{tool.description}</p>
                  <div className="card-footer">
                    <span>进入工作台</span>
                    <b>↗</b>
                  </div>
                </button>
              ))}
            </div>
          </section>
        </div>
      </div>

      {configOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setConfigOpen(false)}>
          <section
            className="config-panel"
            role="dialog"
            aria-modal="true"
            aria-label="大模型配置"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span className="eyebrow">MODEL CONNECTIONS</span>
                <h2>大模型配置</h2>
                <p>统一管理不同服务商，具体密钥将在接口阶段接入。</p>
              </div>
              <button aria-label="关闭" onClick={() => setConfigOpen(false)}>
                ×
              </button>
            </header>
            <div className="provider-list">
              {[
                ["OpenAI", "GPT 系列", "已规划", "O"],
                ["Anthropic", "Claude 系列", "待配置", "A"],
                ["Google AI", "Gemini 系列", "待配置", "G"],
                ["阿里云百炼", "通义千问系列", "待配置", "Q"],
                ["DeepSeek", "DeepSeek 系列", "待配置", "D"],
                ["火山方舟", "豆包系列", "待配置", "V"],
              ].map(([provider, models, status, letter]) => (
                <div className="provider-row" key={provider}>
                  <span className="provider-logo">{letter}</span>
                  <div>
                    <strong>{provider}</strong>
                    <small>{models}</small>
                  </div>
                  <span className={status === "已规划" ? "provider-status planned" : "provider-status"}>
                    {status}
                  </span>
                  <button onClick={() => notify("本轮只设计入口，暂不填写或保存 API 密钥")}>
                    配置
                  </button>
                </div>
              ))}
            </div>
            <div className="config-note">
              <span>i</span>
              <p>
                安全设计：密钥默认仅保存在服务端，不在浏览器页面明文展示；这一规则会在接口阶段落实。
              </p>
            </div>
          </section>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}
