"use client";

import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { ChatPendingRequestState } from "../lib/chat-session-store.mjs";
import type { ChatModel } from "../lib/model-registry.mjs";

type ChatComposerProps = {
  draft: string;
  connectedModels: ChatModel[];
  selectedModel: ChatModel | null;
  activeRequestSessionId: string | null;
  activeSessionRequest: ChatPendingRequestState | null;
  otherRequestTitle: string | null;
  variant: "welcome" | "workspace";
  onDraftChange(value: string): void;
  onSend(): void;
  onStop(): void;
  onSelectModel(id: string): void;
  onOpenModels(): void;
  onPreview(message: string): void;
};

export function ChatComposer({
  draft,
  connectedModels,
  selectedModel,
  activeRequestSessionId,
  activeSessionRequest,
  otherRequestTitle,
  variant,
  onDraftChange,
  onSend,
  onStop,
  onSelectModel,
  onOpenModels,
  onPreview,
}: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isModelPickerOpen, setModelPickerOpen] = useState(false);
  const sendDisabled =
    !draft.trim() || !selectedModel || Boolean(activeRequestSessionId);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draft]);

  function refocusAfterSend() {
    const focus = () => textareaRef.current?.focus();
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(focus);
    } else {
      focus();
    }
  }

  function submit() {
    if (sendDisabled) return;
    onSend();
    refocusAfterSend();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "Enter"
      && !event.shiftKey
      && !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div
      className={
        variant === "welcome"
          ? "chat-card chat-composer chat-composer-welcome"
          : "chat-composer chat-workspace-composer"
      }
    >
      {variant === "welcome" ? (
        <div className="chat-label">
          <span className="ai-dot">✦</span>
          <div>
            <strong>聊天智能体</strong>
            <small>选择模型后，直接描述你想完成的事情</small>
          </div>
        </div>
      ) : null}
      <textarea
        aria-label="聊天消息输入框"
        autoFocus={variant === "workspace"}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="例如：帮我复盘上周经营数据，先找出最影响利润的三个问题…"
        ref={textareaRef}
        rows={1}
        value={draft}
      />
      {otherRequestTitle ? (
        <div aria-label="活动会话提示" className="chat-pending" role="status">
          会话「{otherRequestTitle}」正在回复，当前会话可继续编辑草稿。另一会话正在生成，发送需等待。
        </div>
      ) : null}
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
            {connectedModels.length === 0 ? (
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
                      {connectedModels.map((model) => (
                        <button
                          className={
                            selectedModel?.id === model.id ? "selected" : ""
                          }
                          key={model.id}
                          onClick={() => {
                            onSelectModel(model.id);
                            setModelPickerOpen(false);
                          }}
                          type="button"
                        >
                          <strong>{model.displayName}</strong>
                          <small>
                            {model.provider} · {model.modelId}
                          </small>
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
            disabled={sendDisabled}
            onClick={submit}
            type="button"
          >
            发送
          </button>
          {activeSessionRequest ? (
            <button
              aria-label="停止"
              className="chat-stop-button"
              onClick={onStop}
              type="button"
            >
              停止生成
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
