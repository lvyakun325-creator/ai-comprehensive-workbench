"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  createChatTitle,
  createInitialChatSessionState,
  createSession,
  deleteSession as deleteChatSession,
  getActiveSession,
  getVisibleSessions,
  selectSession as selectChatSession,
  updateSession as updateChatSession,
  type ChatSession,
} from "../lib/chat-session-store.mjs";

export type ChatSessionContextValue = {
  sessions: ChatSession[];
  activeSessionId: string | null;
  activeSession: ChatSession | null;
  visibleSessions: ChatSession[];
  createEmptySession(): string;
  ensureSession(firstMessage: string): string;
  selectSession(id: string): void;
  deleteSession(id: string): void;
  updateSession(
    id: string,
    updater: (session: ChatSession) => ChatSession,
  ): void;
};

const ChatSessionContext = createContext<ChatSessionContextValue | null>(null);
let sessionSequence = 0;

function createSessionId() {
  sessionSequence += 1;
  return `chat-session-${Date.now()}-${sessionSequence}`;
}

export function ChatSessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(createInitialChatSessionState);
  const activeSession = getActiveSession(state);
  const visibleSessions = getVisibleSessions(state);

  const createEmptySession = useCallback(() => {
    const id = createSessionId();
    const now = Date.now();
    setState((current) => createSession(current, { id, now }));
    return id;
  }, []);

  const ensureSession = useCallback(
    (firstMessage: string) => {
      if (activeSession) {
        if (!activeSession.title) {
          const title = createChatTitle(firstMessage);
          setState((current) =>
            updateChatSession(current, activeSession.id, (session) => ({
              ...session,
              title,
            })),
          );
        }
        return activeSession.id;
      }

      const id = createSessionId();
      const now = Date.now();
      setState((current) =>
        createSession(current, {
          id,
          now,
          title: createChatTitle(firstMessage),
        }),
      );
      return id;
    },
    [activeSession],
  );

  const selectSession = useCallback((id: string) => {
    setState((current) => selectChatSession(current, id));
  }, []);

  const deleteSession = useCallback((id: string) => {
    setState((current) => deleteChatSession(current, id));
  }, []);

  const updateSession = useCallback(
    (
      id: string,
      updater: (session: ChatSession) => ChatSession,
    ) => {
      setState((current) => updateChatSession(current, id, updater));
    },
    [],
  );

  const value = useMemo<ChatSessionContextValue>(
    () => ({
      sessions: state.sessions,
      activeSessionId: state.activeSessionId,
      activeSession,
      visibleSessions,
      createEmptySession,
      ensureSession,
      selectSession,
      deleteSession,
      updateSession,
    }),
    [
      activeSession,
      createEmptySession,
      deleteSession,
      ensureSession,
      selectSession,
      state.activeSessionId,
      state.sessions,
      updateSession,
      visibleSessions,
    ],
  );

  return (
    <ChatSessionContext.Provider value={value}>
      {children}
    </ChatSessionContext.Provider>
  );
}

export function useChatSessions() {
  const context = useContext(ChatSessionContext);
  if (!context) {
    throw new Error("useChatSessions must be used within ChatSessionProvider");
  }
  return context;
}
