import { useEffect, useRef, useState } from "react";
import {
  generateChatReply,
  safeModelErrorMessage,
  usesBrowserDirectModelRoute,
  type ChatTurn,
  type GlobalTextConfig,
} from "../lib/global-model-runtime";
import type { ChatMessage } from "../lib/chat-session-store.mjs";
import { useChatSessions } from "./ChatSessionProvider";
import { useModelRegistry } from "./ModelRegistryProvider";

type ControlDeskProps = {
  onOpenModels: () => void;
  onPreview: (message: string) => void;
};

type PendingRequest = {
  token: symbol;
  controller: AbortController;
  sessionId: string;
  modelId: string;
  modelName: string;
  credentialRevision: string;
  userMessageId: string;
};

type FailedRequest = {
  sessionId: string;
  userMessageId: string;
  message: string;
};

const MAX_CONTEXT_TURNS = 20;
const SAFE_PROXY_ERROR = "模型请求失败，请检查网络或配置后重试。";
let messageSequence = 0;

function createMessageId() {
  messageSequence += 1;
  return `chat-message-${messageSequence}`;
}

function toProviderTurns(messages: ChatMessage[]): ChatTurn[] {
  const turns = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
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
  return [
    ...exchanges.slice(-maxExchanges).flat(),
    currentUser,
  ];
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

export function ControlDesk({ onOpenModels, onPreview }: ControlDeskProps) {
  const {
    sessions,
    activeSession,
    visibleSessions,
    createEmptySession,
    ensureSession,
    selectSession,
    updateSession,
  } = useChatSessions();
  const {
    connectedModels,
    chatSelectedModel,
    chatSelectedModelId,
    setChatSelectedModelId,
    getCredential,
    getCredentialRevision,
  } = useModelRegistry();
  const [isModelPickerOpen, setModelPickerOpen] = useState(false);
  const [input, setInput] = useState("");
  const [pendingRequest, setPendingRequest] = useState<PendingRequest | null>(null);
  const [failedRequest, setFailedRequest] = useState<FailedRequest | null>(null);
  const activeRequestRef = useRef<PendingRequest | null>(null);
  const mountedRef = useRef(true);
  const messages = activeSession?.messages ?? [];

  function cancelActiveRequest(updateState: boolean) {
    const activeRequest = activeRequestRef.current;
    if (!activeRequest) return;
    activeRequestRef.current = null;
    activeRequest.controller.abort();
    if (updateState && mountedRef.current) {
      setPendingRequest(null);
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelActiveRequest(false);
    };
  }, []);

  useEffect(() => {
    const activeRequest = activeRequestRef.current;
    if (!activeRequest) return;
    const activeModel = connectedModels.find(
      (model) => model.id === activeRequest.modelId,
    );
    if (
      !activeModel
      || getCredentialRevision(activeRequest.modelId)
        !== activeRequest.credentialRevision
    ) {
      cancelActiveRequest(true);
    }
  }, [connectedModels, getCredentialRevision]);

  async function requestReply(
    sessionId: string,
    userMessageId: string,
    conversation: ChatMessage[],
  ) {
    if (activeRequestRef.current) return;
    const selectedModel = connectedModels.find(
      (model) => model.id === chatSelectedModelId,
    );
    if (!selectedModel) return;

    const credential = getCredential(selectedModel.id);
    if (!credential) {
      setFailedRequest({
        sessionId,
        userMessageId,
        message: "当前模型没有可用凭据，请重新配置后再试。",
      });
      return;
    }

    const controller = new AbortController();
    const request: PendingRequest = {
      token: Symbol("home-chat-request"),
      controller,
      sessionId,
      modelId: selectedModel.id,
      modelName: selectedModel.displayName,
      credentialRevision: getCredentialRevision(selectedModel.id),
      userMessageId,
    };
    activeRequestRef.current = request;
    setPendingRequest(request);

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
      if (
        !mountedRef.current
        || activeRequestRef.current?.token !== request.token
      ) {
        return;
      }
      const now = Date.now();
      updateSession(request.sessionId, (session) => ({
        ...session,
        messages: [
          ...session.messages,
          {
            id: createMessageId(),
            role: "assistant",
            content: reply,
            modelName: request.modelName,
            createdAt: now,
          },
        ],
        updatedAt: now,
      }));
      setFailedRequest((currentFailure) =>
        currentFailure?.userMessageId === request.userMessageId
          ? null
          : currentFailure,
      );
    } catch (error) {
      if (
        controller.signal.aborted
        || !mountedRef.current
        || activeRequestRef.current?.token !== request.token
      ) {
        return;
      }
      setFailedRequest({
        sessionId: request.sessionId,
        userMessageId: request.userMessageId,
        message: usesBrowserDirectModelRoute(selectedModel.baseUrl)
          ? safeModelErrorMessage(error, credential)
          : SAFE_PROXY_ERROR,
      });
    } finally {
      if (
        mountedRef.current
        && activeRequestRef.current?.token === request.token
      ) {
        activeRequestRef.current = null;
        setPendingRequest(null);
      }
    }
  }

  function sendMessage() {
    const content = input.trim();
    if (!content || !chatSelectedModel || pendingRequest || failedRequest) return;
    const sessionId = ensureSession(content);
    const now = Date.now();
    const userMessage: ChatMessage = {
      id: createMessageId(),
      role: "user",
      content,
      createdAt: now,
    };
    const nextMessages = [...messages, userMessage];
    updateSession(sessionId, (session) => ({
      ...session,
      messages: nextMessages,
      draft: "",
      updatedAt: now,
    }));
    setInput("");
    void requestReply(sessionId, userMessage.id, nextMessages);
  }

  function retryFailedMessage() {
    if (
      !failedRequest
      || failedRequest.sessionId !== activeSession?.id
      || !chatSelectedModel
      || pendingRequest
    ) {
      return;
    }
    const failedIndex = messages.findIndex(
      (message) => message.id === failedRequest.userMessageId,
    );
    if (failedIndex < 0) return;
    void requestReply(
      failedRequest.sessionId,
      failedRequest.userMessageId,
      messages.slice(0, failedIndex + 1),
    );
  }

  function startNewSession() {
    cancelActiveRequest(true);
    setFailedRequest(null);
    setInput("");
    createEmptySession();
  }

  function openSession(id: string) {
    cancelActiveRequest(true);
    setFailedRequest(null);
    setInput("");
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
            <input
              aria-current={
                session.id === activeSession?.id ? "page" : undefined
              }
              aria-label={`打开会话：${session.title}`}
              key={session.id}
              onClick={() => openSession(session.id)}
              type="button"
              value={`会话 · ${session.title}`}
            />
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
          onChange={(event) => setInput(event.target.value)}
          placeholder="例如：帮我复盘上周经营数据，先找出最影响利润的三个问题…"
          value={input}
        />
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
              </article>
            ))}
            {pendingRequest ? (
              <div
                aria-label="聊天回复状态"
                className="chat-pending"
                role="status"
              >
                {pendingRequest.modelName} 正在回复…
              </div>
            ) : null}
          </section>
        ) : null}
        {failedRequest ? (
          <div className="chat-error" role="alert">
            <span>{failedRequest.message}</span>
            <button
              disabled={!chatSelectedModel || Boolean(pendingRequest)}
              onClick={retryFailedMessage}
              type="button"
            >
              重新发送
            </button>
          </div>
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
                || Boolean(pendingRequest)
                || Boolean(failedRequest)
              }
              onClick={sendMessage}
              type="button"
            >
              发送
            </button>
            {pendingRequest ? (
              <button
                className="chat-stop-button"
                onClick={() => cancelActiveRequest(true)}
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
        <button onClick={() => setInput("规划本月内容")} type="button">
          规划本月内容
        </button>
        <button onClick={() => setInput("分析竞品账号")} type="button">
          分析竞品账号
        </button>
        <button onClick={() => setInput("复盘上周数据")} type="button">
          复盘上周数据
        </button>
      </div>
    </section>
  );
}
