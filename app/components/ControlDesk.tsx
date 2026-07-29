import { useState } from "react";
import { useChatRequestCoordinator } from "./ChatRequestCoordinatorProvider";
import { useChatSessions } from "./ChatSessionProvider";
import { useModelRegistry } from "./ModelRegistryProvider";

type ControlDeskProps = {
  onOpenModels: () => void;
  onPreview: (message: string) => void;
};

export function ControlDesk({ onOpenModels, onPreview }: ControlDeskProps) {
  const {
    sessions,
    activeSession,
    visibleSessions,
    createEmptySession,
    deleteSession,
    ensureSession,
    selectSession,
    updateSession,
  } = useChatSessions();
  const {
    activeRequestSessionId,
    retryMessage,
    sendMessage,
    stopRequest,
  } = useChatRequestCoordinator();
  const {
    connectedModels,
    chatSelectedModel,
    chatSelectedModelId,
    setChatSelectedModelId,
  } = useModelRegistry();
  const [isModelPickerOpen, setModelPickerOpen] = useState(false);
  const [initialDraft, setInitialDraft] = useState("");
  const messages = activeSession?.messages ?? [];
  const input = activeSession?.draft ?? initialDraft;
  const activeSessionRequest =
    activeRequestSessionId === activeSession?.id
      ? activeSession?.pendingRequest ?? null
      : null;
  const requestingSession = sessions.find(
    (session) => session.id === activeRequestSessionId,
  );

  function submitMessage() {
    const content = input.trim();
    if (!content || !chatSelectedModel || activeRequestSessionId) return;
    const sessionId = ensureSession(content);
    setInitialDraft("");
    void sendMessage(sessionId, content);
  }

  function updateDraft(value: string) {
    if (!activeSession) {
      setInitialDraft(value);
      return;
    }
    updateSession(activeSession.id, (session) => ({
      ...session,
      draft: value,
    }));
  }

  function startNewSession() {
    setInitialDraft("");
    createEmptySession();
  }

  function openSession(id: string) {
    selectSession(id);
  }

  return (
    <section
      aria-label={sessions.length > 0 ? "聊天会话" : undefined}
      className="control-desk"
    >
      {sessions.length > 0 ? (
        <nav aria-label="聊天历史" className="chat-session-history">
          <button onClick={startNewSession} type="button">
            新建会话
          </button>
          {visibleSessions.map((session) => (
            <span className="chat-session-history-item" key={session.id}>
              <input
                aria-current={
                  session.id === activeSession?.id ? "page" : undefined
                }
                aria-label={`打开会话：${session.title}`}
                onClick={() => openSession(session.id)}
                type="button"
                value={`会话 · ${session.title}`}
              />
              <button
                aria-label={`删除会话：${session.title}`}
                onClick={() => deleteSession(session.id)}
                type="button"
              >
                ×
              </button>
            </span>
          ))}
        </nav>
      ) : null}
      <div className="control-hero">
        <span className="eyebrow">CHAT AGENT</span>
        <h1 aria-label={activeSession?.title || undefined}>
          {activeSession?.title
            ? "当前会话"
            : "今天想聊什么，或推进什么任务？"}
        </h1>
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
          onChange={(event) => updateDraft(event.target.value)}
          placeholder="例如：帮我复盘上周经营数据，先找出最影响利润的三个问题…"
          value={input}
        />
        {activeRequestSessionId && activeRequestSessionId !== activeSession?.id ? (
          <div aria-label="活动会话提示" className="chat-pending" role="status">
            会话「{requestingSession?.title || "其他会话"}」正在回复，当前会话可继续编辑草稿，发送需等待。
          </div>
        ) : null}
        {messages.length > 0 ? (
          <section
            aria-label="聊天记录"
            aria-live="polite"
            aria-relevant="additions text"
            className="chat-transcript"
            role="log"
          >
            {messages.map((message) => (
              <article
                className={`chat-message ${message.role}`}
                key={message.id}
              >
                <small>
                  {message.role === "user" ? "你" : message.modelName}
                </small>
                <p>{message.content}</p>
                {message.status === "stopped" ? (
                  <small className="chat-message-status">已停止</small>
                ) : null}
                {message.status === "failed" ? (
                  <div className="chat-error" role="alert">
                    <span>
                      <strong>发送失败</strong>
                      {message.errorMessage ? `：${message.errorMessage}` : ""}
                    </span>
                    <button
                      disabled={
                        !chatSelectedModel || Boolean(activeRequestSessionId)
                      }
                      onClick={() => {
                        if (activeSession) {
                          void retryMessage(activeSession.id, message.id);
                        }
                      }}
                      type="button"
                    >
                      重新发送
                    </button>
                  </div>
                ) : null}
              </article>
            ))}
            {activeSessionRequest ? (
              <div
                aria-label="聊天回复状态"
                className="chat-pending"
                role="status"
              >
                {activeSessionRequest.modelName} 正在回复…
              </div>
            ) : null}
          </section>
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
                    aria-label={`选择模型，当前 ${chatSelectedModel?.displayName ?? "未选择"}`}
                    className="model-trigger"
                    onClick={() => setModelPickerOpen((isOpen) => !isOpen)}
                    type="button"
                  >
                    <span className="model-orb">✦</span>
                    {chatSelectedModel?.displayName ?? "选择模型"}
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
                            className={chatSelectedModel?.id === model.id ? "selected" : ""}
                            key={model.id}
                            onClick={() => {
                              setChatSelectedModelId(model.id);
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
              disabled={
                !input.trim()
                || !chatSelectedModel
                || Boolean(activeRequestSessionId)
              }
              onClick={submitMessage}
              type="button"
            >
              发送
            </button>
            {activeSessionRequest ? (
              <button
                className="chat-stop-button"
                onClick={() => {
                  if (activeSession) stopRequest(activeSession.id);
                }}
                type="button"
              >
                停止
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="quick-prompts">
        <span>快捷开始</span>
        <button onClick={() => updateDraft("规划本月内容")} type="button">
          规划本月内容
        </button>
        <button onClick={() => updateDraft("分析竞品账号")} type="button">
          分析竞品账号
        </button>
        <button onClick={() => updateDraft("复盘上周数据")} type="button">
          复盘上周数据
        </button>
      </div>
    </section>
  );
}
