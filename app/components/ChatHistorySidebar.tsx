"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatSessionHistoryItem } from "../lib/chat-session-store.mjs";

export type ChatHistorySidebarProps = {
  sessions: ChatSessionHistoryItem[];
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
  const cancelDeleteButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const deleteTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const drawerRef = useRef<HTMLDivElement>(null);
  const focusAfterDeleteRef = useRef(false);
  const restoreDeleteTriggerIdRef = useRef<string | null>(null);
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

  useLayoutEffect(() => {
    if (pendingDeleteId) {
      cancelDeleteButtonRef.current?.focus();
      return;
    }
    const triggerId = restoreDeleteTriggerIdRef.current;
    if (triggerId) {
      restoreDeleteTriggerIdRef.current = null;
      deleteTriggerRefs.current.get(triggerId)?.focus();
      return;
    }
    if (focusAfterDeleteRef.current) {
      focusAfterDeleteRef.current = false;
      createButtonRef.current?.focus();
    }
  }, [pendingDeleteId]);

  useEffect(() => {
    if (!pendingDeleteId) return;
    const triggerId = pendingDeleteId;
    const cancelConfirmation = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      restoreDeleteTriggerIdRef.current = triggerId;
      setPendingDeleteId(null);
    };
    document.addEventListener("keydown", cancelConfirmation, true);
    return () =>
      document.removeEventListener("keydown", cancelConfirmation, true);
  }, [pendingDeleteId]);

  useEffect(() => {
    if (!isMobile || !open) return;

    const handleModalKeydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        restoreDeleteTriggerIdRef.current = null;
        setPendingDeleteId(null);
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

  function closeSidebar() {
    restoreDeleteTriggerIdRef.current = null;
    setPendingDeleteId(null);
    onClose();
  }

  function renderGroup(
    label: string,
    groupedSessions: ChatSessionHistoryItem[],
  ) {
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
                  aria-label={
                    session.isDraft
                      ? `打开草稿：${session.displayTitle}`
                      : `打开会话：${session.displayTitle}`
                  }
                  className="chat-history-select"
                  onClick={() => onSelect(session.id)}
                  tabIndex={drawerHidden ? -1 : undefined}
                  type="button"
                >
                  <span className="chat-history-title">
                    <strong>{session.displayTitle}</strong>
                    {session.isDraft ? <em>草稿</em> : null}
                  </span>
                  <small>
                    {new Date(session.updatedAt).toLocaleTimeString("zh-CN", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </small>
                </button>
                <button
                  aria-label={`删除会话：${session.displayTitle}`}
                  className="chat-history-delete"
                  onClick={() => {
                    restoreDeleteTriggerIdRef.current = null;
                    setPendingDeleteId(session.id);
                  }}
                  ref={(element) => {
                    if (element) {
                      deleteTriggerRefs.current.set(session.id, element);
                    } else {
                      deleteTriggerRefs.current.delete(session.id);
                    }
                  }}
                  tabIndex={drawerHidden ? -1 : undefined}
                  type="button"
                >
                  ×
                </button>
                {isDeleting ? (
                  <div
                    aria-label={`确认删除会话：${session.displayTitle}`}
                    className="chat-delete-confirmation"
                    role="alertdialog"
                  >
                    <p>删除后无法恢复，确认删除这条会话吗？</p>
                    <div>
                      <button
                        onClick={() => {
                          restoreDeleteTriggerIdRef.current = session.id;
                          setPendingDeleteId(null);
                        }}
                        ref={cancelDeleteButtonRef}
                        tabIndex={drawerHidden ? -1 : undefined}
                        type="button"
                      >
                        取消
                      </button>
                      <button
                        className="danger"
                        onClick={() => {
                          focusAfterDeleteRef.current = true;
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
        onClick={closeSidebar}
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
            onClick={closeSidebar}
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
          onClick={() => {
            setPendingDeleteId(null);
            onCreate();
          }}
          ref={createButtonRef}
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
