import { useState } from "react";
import { useModelRegistry } from "./ModelRegistryProvider";

type ControlDeskProps = {
  onOpenModels: () => void;
  onPreview: (message: string) => void;
};

export function ControlDesk({ onOpenModels, onPreview }: ControlDeskProps) {
  const {
    enabledModels,
    selectedModel,
    setSelectedModelId,
  } = useModelRegistry();
  const [isModelPickerOpen, setModelPickerOpen] = useState(false);

  return (
    <section className="control-desk">
      <div className="control-hero">
        <span className="eyebrow">CHAT AGENT</span>
        <h1>今天想聊什么，或推进什么任务？</h1>
        <p>选择一个已启用模型，开始普通对话或处理具体工作。</p>
      </div>

      <div className="chat-card">
        <div className="chat-label">
          <span className="ai-dot">✦</span>
          <div>
            <strong>聊天智能体</strong>
            <small>选择模型后，直接描述你想完成的事情</small>
          </div>
        </div>
        <textarea
          aria-label="聊天消息输入框"
          placeholder="例如：帮我复盘上周经营数据，先找出最影响利润的三个问题…"
        />
        <div className="chat-toolbar">
          <div className="attach-actions">
            <button
              aria-label="添加附件"
              onClick={() => onPreview("附件功能尚未接入")}
              type="button"
            >
              ＋
            </button>
            <button
              aria-label="工具"
              onClick={() => onPreview("工具功能尚未接入")}
              type="button"
            >
              ◇
            </button>
            <button
              aria-label="语音输入"
              className="voice-button"
              onClick={() => onPreview("语音输入尚未接入")}
              type="button"
            >
              ◉
            </button>
          </div>
          <div className="send-actions">
            <div className="model-select">
              {enabledModels.length === 0 ? (
                <button
                  className="empty-model-action"
                  onClick={onOpenModels}
                  type="button"
                >
                  请先添加模型
                </button>
              ) : (
                <>
                  <button
                    aria-controls="enabled-model-picker"
                    aria-expanded={isModelPickerOpen}
                    aria-label={`选择模型，当前 ${selectedModel?.displayName ?? "未选择"}`}
                    className="model-trigger"
                    onClick={() => setModelPickerOpen((isOpen) => !isOpen)}
                    type="button"
                  >
                    <span className="model-orb">✦</span>
                    {selectedModel?.displayName ?? "选择模型"}
                    <em>⌄</em>
                  </button>
                  {isModelPickerOpen ? (
                    <div
                      aria-label="已启用模型"
                      className="model-menu"
                      id="enabled-model-picker"
                      role="group"
                    >
                      <div className="model-menu-head">
                        <div>
                          <strong>选择模型</strong>
                          <small>仅显示全局已启用模型</small>
                        </div>
                        <button
                          aria-label="关闭模型选择"
                          onClick={() => setModelPickerOpen(false)}
                          type="button"
                        >
                          ×
                        </button>
                      </div>
                      <div className="model-group">
                        <span>可用模型</span>
                        {enabledModels.map((model) => (
                          <button
                            className={selectedModel?.id === model.id ? "selected" : ""}
                            key={model.id}
                            onClick={() => {
                              setSelectedModelId(model.id);
                              setModelPickerOpen(false);
                            }}
                            type="button"
                          >
                            <strong>{model.displayName}</strong>
                            <small>{model.provider} · {model.modelId}</small>
                          </button>
                        ))}
                      </div>
                      <button
                        className="configure-row"
                        onClick={onOpenModels}
                        type="button"
                      >
                        管理模型配置
                      </button>
                    </div>
                  ) : null}
                </>
              )}
            </div>
            <button
              className="chat-send-button"
              disabled={!selectedModel}
              onClick={() => onPreview("当前为界面预览，真实聊天模型尚未接入")}
              type="button"
            >
              发送
            </button>
          </div>
        </div>
      </div>

      <div className="quick-prompts">
        <span>快捷开始</span>
        <button onClick={() => onPreview("已选择：规划本月内容（设计预览）")}>
          规划本月内容
        </button>
        <button onClick={() => onPreview("已选择：分析竞品账号（设计预览）")}>
          分析竞品账号
        </button>
        <button onClick={() => onPreview("已选择：复盘上周数据（设计预览）")}>
          复盘上周数据
        </button>
      </div>
    </section>
  );
}
