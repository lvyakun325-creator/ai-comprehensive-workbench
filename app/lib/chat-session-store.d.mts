export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  modelName?: string;
  status?: "sending" | "sent" | "failed" | "stopped";
  errorMessage?: string;
  createdAt: number;
};

export type ChatPendingRequestState = {
  modelId: string;
  modelName: string;
  userMessageId: string;
  credentialRevision: string;
};

export type ChatSession = {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  draft: string;
  pendingRequest: ChatPendingRequestState | null;
  scrollOffset: number;
  scrollWasNearBottom: boolean;
  scrollMessageCount: number;
};

export type ChatSessionHistoryItem = ChatSession & {
  displayTitle: string;
  isDraft: boolean;
};

export type ChatSessionState = {
  sessions: ChatSession[];
  activeSessionId: string | null;
};

export type CreateChatSessionOptions = {
  id: string;
  now: number;
  title?: string;
  messages?: ChatMessage[];
  updatedAt?: number;
  draft?: string;
  pendingRequest?: ChatPendingRequestState | null;
  scrollOffset?: number;
  scrollWasNearBottom?: boolean;
  scrollMessageCount?: number;
};

export const CHAT_TITLE_MAX_LENGTH: 24;
export function createInitialChatSessionState(): ChatSessionState;
export function createChatTitle(content: string): string;
export function createSession(
  state: ChatSessionState,
  options: CreateChatSessionOptions,
): ChatSessionState;
export function selectSession(
  state: ChatSessionState,
  sessionId: string,
): ChatSessionState;
export function deleteSession(
  state: ChatSessionState,
  sessionId: string,
): ChatSessionState;
export function updateSession(
  state: ChatSessionState,
  sessionId: string,
  updater: (session: ChatSession) => ChatSession,
): ChatSessionState;
export function getVisibleSessions(
  state: ChatSessionState,
): ChatSessionHistoryItem[];
export function getActiveSession(state: ChatSessionState): ChatSession | null;
