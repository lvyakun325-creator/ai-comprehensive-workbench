"use client";

import { useLayoutEffect, useRef } from "react";
import type { ChatSession } from "../lib/chat-session-store.mjs";

const NEAR_BOTTOM_THRESHOLD = 96;

type ChatTranscriptProps = {
  session: ChatSession;
  isGenerating: boolean;
  retryDisabled: boolean;
  onRetry(userMessageId: string): void;
  onScrollOffsetChange(sessionId: string, scrollOffset: number): void;
};

export function ChatTranscript({
  session,
  isGenerating,
  retryDisabled,
  onRetry,
  onScrollOffsetChange,
}: ChatTranscriptProps) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;

    transcript.scrollTop = session.scrollOffset;
    wasNearBottomRef.current =
      transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop
      <= NEAR_BOTTOM_THRESHOLD;

    return () => {
      onScrollOffsetChange(session.id, transcript.scrollTop);
    };
  }, [onScrollOffsetChange, session.id, session.scrollOffset]);

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript || !wasNearBottomRef.current) return;
    transcript.scrollTop = transcript.scrollHeight;
  }, [isGenerating, session.messages.length]);

  return (
    <div
      aria-label="聊天记录"
      aria-live="polite"
      aria-relevant="additions text"
      className="chat-transcript"
      onScroll={(event) => {
        const transcript = event.currentTarget;
        wasNearBottomRef.current =
          transcript.scrollHeight
            - transcript.clientHeight
            - transcript.scrollTop
          <= NEAR_BOTTOM_THRESHOLD;
      }}
      ref={transcriptRef}
      role="log"
    >
      <div className="chat-transcript-inner">
        {session.messages.map((message) => (
          <article
            className={`chat-message ${message.role}`}
            key={message.id}
          >
            <small>{message.role === "user" ? "你" : message.modelName}</small>
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
                  disabled={retryDisabled}
                  onClick={() => onRetry(message.id)}
                  type="button"
                >
                  重新发送
                </button>
              </div>
            ) : null}
          </article>
        ))}
        {isGenerating && session.pendingRequest ? (
          <div
            aria-label="聊天回复状态"
            className="chat-pending"
            role="status"
          >
            {session.pendingRequest.modelName} 正在回复…
          </div>
        ) : null}
      </div>
    </div>
  );
}
