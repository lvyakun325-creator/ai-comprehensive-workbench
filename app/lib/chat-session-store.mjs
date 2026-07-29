export const CHAT_TITLE_MAX_LENGTH = 24;

export function createInitialChatSessionState() {
  return {
    sessions: [],
    activeSessionId: null,
  };
}

export function createChatTitle(content) {
  const visibleContent = typeof content === "string" ? content.trim() : "";
  if (!visibleContent) return "";
  if (visibleContent.length <= CHAT_TITLE_MAX_LENGTH) return visibleContent;
  return `${visibleContent.slice(0, CHAT_TITLE_MAX_LENGTH)}…`;
}

export function createSession(state, options) {
  const session = {
    id: options.id,
    title: options.title ?? "",
    messages: options.messages ? [...options.messages] : [],
    createdAt: options.now,
    updatedAt: options.updatedAt ?? options.now,
    draft: options.draft ?? "",
    pendingRequest: options.pendingRequest ?? null,
    scrollOffset: options.scrollOffset ?? 0,
  };

  return {
    ...state,
    sessions: [...state.sessions, session],
    activeSessionId: session.id,
  };
}

export function selectSession(state, sessionId) {
  if (!state.sessions.some((session) => session.id === sessionId)) {
    return state;
  }
  return { ...state, activeSessionId: sessionId };
}

export function deleteSession(state, sessionId) {
  const sessions = state.sessions.filter((session) => session.id !== sessionId);
  if (sessions.length === state.sessions.length) return state;

  if (state.activeSessionId !== sessionId) {
    return { ...state, sessions };
  }

  const mostRecentlyUpdated = [...sessions].sort(
    (left, right) => right.updatedAt - left.updatedAt,
  )[0];
  return {
    ...state,
    sessions,
    activeSessionId: mostRecentlyUpdated?.id ?? null,
  };
}

export function updateSession(state, sessionId, updater) {
  let updated = false;
  const sessions = state.sessions.map((session) => {
    if (session.id !== sessionId) return session;
    updated = true;
    return updater(session);
  });
  return updated ? { ...state, sessions } : state;
}

export function getVisibleSessions(state) {
  return state.sessions
    .filter((session) => session.messages.length > 0)
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export function getActiveSession(state) {
  return state.sessions.find((session) => session.id === state.activeSessionId) ?? null;
}
