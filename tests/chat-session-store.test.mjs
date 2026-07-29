import assert from "node:assert/strict";
import test from "node:test";
import {
  createChatTitle,
  createInitialChatSessionState,
  createSession,
  deleteSession,
  getActiveSession,
  getVisibleSessions,
  selectSession,
  updateSession,
} from "../app/lib/chat-session-store.mjs";

function createSessionRecord({
  id,
  title,
  messages = [],
  createdAt,
  updatedAt = createdAt,
  draft = "",
  pendingRequest = null,
  scrollOffset = 0,
}) {
  return {
    id,
    title,
    messages,
    createdAt,
    updatedAt,
    draft,
    pendingRequest,
    scrollOffset,
  };
}

test("初始状态为空", () => {
  assert.deepEqual(createInitialChatSessionState(), {
    sessions: [],
    activeSessionId: null,
  });
});

test("标题取首条用户消息前 24 个可见字符并追加省略号", () => {
  assert.equal(
    createChatTitle("  这是一个超过二十四个字符的首次提问用于生成会话标题  "),
    "这是一个超过二十四个字符的首次提问用于生成会话标…",
  );
});

test("标题按完整 emoji 字形截断而不切断代理对", () => {
  const emoji = "🙂";

  assert.equal(
    createChatTitle(`${emoji.repeat(24)}下一字`),
    `${emoji.repeat(24)}…`,
  );
});

test("标题按完整组合字形截断且 Segmenter 缺失时仍保留组合序列", () => {
  const originalSegmenter = Intl.Segmenter;
  Object.defineProperty(Intl, "Segmenter", {
    configurable: true,
    value: undefined,
  });

  try {
    const combinedCharacter = "e\u0301";
    assert.equal(
      createChatTitle(`${combinedCharacter.repeat(24)}下一字`),
      `${combinedCharacter.repeat(24)}…`,
    );
  } finally {
    Object.defineProperty(Intl, "Segmenter", {
      configurable: true,
      value: originalSegmenter,
    });
  }
});

test("空白首条消息不能生成标题", () => {
  assert.equal(createChatTitle(" \n\t "), "");
});

test("空会话不进入历史", () => {
  const state = createSession(createInitialChatSessionState(), {
    id: "session-empty",
    now: 100,
  });

  assert.equal(state.activeSessionId, "session-empty");
  assert.equal(getActiveSession(state)?.id, "session-empty");
  assert.deepEqual(getVisibleSessions(state), []);
});

test("新会话初始化可持久化的近底部与消息计数滚动元数据", () => {
  const state = createSession(createInitialChatSessionState(), {
    id: "session-scroll-metadata",
    now: 100,
  });
  const session = getActiveSession(state);

  assert.deepEqual(
    {
      scrollOffset: session?.scrollOffset,
      scrollWasNearBottom: session?.scrollWasNearBottom,
      scrollMessageCount: session?.scrollMessageCount,
    },
    {
      scrollOffset: 0,
      scrollWasNearBottom: true,
      scrollMessageCount: 0,
    },
  );
});

test("非空草稿进入历史并带有明确草稿标记，纯空白草稿仍隐藏", () => {
  const state = {
    sessions: [
      createSessionRecord({
        id: "session-conversation",
        title: "已发送会话",
        messages: [
          {
            id: "conversation-user",
            role: "user",
            content: "已发送内容",
            createdAt: 100,
          },
        ],
        createdAt: 100,
        updatedAt: 100,
      }),
      createSessionRecord({
        id: "session-draft",
        title: "",
        draft: "  尚未发送但必须可恢复的草稿  ",
        createdAt: 200,
        updatedAt: 200,
      }),
      createSessionRecord({
        id: "session-whitespace",
        title: "",
        draft: " \n\t ",
        createdAt: 300,
        updatedAt: 300,
      }),
    ],
    activeSessionId: "session-draft",
  };

  assert.deepEqual(
    getVisibleSessions(state).map(
      ({ id, displayTitle, isDraft }) => ({ id, displayTitle, isDraft }),
    ),
    [
      {
        id: "session-draft",
        displayTitle: "尚未发送但必须可恢复的草稿",
        isDraft: true,
      },
      {
        id: "session-conversation",
        displayTitle: "已发送会话",
        isDraft: false,
      },
    ],
  );
});

test("非空会话按 updatedAt 倒序显示", () => {
  const state = {
    sessions: [
      createSessionRecord({
        id: "session-old",
        title: "旧会话",
        messages: [{ id: "old-user", role: "user", content: "旧", createdAt: 100 }],
        createdAt: 100,
        updatedAt: 200,
      }),
      createSessionRecord({
        id: "session-empty",
        title: "空会话",
        createdAt: 300,
      }),
      createSessionRecord({
        id: "session-new",
        title: "新会话",
        messages: [{ id: "new-user", role: "user", content: "新", createdAt: 400 }],
        createdAt: 400,
        updatedAt: 500,
      }),
    ],
    activeSessionId: "session-new",
  };

  assert.deepEqual(
    getVisibleSessions(state).map((session) => session.id),
    ["session-new", "session-old"],
  );
});

