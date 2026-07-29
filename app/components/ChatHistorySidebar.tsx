"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatSession } from "../lib/chat-session-store.mjs";

export type ChatHistorySidebarProps = {
  sessions: ChatSession[];
  activeSessionId: string | null;
  open: boolean;
  onClose(): void;
  onCreate(): void;
  onSelect(id: string): void;
  onDelete(id: string): void;
};

function isToday(timestamp: number) {
  return new Date(timestamp).toDateString() === new Date().toDateString();
}

export function ChatHistorySidebar({
  sessions,
  activeSessionId,
  open,
  onClose,
  onCreate,
  onSelect,
  onDelete,
}: ChatHistorySidebarProps) {
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const drawerHidden = isMobile && !open;
  const todaySessions = sessions.filter((session) =>
    isToday(session.updatedAt),
  );
  const earlierSessions = sessions.filter(
    (session) => !isToday(session.updatedAt),
  );

  useEffect(() => {
    const updateViewport = () => setIsMobile(window.innerWidth <= 760);
    updateViewport();
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  useEffect(() => {
    if (!isMobile || !open) return;
    closeButtonRef.current?.focus();
  }, [isMobile, open]);

  useEffect(() => {
    if (!isMobile || !open) return;

    const handleModalKeydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const drawer = drawerRef.current;
      if (!drawer) return;
      const focusableElements = Array.from(
        drawer.querySelectorAll<HTMLElement>(
          'button:not([disabled]):not([tabindex="-1"]), [href]:not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      const firstFocusable = focusableElements[0];
      const lastFocusable = focusableElements.at(-1);
      if (!firstFocusable || !lastFocusable) return;

      const activeElement = document.activeElement;
      const focusEscapesBackward =
        event.shiftKey &&
        (activeElement === firstFocusable || !drawer.contains(activeElement));
      const focusEscapesForward =
        !event.shiftKey &&
        (activeElement === lastFocusable || !drawer.contains(activeElement));
      if (!focusEscapesBackward && !focusEscapesForward) return;

      event.preventDefault();
      (event.shiftKey ? lastFocusable : firstFocusable).focus();
    };
    document.addEventListener("keydown", handleModalKeydown);
    return () => document.removeEventListener("keydown", handleModalKeydown);
  }, [isMobile, onClose, open]);

  function renderGroup(label: string, groupedSessions: ChatSession[]) {
    if (groupedSessions.length === 0) return null;

    return (
      <section className="chat-history-group" key={label}>
        <h2>{label}</h2>
        <div className="chat-history-list">
          {groupedSessions.map((session) => {
            const isDeleting = pendingDeleteId === session.id;

            return (
              <div className="chat-history-item" key={session.id}>
                <button
                  aria-current={
                    session.id === activeSessionId ? "page" : undefined
                  }
                  aria-label={`打开会话：${session.title}`}
                  className="chat-history-select"
                  onClick={() => onSelect(session.id)}
                  tabIndex={drawerHidden ? -1 : undefined}
                  type="button"
                >
                  <strong>{session.title}</strong>
                  <small>
                    {new Date(session.updatedAt).toLocaleTimeString("zh-CN", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </small>
                </button>
                <button
                  aria-label={`删除会话：${session.title}`}
                  className="chat-history-delete"
                  onClick={() => setPendingDeleteId(session.id)}
                  tabIndex={drawerHidden ? -1 : undefined}
                  type="button"
                >
                  ×
                </button>
                {isDeleting ? (
                  <div
                    aria-label={`确认删除会话：${session.title}`}
                    className="chat-delete-confirmation"
                    role="alertdialog"
                  >
                    <p>删除后无法恢复，确认删除这条会话吗？</p>
                    <div>
                      <button
                        onClick={() => setPendingDeleteId(null)}
                        tabIndex={drawerHidden ? -1 : undefined}
                        type="button"
                      >
                        取消
                      </button>
                      <button
                        className="danger"
                        onClick={() => {
                          setPendingDeleteId(null);
                          onDelete(session.id);
                        }}
                        tabIndex={drawerHidden ? -1 : undefined}
                        type="button"
                      >
                        确认删除
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>
    );
  }

  return (
    <div
      aria-hidden={drawerHidden ? "true" : undefined}
      aria-label={isMobile ? "聊天历史抽屉" : undefined}
      aria-modal={isMobile && open ? "true" : undefined}
      className={`chat-history-drawer ${open ? "open" : ""}`}
      inert={drawerHidden ? true : undefined}
      ref={drawerRef}
      role={isMobile ? "dialog" : undefined}
    >
      <button
        aria-hidden="true"
        className="chat-history-backdrop"
        onClick={onClose}
        tabIndex={-1}
        type="button"
      />
      <nav aria-label="聊天历史" className="chat-history-sidebar">
        <div className="chat-history-head">
          <div>
            <span>CHAT HISTORY</span>
            <strong>对话记录</strong>
          </div>
          <button
            aria-label="关闭聊天历史"
            className="chat-history-close"
            onClick={onClose}
            ref={closeButtonRef}
            tabIndex={drawerHidden ? -1 : undefined}
            type="button"
          >
            ×
          </button>
        </div>
        <button
          aria-label="新建会话"
          className="chat-history-create"
          onClick={onCreate}
          tabIndex={drawerHidden ? -1 : undefined}
          type="button"
        >
          <span>＋</span>
          发起新对话
        </button>
        {renderGroup("今天", todaySessions)}
        {renderGroup("更早", earlierSessions)}
      </nav>
    </div>
  );
}
