"use client";

import { useCallback, useRef, useState } from "react";
import { ChatComposer } from "./ChatComposer";
import { ChatHistorySidebar } from "./ChatHistorySidebar";
import { useChatRequestCoordinator } from "./ChatRequestCoordinatorProvider";
import { useChatSessions } from "./ChatSessionProvider";
import { ChatTranscript } from "./ChatTranscript";
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
    setChatSelectedModelId,
  } = useModelRegistry();
  const [initialDraft, setInitialDraft] = useState("");
  const [isHistoryOpen, setHistoryOpen] = useState(false);
  const historyOpenerRef = useRef<HTMLButtonElement>(null);
  const hasWorkspace = visibleSessions.length > 0;
  const hasActiveConversation = Boolean(activeSession?.messages.length);
  const input = activeSession?.draft ?? initialDraft;
  const activeSessionRequest =
    activeRequestSessionId === activeSession?.id
      ? activeSession?.pendingRequest ?? null
      : null;
  const requestingSession = sessions.find(
    (session) => session.id === activeRequestSessionId,
  );
  const otherRequestTitle =
    activeRequestSessionId && activeRequestSessionId !== activeSession?.id
      ? requestingSession?.title || "其他会话"
      : null;

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
    closeHistory();
  }

  function openSession(id: string) {
    selectSession(id);
    closeHistory();
  }

  function closeHistory() {
    historyOpenerRef.current?.focus();
    setHistoryOpen(false);
  }

  const saveScrollOffset = useCallback(
    (sessionId: string, scrollOffset: number) => {
      updateSession(sessionId, (session) =>
        session.scrollOffset === scrollOffset
          ? session
          : { ...session, scrollOffset },
      );
    },
    [updateSession],
  );

  const composer = (variant: "welcome" | "workspace") => (
    <ChatComposer
      activeRequestSessionId={activeRequestSessionId}
      activeSessionRequest={activeSessionRequest}
      connectedModels={connectedModels}
      draft={input}
      onDraftChange={updateDraft}
      onOpenModels={onOpenModels}
      onPreview={onPreview}
      onSelectModel={setChatSelectedModelId}
      onSend={submitMessage}
      onStop={() => {
        if (activeSession) stopRequest(activeSession.id);
      }}
      otherRequestTitle={otherRequestTitle}
      selectedModel={chatSelectedModel}
      variant={variant}
    />
  );

  const quickPrompts = (
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
  );

  if (!hasWorkspace) {
    return (
      <section className="control-desk">
        <div className="control-hero">
          <span className="eyebrow">CHAT AGENT</span>
          <h1>今天想聊什么，或推进什么任务？</h1>
          <p>选择一个已启用模型，开始普通对话或处理具体工作。</p>
        </div>
        {composer("welcome")}
        {quickPrompts}
      </section>
    );
  }

  return (
    <section aria-label="聊天会话" className="chat-workspace">
      <ChatHistorySidebar
        activeSessionId={activeSession?.id ?? null}
        onClose={closeHistory}
        onCreate={startNewSession}
        onDelete={deleteSession}
        onSelect={openSession}
        open={isHistoryOpen}
        sessions={visibleSessions}
      />
      <div className="chat-workspace-main">
        <header className="chat-workspace-header">
          <button
            aria-label="打开聊天历史"
            className="chat-history-open"
            onClick={() => setHistoryOpen(true)}
            ref={historyOpenerRef}
            type="button"
          >
            ☰
          </button>
          <div>
            <span>当前会话</span>
            <h1>
              {hasActiveConversation && activeSession?.title
                ? activeSession.title
                : "新对话"}
            </h1>
          </div>
          <button
            className="chat-workspace-info"
            onClick={() => onPreview("聊天内容仅保留在当前运行期")}
            type="button"
          >
            会话说明
          </button>
        </header>
        {hasActiveConversation && activeSession ? (
          <ChatTranscript
            isGenerating={Boolean(activeSessionRequest)}
            key={activeSession.id}
            onRetry={(messageId) => {
              void retryMessage(activeSession.id, messageId);
            }}
            onScrollOffsetChange={saveScrollOffset}
            retryDisabled={
              !chatSelectedModel || Boolean(activeRequestSessionId)
            }
            session={activeSession}
          />
        ) : (
          <div className="chat-workspace-empty">
            <span className="eyebrow">NEW CONVERSATION</span>
            <h2>今天想聊什么，或推进什么任务？</h2>
            <p>输入第一条消息后，这个新对话会出现在左侧历史中。</p>
            {quickPrompts}
          </div>
        )}
        {composer("workspace")}
      </div>
    </section>
  );
}