test("草稿与消息只更新目标会话", () => {
  const assistantMessage = {
    id: "assistant-1",
    role: "assistant",
    content: "助手回复",
    modelName: "可信模型",
    status: "sent",
    createdAt: 120,
  };
  const state = {
    sessions: [
      createSessionRecord({
        id: "session-target",
        title: "目标",
        messages: [{ id: "user-1", role: "user", content: "问题", status: "sent", createdAt: 100 }],
        createdAt: 100,
      }),
      createSessionRecord({
        id: "session-other",
        title: "其他",
        messages: [assistantMessage],
        createdAt: 110,
      }),
    ],
    activeSessionId: "session-target",
  };

  const next = updateSession(state, "session-target", (session) => ({
    ...session,
    draft: "待发送内容",
    messages: [...session.messages, assistantMessage],
    updatedAt: 200,
  }));

  assert.equal(next.sessions[0].draft, "待发送内容");
  assert.deepEqual(next.sessions[0].messages.at(-1), assistantMessage);
  assert.deepEqual(next.sessions[1], state.sessions[1]);
  assert.deepEqual(state.sessions[0].messages, [
    { id: "user-1", role: "user", content: "问题", status: "sent", createdAt: 100 },
  ]);
});

test("变更 updater 不会改写更新前会话", () => {
  const originalMessage = {
    id: "user-1",
    role: "user",
    content: "原始问题",
    status: "sent",
    createdAt: 100,
  };
  const state = {
    sessions: [
      createSessionRecord({
        id: "session-target",
        title: "目标",
        messages: [originalMessage],
        createdAt: 100,
        pendingRequest: {
          modelId: "model-1",
          modelName: "模型一",
          userMessageId: "user-1",
          credentialRevision: "revision-1",
        },
      }),
    ],
    activeSessionId: "session-target",
  };

  const next = updateSession(state, "session-target", (session) => {
    session.draft = "新草稿";
    session.messages[0].content = "变更后的问题";
    session.messages.push({
      id: "assistant-1",
      role: "assistant",
      content: "新回复",
      createdAt: 101,
    });
    session.pendingRequest.modelName = "模型二";
    return session;
  });

  assert.deepEqual(state.sessions[0], createSessionRecord({
    id: "session-target",
    title: "目标",
    messages: [originalMessage],
    createdAt: 100,
    pendingRequest: {
      modelId: "model-1",
      modelName: "模型一",
      userMessageId: "user-1",
      credentialRevision: "revision-1",
    },
  }));
  assert.equal(next.sessions[0].draft, "新草稿");
  assert.equal(next.sessions[0].messages[0].content, "变更后的问题");
  assert.equal(next.sessions[0].messages.length, 2);
  assert.equal(next.sessions[0].pendingRequest.modelName, "模型二");
});

test("用户、助手的全部终态、errorMessage 与 modelName 原样保留", () => {
  const messages = [
    {
      id: "user-1",
      role: "user",
      content: "正在发送的问题",
      status: "sending",
      createdAt: 100,
    },
    {
      id: "assistant-1",
      role: "assistant",
      content: "已完成的回复",
      modelName: "模型 A",
      status: "sent",
      createdAt: 101,
    },
    {
      id: "user-failed",
      role: "user",
      content: "失败的问题",
      status: "failed",
      errorMessage: "安全失败提示",
      createdAt: 102,
    },
    {
      id: "user-stopped",
      role: "user",
      content: "停止的问题",
      status: "stopped",
      createdAt: 103,
    },
  ];
  const state = createSession(createInitialChatSessionState(), {
    id: "session-messages",
    now: 100,
    title: "消息会话",
    messages,
  });

  assert.deepEqual(getActiveSession(state)?.messages, messages);
});

test("选择有效会话会更新当前选择", () => {
  const state = {
    sessions: [
      createSessionRecord({
        id: "session-first",
        title: "第一条",
        createdAt: 100,
      }),
      createSessionRecord({
        id: "session-second",
        title: "第二条",
        createdAt: 200,
      }),
    ],
    activeSessionId: "session-first",
  };

  const next = selectSession(state, "session-second");

  assert.notEqual(next, state);
  assert.equal(next.activeSessionId, "session-second");
  assert.deepEqual(next.sessions, state.sessions);
});

test("选择不存在的会话保持原状态对象与当前选择", () => {
  const state = createSession(createInitialChatSessionState(), {
    id: "session-existing",
    now: 100,
  });

  const next = selectSession(state, "session-missing");

  assert.equal(next, state);
  assert.equal(next.activeSessionId, "session-existing");
});

test("删除当前会话后选择最近更新的剩余会话", () => {
  const stateWithTwoSessions = {
    sessions: [
      createSessionRecord({
        id: "session-old",
        title: "旧会话",
        messages: [{ id: "old-user", role: "user", content: "旧", createdAt: 100 }],
        createdAt: 100,
        updatedAt: 200,
      }),
      createSessionRecord({
        id: "session-new",
        title: "新会话",
        messages: [{ id: "new-user", role: "user", content: "新", createdAt: 300 }],
        createdAt: 300,
        updatedAt: 400,
      }),
      createSessionRecord({
        id: "session-older",
        title: "更旧会话",
        messages: [{ id: "older-user", role: "user", content: "更旧", createdAt: 50 }],
        createdAt: 50,
        updatedAt: 60,
      }),
    ],
    activeSessionId: "session-new",
  };

  const next = deleteSession(stateWithTwoSessions, "session-new");

  assert.equal(next.activeSessionId, "session-old");
});

test("删除非当前会话不改变当前选择", () => {
  const state = {
    sessions: [
      createSessionRecord({ id: "session-current", title: "当前", createdAt: 100 }),
      createSessionRecord({ id: "session-other", title: "其他", createdAt: 200 }),
    ],
    activeSessionId: "session-current",
  };

  const next = deleteSession(state, "session-other");

  assert.equal(next.activeSessionId, "session-current");
  assert.deepEqual(next.sessions.map((session) => session.id), ["session-current"]);
});

test("删除最后一个会话返回空态", () => {
  const state = createSession(createInitialChatSessionState(), {
    id: "session-only",
    now: 100,
  });

  assert.deepEqual(deleteSession(state, "session-only"), {
    sessions: [],
    activeSessionId: null,
  });
});
