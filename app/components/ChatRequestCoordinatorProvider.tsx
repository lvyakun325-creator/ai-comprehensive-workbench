"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  generateChatReply,
  safeModelErrorMessage,
  usesBrowserDirectModelRoute,
  type ChatTurn,
  type GlobalTextConfig,
} from "../lib/global-model-runtime";
import type { ChatMessage } from "../lib/chat-session-store.mjs";
import type { ChatModel } from "../lib/model-registry.mjs";
import { useChatSessions } from "./ChatSessionProvider";
import { useModelRegistry } from "./ModelRegistryProvider";

export type ChatRequestContextValue = {
  activeRequestSessionId: string | null;
  sendMessage(sessionId: string, content: string): Promise<void>;
  retryMessage(sessionId: string, userMessageId: string): Promise<void>;
  stopRequest(sessionId: string): void;
};

type ActiveRequest = {
  token: symbol;
  controller: AbortController;
  sessionId: string;
  userMessageId: string;
  modelId: string;
  modelName: string;
  credentialRevision: string;
};

const MAX_CONTEXT_TURNS = 20;
const SAFE_PROXY_ERROR = "模型请求失败，请检查网络或配置后重试。";
const MISSING_CREDENTIAL_ERROR = "当前模型没有可用凭据，请重新配置后再试。";
const ChatRequestContext = createContext<ChatRequestContextValue | null>(null);
let messageSequence = 0;

function createMessageId() {
  messageSequence += 1;
  return `chat-message-${messageSequence}`;
}

function toProviderTurns(messages: ChatMessage[]): ChatTurn[] {
  const turns = messages
    .filter(
      (message) =>
        (message.role === "assistant")
        || (
          message.role === "user"
          && message.status !== "failed"
          && message.status !== "stopped"
        ),
    )
    .map(({ role, content }) => ({ role, content }));
  const currentUser = turns.at(-1);
  if (!currentUser || currentUser.role !== "user") return [];

  const exchanges: ChatTurn[][] = [];
  let unmatchedUser: ChatTurn | null = null;
  for (const turn of turns.slice(0, -1)) {
    if (turn.role === "user") {
      unmatchedUser = turn;
    } else if (unmatchedUser) {
      exchanges.push([unmatchedUser, turn]);
      unmatchedUser = null;
    }
  }

  const maxExchanges = Math.floor((MAX_CONTEXT_TURNS - 1) / 2);
  return [...exchanges.slice(-maxExchanges).flat(), currentUser];
}

async function requestProxyReply(
  config: GlobalTextConfig,
  turns: ChatTurn[],
  signal: AbortSignal,
) {
  const response = await fetch("/api/models/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config, turns }),
    signal,
  });
  if (!response.ok) throw new Error(SAFE_PROXY_ERROR);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(SAFE_PROXY_ERROR);
  }
  if (
    !body
    || typeof body !== "object"
    || (body as { ok?: unknown }).ok !== true
    || typeof (body as { reply?: unknown }).reply !== "string"
    || !(body as { reply: string }).reply.trim()
  ) {
    throw new Error(SAFE_PROXY_ERROR);
  }
  return (body as { reply: string }).reply;
}

export function ChatRequestCoordinatorProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { sessions, updateSession } = useChatSessions();
  const {
    connectedModels,
    chatSelectedModelId,
    getCredential,
    getCredentialRevision,
  } = useModelRegistry();
  const [activeRequestSessionId, setActiveRequestSessionId] = useState<
    string | null
  >(null);
  const activeRequestRef = useRef<ActiveRequest | null>(null);
  const sessionsRef = useRef(sessions);
  const provisionalSessionIdsRef = useRef(new Set<string>());
  const registryRef = useRef({
    connectedModels,
    chatSelectedModelId,
    getCredential,
    getCredentialRevision,
  });

  sessionsRef.current = sessions;
  for (const session of sessions) {
    provisionalSessionIdsRef.current.delete(session.id);
  }
  registryRef.current = {
    connectedModels,
    chatSelectedModelId,
    getCredential,
    getCredentialRevision,
  };

  const updateUserMessage = useCallback(
    (
      sessionId: string,
      userMessageId: string,
      status: ChatMessage["status"],
      errorMessage?: string,
    ) => {
      const now = Date.now();
      updateSession(sessionId, (session) => ({
        ...session,
        messages: session.messages.map((message) =>
          message.id === userMessageId
            ? {
                ...message,
                status,
                errorMessage,
              }
            : message,
        ),
        pendingRequest: null,
        updatedAt: now,
      }));
    },
    [updateSession],
  );

  const clearActiveRequest = useCallback(
    (request: ActiveRequest, markStopped: boolean) => {
      if (activeRequestRef.current?.token !== request.token) return;
      activeRequestRef.current = null;
      request.controller.abort();
      setActiveRequestSessionId(null);
      if (
        markStopped
        && (
          sessionsRef.current.some(
            (session) => session.id === request.sessionId,
          )
          || provisionalSessionIdsRef.current.has(request.sessionId)
        )
      ) {
        updateUserMessage(
          request.sessionId,
          request.userMessageId,
          "stopped",
        );
      }
    },
    [updateUserMessage],
  );

  const requestIsCurrent = useCallback((request: ActiveRequest) => {
    const registry = registryRef.current;
    const activeModel = registry.connectedModels.find(
      (model) => model.id === request.modelId,
    );
    return (
      (
        sessionsRef.current.some(
          (session) => session.id === request.sessionId,
        )
        || provisionalSessionIdsRef.current.has(request.sessionId)
      )
      && activeRequestRef.current?.token === request.token
      && Boolean(activeModel)
      && registry.getCredentialRevision(request.modelId)
        === request.credentialRevision
    );
  }, []);

  const runRequest = useCallback(
    async (
      sessionId: string,
      userMessageId: string,
      conversation: ChatMessage[],
      selectedModel: ChatModel,
      credential: string,
    ) => {
      if (activeRequestRef.current) return;

      const controller = new AbortController();
      const request: ActiveRequest = {
        token: Symbol("home-chat-request"),
        controller,
        sessionId,
        userMessageId,
        modelId: selectedModel.id,
        modelName: selectedModel.displayName,
        credentialRevision:
          registryRef.current.getCredentialRevision(selectedModel.id),
      };
      activeRequestRef.current = request;
      setActiveRequestSessionId(sessionId);
      updateSession(sessionId, (session) => ({
        ...session,
        pendingRequest: {
          modelId: request.modelId,
          modelName: request.modelName,
          userMessageId: request.userMessageId,
          credentialRevision: request.credentialRevision,
        },
      }));

      const config = {
        baseUrl: selectedModel.baseUrl,
        apiKey: credential,
        model: selectedModel.modelId,
      };
      const turns = toProviderTurns(conversation);

      try {
        const reply = usesBrowserDirectModelRoute(selectedModel.baseUrl)
          ? await generateChatReply(config, turns, {
              egressMode: "browser-direct",
              fetchImpl: globalThis.fetch,
              signal: controller.signal,
            })
          : await requestProxyReply(config, turns, controller.signal);
        if (!requestIsCurrent(request)) return;

        const now = Date.now();
        updateSession(request.sessionId, (session) => {
          const userIndex = session.messages.findIndex(
            (message) => message.id === request.userMessageId,
          );
          if (userIndex < 0) return session;
          const nextMessages = session.messages.map((message) =>
            message.id === request.userMessageId
              ? {
                  ...message,
                  status: "sent" as const,
                  errorMessage: undefined,
                }
              : message,
          );
          nextMessages.splice(userIndex + 1, 0, {
            id: createMessageId(),
            role: "assistant",
            content: reply,
            modelName: request.modelName,
            createdAt: now,
          });
          return {
            ...session,
            messages: nextMessages,
            pendingRequest: null,
            updatedAt: now,
          };
        });
      } catch (error) {
        if (controller.signal.aborted || !requestIsCurrent(request)) return;
        updateUserMessage(
          request.sessionId,
          request.userMessageId,
          "failed",
          usesBrowserDirectModelRoute(selectedModel.baseUrl)
            ? safeModelErrorMessage(error, credential)
            : SAFE_PROXY_ERROR,
        );
      } finally {
        provisionalSessionIdsRef.current.delete(request.sessionId);
        if (activeRequestRef.current?.token === request.token) {
          activeRequestRef.current = null;
          setActiveRequestSessionId(null);
        }
      }
    },
    [requestIsCurrent, updateSession, updateUserMessage],
  );

  const sendMessage = useCallback(
    async (sessionId: string, rawContent: string) => {
      const content = rawContent.trim();
      if (!content || activeRequestRef.current) return;

      const registry = registryRef.current;
      const selectedModel = registry.connectedModels.find(
        (model) => model.id === registry.chatSelectedModelId,
      );
      if (!selectedModel) return;

      const now = Date.now();
      const userMessage: ChatMessage = {
        id: createMessageId(),
        role: "user",
        content,
        status: "sending",
        createdAt: now,
      };
      const session = sessionsRef.current.find(
        (candidate) => candidate.id === sessionId,
      );
      const conversation = [...(session?.messages ?? []), userMessage];
      if (!session) provisionalSessionIdsRef.current.add(sessionId);
      updateSession(sessionId, (current) => ({
        ...current,
        messages: [...current.messages, userMessage],
        draft: "",
        updatedAt: now,
      }));

      const credential = registry.getCredential(selectedModel.id);
      if (!credential) {
        updateUserMessage(
          sessionId,
          userMessage.id,
          "failed",
          MISSING_CREDENTIAL_ERROR,
        );
        return;
      }

      await runRequest(
        sessionId,
        userMessage.id,
        conversation,
        selectedModel,
        credential,
      );
    },
    [runRequest, updateSession, updateUserMessage],
  );

  const retryMessage = useCallback(
    async (sessionId: string, userMessageId: string) => {
      if (activeRequestRef.current) return;

      const session = sessionsRef.current.find(
        (candidate) => candidate.id === sessionId,
      );
      const userIndex = session?.messages.findIndex(
        (message) =>
          message.id === userMessageId
          && message.role === "user"
          && message.status === "failed",
      ) ?? -1;
      if (!session || userIndex < 0) return;

      const registry = registryRef.current;
      const selectedModel = registry.connectedModels.find(
        (model) => model.id === registry.chatSelectedModelId,
      );
      if (!selectedModel) return;

      const conversation = session.messages
        .slice(0, userIndex + 1)
        .map((message) =>
          message.id === userMessageId
            ? {
                ...message,
                status: "sending" as const,
                errorMessage: undefined,
              }
            : message,
        );
      updateSession(sessionId, (current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.id === userMessageId
            ? {
                ...message,
                status: "sending",
                errorMessage: undefined,
              }
            : message,
        ),
      }));

      const credential = registry.getCredential(selectedModel.id);
      if (!credential) {
        updateUserMessage(
          sessionId,
          userMessageId,
          "failed",
          MISSING_CREDENTIAL_ERROR,
        );
        return;
      }

      await runRequest(
        sessionId,
        userMessageId,
        conversation,
        selectedModel,
        credential,
      );
    },
    [runRequest, updateSession, updateUserMessage],
  );

  const stopRequest = useCallback(
    (sessionId: string) => {
      const request = activeRequestRef.current;
      if (!request || request.sessionId !== sessionId) return;
      clearActiveRequest(request, true);
    },
    [clearActiveRequest],
  );

  useEffect(() => {
    const request = activeRequestRef.current;
    if (!request) return;
    if (
      !sessions.some((session) => session.id === request.sessionId)
      && !provisionalSessionIdsRef.current.has(request.sessionId)
    ) {
      clearActiveRequest(request, false);
    }
  }, [clearActiveRequest, sessions]);

  useEffect(() => {
    const request = activeRequestRef.current;
    if (!request) return;
    const activeModel = connectedModels.find(
      (model) => model.id === request.modelId,
    );
    if (
      !activeModel
      || getCredentialRevision(request.modelId)
        !== request.credentialRevision
    ) {
      clearActiveRequest(request, true);
    }
  }, [clearActiveRequest, connectedModels, getCredentialRevision]);

  useEffect(
    () => () => {
      activeRequestRef.current?.controller.abort();
      activeRequestRef.current = null;
    },
    [],
  );

  const value = useMemo<ChatRequestContextValue>(
    () => ({
      activeRequestSessionId,
      sendMessage,
      retryMessage,
      stopRequest,
    }),
    [activeRequestSessionId, retryMessage, sendMessage, stopRequest],
  );

  return (
    <ChatRequestContext.Provider value={value}>
      {children}
    </ChatRequestContext.Provider>
  );
}

export function useChatRequestCoordinator() {
  const context = useContext(ChatRequestContext);
  if (!context) {
    throw new Error(
      "useChatRequestCoordinator must be used within ChatRequestCoordinatorProvider",
    );
  }
  return context;
}
