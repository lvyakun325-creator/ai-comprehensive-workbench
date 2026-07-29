export const CHAT_TITLE_MAX_LENGTH = 24;

const COMBINING_MARK = /\p{Mark}/u;
const EMOJI_MODIFIER = /\p{Emoji_Modifier}/u;
const REGIONAL_INDICATOR = /\p{Regional_Indicator}/u;

function fallbackGraphemes(content) {
  const graphemes = [];
  for (const symbol of Array.from(content)) {
    const previous = graphemes.at(-1);
    if (!previous) {
      graphemes.push(symbol);
      continue;
    }

    const previousIsOddRegionalSequence =
      REGIONAL_INDICATOR.test(symbol)
      && Array.from(previous).every((part) => REGIONAL_INDICATOR.test(part))
      && Array.from(previous).length % 2 === 1;
    const joinsPrevious =
      COMBINING_MARK.test(symbol)
      || EMOJI_MODIFIER.test(symbol)
      || symbol === "\u200d"
      || previous.endsWith("\u200d")
      || previousIsOddRegionalSequence;
    if (joinsPrevious) {
      graphemes[graphemes.length - 1] += symbol;
    } else {
      graphemes.push(symbol);
    }
  }
  return graphemes;
}

function splitGraphemes(content) {
  if (typeof Intl.Segmenter === "function") {
    try {
      const segmenter = new Intl.Segmenter(undefined, {
        granularity: "grapheme",
      });
      return Array.from(
        segmenter.segment(content),
        ({ segment }) => segment,
      );
    } catch {
      // Fall through to the code-point-safe grouping below.
    }
  }
  return fallbackGraphemes(content);
}

export function createInitialChatSessionState() {
  return {
    sessions: [],
    activeSessionId: null,
  };
}

export function createChatTitle(content) {
  const visibleContent = typeof content === "string" ? content.trim() : "";
  if (!visibleContent) return "";
  const graphemes = splitGraphemes(visibleContent);
  if (graphemes.length <= CHAT_TITLE_MAX_LENGTH) return visibleContent;
  return `${graphemes.slice(0, CHAT_TITLE_MAX_LENGTH).join("")}…`;
}

export function createSession(state, options) {
  const messages = options.messages ? [...options.messages] : [];
  const session = {
    id: options.id,
    title: options.title ?? "",
    messages,
    createdAt: options.now,
    updatedAt: options.updatedAt ?? options.now,
    draft: options.draft ?? "",
    pendingRequest: options.pendingRequest ?? null,
    scrollOffset: options.scrollOffset ?? 0,
    scrollWasNearBottom: options.scrollWasNearBottom ?? true,
    scrollMessageCount: options.scrollMessageCount ?? messages.length,
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

function createSessionUpdateDraft(session) {
  return {
    ...session,
    messages: session.messages.map((message) => ({ ...message })),
    pendingRequest: session.pendingRequest ? { ...session.pendingRequest } : null,
  };
}

export function updateSession(state, sessionId, updater) {
  let updated = false;
  const sessions = state.sessions.map((session) => {
    if (session.id !== sessionId) return session;
    updated = true;
    return updater(createSessionUpdateDraft(session));
  });
  return updated ? { ...state, sessions } : state;
}

export function getVisibleSessions(state) {
  return state.sessions
    .filter(
      (session) =>
        session.messages.length > 0 || Boolean(session.draft.trim()),
    )
    .map((session) => {
      const isDraft = session.messages.length === 0;
      return {
        ...session,
        displayTitle: isDraft
          ? createChatTitle(session.draft)
          : session.title || "新对话",
        isDraft,
      };
    })
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export function getActiveSession(state) {
  return state.sessions.find((session) => session.id === state.activeSessionId) ?? null;
}
