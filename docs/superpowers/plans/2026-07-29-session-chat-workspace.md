# 本次会话多对话工作区实施计划

> **For agent:** 实施时按任务顺序执行；每个任务必须先写失败测试，再写最小实现，最后只暂存本任务文件并提交。

**Goal:** 把首页单卡片聊天升级为本次页面运行期内可连续多轮、新建、自动标题、切换和删除的独立聊天工作区。

**Architecture:** 使用工作台顶层 `ChatSessionProvider` 保存纯内存会话；使用同样挂在顶层的 `ChatRequestCoordinatorProvider` 管理唯一活动请求，确保切换工作台页面时会话和请求生命周期不依赖 `ControlDesk` 是否挂载。`ControlDesk` 只组合空态、历史侧栏、消息区和输入器。会话上下文继续使用最近 20 个 turn，并严格按会话隔离。

**Tech Stack:** React 19、TypeScript、Vinext/Next、Node test runner、Testing Library、JSDOM、CSS。

---

## 全局约束

- 不修改本轮范围外的模型配置、Agent 项目、任务中心、成果库和数据概览逻辑。
- 不把消息、标题、草稿或错误写入 `localStorage`、`sessionStorage`、IndexedDB、日志或服务端。
- 保留当前模型注册表的持久化方式；聊天历史本身仅存在 React 内存。
- 不展示 API Key、上游响应体或内部错误细节。
- 不覆盖当前工作区已有的未提交修改：
  - `app/lib/global-model-runtime.ts`
  - `app/lib/model-registry.mjs`
  - `tests/global-model-runtime.test.mjs`
  - `tests/model-registry.test.mjs`
- 每次提交都使用精确文件列表，禁止 `git add .`。
- 所有请求只读取原会话的消息；迟到响应必须通过会话存在、请求 token 和凭据修订号校验。

## 文件结构

### 新增

- `app/lib/chat-session-store.mjs`
  - 纯函数：初始状态、标题生成、新建、选择、删除、消息和草稿更新、排序。
- `app/lib/chat-session-store.d.mts`
  - `ChatMessage`、`ChatSession`、`ChatSessionState` 与纯函数声明。
- `app/components/ChatSessionProvider.tsx`
  - 顶层纯内存状态和稳定的会话操作 API。
- `app/components/ChatRequestCoordinatorProvider.tsx`
  - 全局唯一请求、停止、重试、安全错误和迟到响应校验。
- `app/components/ChatHistorySidebar.tsx`
  - 新建、历史分组、切换、删除确认和移动端抽屉。
- `app/components/ChatTranscript.tsx`
  - 消息、状态、失败重试和智能自动滚动。
- `app/components/ChatComposer.tsx`
  - 草稿、Enter 发送、Shift+Enter 换行、模型选择、停止和全局生成提示。
- `tests/chat-session-store.test.mjs`
  - 会话纯函数单元测试。

### 修改

- `app/page.tsx`
  - 在不会随主视图卸载的位置挂载两个聊天 Provider。
- `app/components/ControlDesk.tsx`
  - 移除本地消息/请求状态，组合空态和独立聊天页面。
- `app/globals.css`
  - 两栏聊天工作区、气泡、固定输入器、删除确认和移动端抽屉样式。
- `tests/workbench-ui.test.tsx`
  - 更新连续对话、会话隔离、导航保留、标题、切换、删除、键盘、停止、失败和迟到响应测试。
- `tests/rendered-html.test.mjs`
  - 验证首屏仍为无历史的安全空态。

---

## Task 1：建立纯会话状态模型

**Files:**

- Create: `tests/chat-session-store.test.mjs`
- Create: `app/lib/chat-session-store.mjs`
- Create: `app/lib/chat-session-store.d.mts`

### Step 1：先写失败测试

测试固定 ID 和时间，覆盖：

```js
test("标题取首条用户消息前 24 个可见字符并追加省略号", () => {
  assert.equal(
    createChatTitle("  这是一个超过二十四个字符的首次提问用于生成会话标题  "),
    "这是一个超过二十四个字符的首次提问用于生成会话标…",
  );
});

test("删除当前会话后选择最近更新的剩余会话", () => {
  const next = deleteSession(stateWithTwoSessions, "session-new");
  assert.equal(next.activeSessionId, "session-old");
});
```

还要覆盖：

- 初始状态为空；
- 空白首条消息不能生成标题；
- 空会话不进入历史；
- 非空会话按 `updatedAt` 倒序；
- 草稿与消息只更新目标会话；
- 删除非当前会话不改变当前选择；
- 删除最后一个会话返回空态；
- 用户、助手消息状态与 `modelName` 原样保留。

### Step 2：运行单测确认失败

Run:

```bash
npx tsx --test tests/chat-session-store.test.mjs
```

Expected: `ERR_MODULE_NOT_FOUND` 或缺少导出导致失败。

### Step 3：实现最小纯函数

导出以下稳定接口：

```js
export const CHAT_TITLE_MAX_LENGTH = 24;
export function createInitialChatSessionState() {}
export function createChatTitle(content) {}
export function createSession(state, options) {}
export function selectSession(state, sessionId) {}
export function deleteSession(state, sessionId) {}
export function updateSession(state, sessionId, updater) {}
export function getVisibleSessions(state) {}
export function getActiveSession(state) {}
```

关键数据形状：

```ts
export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  modelName?: string;
  status?: "sending" | "sent" | "failed" | "stopped";
  errorMessage?: string;
  createdAt: number;
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
};
```

`createSession` 接收外部传入的 `id` 和 `now`，确保测试确定性；Provider 才负责生成运行期 ID。

### Step 4：运行单测确认通过

Run:

```bash
npx tsx --test tests/chat-session-store.test.mjs
```

Expected: 全部通过。

### Step 5：提交

```bash
git add app/lib/chat-session-store.mjs app/lib/chat-session-store.d.mts tests/chat-session-store.test.mjs
git commit -m "feat: add in-memory chat session store"
```

---

## Task 2：把会话状态提升到工作台顶层

**Files:**

- Create: `app/components/ChatSessionProvider.tsx`
- Modify: `app/page.tsx`
- Modify: `tests/workbench-ui.test.tsx`

### Step 1：先写 Provider 和导航保留测试

在 `tests/workbench-ui.test.tsx` 增加：

1. 首次发送后出现独立聊天区域和历史标题；
2. 打开“模型配置”再返回“AI 对话”，消息和当前会话仍存在；
3. 新建空会话后未发送就切走，空会话不出现在历史；
4. 重新 `cleanup()` 并重新 `render(<Home />)` 后历史为空。

使用可访问名称断言：

```ts
assert.ok(await screen.findByRole("heading", { name: "第一条测试问题" }));
await user.click(screen.getByRole("button", { name: "模型配置" }));
await user.click(screen.getByRole("button", { name: "AI 对话" }));
assert.ok(screen.getByText("第一条测试问题"));
```

### Step 2：运行目标测试确认失败

Run:

```bash
npx tsx --test --test-name-pattern="聊天会话|导航后保留" tests/workbench-ui.test.tsx
```

Expected: 找不到独立聊天区域、历史标题或返回后的消息。

### Step 3：实现 Provider

Context 必须暴露：

```ts
type ChatSessionContextValue = {
  sessions: ChatSession[];
  activeSessionId: string | null;
  activeSession: ChatSession | null;
  visibleSessions: ChatSession[];
  createEmptySession(): string;
  ensureSession(firstMessage: string): string;
  selectSession(id: string): void;
  deleteSession(id: string): void;
  updateSession(id: string, updater: (session: ChatSession) => ChatSession): void;
};
```

Provider 使用 `useState(createInitialChatSessionState)`，禁止任何浏览器存储调用。ID 形如 `chat-session-${Date.now()}-${sequence}`。

### Step 4：挂载到稳定顶层

`app/page.tsx` 结构改为：

```tsx
<ModelRegistryProvider>
  <ChatSessionProvider>
    <WorkbenchHome />
  </ChatSessionProvider>
</ModelRegistryProvider>
```

`ControlDesk` 首次发送通过 `ensureSession()` 写入会话，而不是写入组件本地 `messages`。

### Step 5：运行目标测试和类型检查

Run:

```bash
npx tsx --test --test-name-pattern="聊天会话|导航后保留" tests/workbench-ui.test.tsx
npm run typecheck
```

Expected: 目标测试和类型检查通过。

### Step 6：提交

```bash
git add app/components/ChatSessionProvider.tsx app/page.tsx app/components/ControlDesk.tsx tests/workbench-ui.test.tsx
git commit -m "feat: persist chat sessions across workbench views"
```

---

## Task 3：实现多会话请求协调和连续对话

**Files:**

- Create: `app/components/ChatRequestCoordinatorProvider.tsx`
- Modify: `app/page.tsx`
- Modify: `app/components/ControlDesk.tsx`
- Modify: `tests/workbench-ui.test.tsx`

### Step 1：先写失败行为测试

增加以下测试：

- 同一会话连续 3 轮，第二、三次请求包含本会话之前的完整问答；
- 第二个会话的第一次请求不包含第一个会话内容；
- 全局已有活动请求时，其他会话可编辑草稿但不能发送，并显示活动会话提示；
- 停止后用户消息状态为“已停止”，可立即发新问题；
- 失败后可重试且不重复插入用户消息；
- 失败后直接发送新问题不会被旧失败锁死；
- 切换工作台页面不会丢会话；响应回来后更新原会话；
- 删除请求中的会话会 abort，迟到响应不会进入其他会话；
- 凭据修订变化时活动请求停止，DOM 中不出现密钥。

请求上下文断言：

```ts
assert.deepEqual(requestBodies[2].turns, [
  { role: "user", content: "第一问" },
  { role: "assistant", content: "第一答" },
  { role: "user", content: "第二问" },
  { role: "assistant", content: "第二答" },
  { role: "user", content: "第三问" },
]);
```

### Step 2：运行目标测试确认失败

Run:

```bash
npx tsx --test --test-name-pattern="连续对话|会话隔离|停止|失败|迟到响应" tests/workbench-ui.test.tsx
```

Expected: 当前本地单会话、卸载 abort 和失败锁定行为导致失败。

### Step 3：实现请求协调接口

Provider 挂在 `ChatSessionProvider` 内、`WorkbenchHome` 外：

```tsx
<ChatSessionProvider>
  <ChatRequestCoordinatorProvider>
    <WorkbenchHome />
  </ChatRequestCoordinatorProvider>
</ChatSessionProvider>
```

Context 暴露：

```ts
type ChatRequestContextValue = {
  activeRequestSessionId: string | null;
  sendMessage(sessionId: string, content: string): Promise<void>;
  retryMessage(sessionId: string, userMessageId: string): Promise<void>;
  stopRequest(sessionId: string): void;
};
```

请求元数据保留：

```ts
type ActiveRequest = {
  token: symbol;
  controller: AbortController;
  sessionId: string;
  userMessageId: string;
  modelId: string;
  modelName: string;
  credentialRevision: string;
};
```

协调器沿用现有：

- `generateChatReply`
- `safeModelErrorMessage`
- `usesBrowserDirectModelRoute`
- `/api/models/chat`
- 最多 20 turn 的完整问答截取规则

成功写入前依次校验：

```ts
sessionExists
&& activeRequestRef.current?.token === request.token
&& getCredentialRevision(request.modelId) === request.credentialRevision
```

失败写到对应用户消息的 `status: "failed"` 和安全 `errorMessage`；停止写 `status: "stopped"`。重试复用原用户消息，不新增副本。

### Step 4：删除与请求联动

删除 API 增加删除前回调或协调器监听会话集合；目标会话不存在时立即 abort 并清除全局活动请求。不能把响应落入当前展示的其他会话。

### Step 5：运行行为测试

Run:

```bash
npx tsx --test --test-name-pattern="连续对话|会话隔离|停止|失败|迟到响应" tests/workbench-ui.test.tsx
npm run typecheck
```

Expected: 全部通过。

### Step 6：提交

```bash
git add app/components/ChatRequestCoordinatorProvider.tsx app/components/ChatSessionProvider.tsx app/components/ControlDesk.tsx app/page.tsx tests/workbench-ui.test.tsx
git commit -m "feat: coordinate safe multi-session chat requests"
```

---

## Task 4：实现方案 A 的独立聊天界面

**Files:**

- Create: `app/components/ChatHistorySidebar.tsx`
- Create: `app/components/ChatTranscript.tsx`
- Create: `app/components/ChatComposer.tsx`
- Modify: `app/components/ControlDesk.tsx`
- Modify: `app/globals.css`
- Modify: `tests/workbench-ui.test.tsx`

### Step 1：先写失败交互测试

覆盖：

- 第一条消息后展示历史侧栏、标题栏、消息区、底部输入器；
- 自动标题超过 24 字截断；
- “发起新对话”、切换会话；
- 删除需确认，取消不删，确认后按规则选择剩余会话；
- 删除最后一条会话返回空态；
- Enter 发送，Shift+Enter 只换行；
- 发送后草稿清空并重新聚焦；
- 用户消息右侧、助手消息左侧并保留实际模型名；
- 接近底部自动跟随，用户向上阅读时不强制滚动；
- 移动宽度下历史通过抽屉按钮开关。

### Step 2：运行目标测试确认失败

Run:

```bash
npx tsx --test --test-name-pattern="历史侧栏|删除会话|键盘发送|自动滚动|移动端历史" tests/workbench-ui.test.tsx
```

Expected: 找不到新组件和交互。

### Step 3：实现历史侧栏

`ChatHistorySidebar` props：

```ts
type ChatHistorySidebarProps = {
  sessions: ChatSession[];
  activeSessionId: string | null;
  open: boolean;
  onClose(): void;
  onCreate(): void;
  onSelect(id: string): void;
  onDelete(id: string): void;
};
```

以本地日期把会话分为“今天”和“更早”。删除按钮使用 `aria-label="删除会话：标题"`，点击后显示轻量确认层，确认按钮为 `确认删除`，取消按钮为 `取消`。

### Step 4：实现消息区

`ChatTranscript` 仅渲染消息和调用 `onRetry`。滚动规则：

- 记录用户滚动前是否距离底部不超过 96px；
- 新增消息或当前会话生成状态变化时，仅在接近底部时滚到底；
- 切换会话时恢复 `scrollOffset`；
- 卸载或切换前写回当前 `scrollTop`。

失败和停止状态显示在对应用户消息附近。助手消息展示其 `modelName`。

### Step 5：实现固定输入器

`ChatComposer`：

- textarea 受控于当前会话 `draft`；
- `onKeyDown` 中 `Enter && !shiftKey && !isComposing` 时 `preventDefault()` 并发送；
- `Shift+Enter` 不拦截；
- `scrollHeight` 驱动高度，CSS `max-height` 限制；
- 发送后 `requestAnimationFrame(() => textarea.focus())`；
- 当前会话请求中显示“停止生成”；
- 其他会话请求中禁用发送并显示“另一会话正在生成”；
- 附件、工具、语音保持不可用提示，不接入真实能力。

### Step 6：组合独立工作区并补齐响应式 CSS

`ControlDesk`：

- 没有非空活动会话时显示现有欢迎空态；
- 首次发送后切换为 `.chat-workspace`；
- 桌面端左侧固定宽度历史，右侧 `minmax(0, 1fr)`；
- 消息区 `overflow-y: auto`；
- 输入器置于右侧底部，使用 `position: sticky` 或三行 grid，不使用页面级 fixed；
- `@media (max-width: 760px)` 时历史改为遮罩抽屉；
- 使用 `env(safe-area-inset-bottom)` 保护移动端底部。

### Step 7：运行目标测试、lint 和类型检查

Run:

```bash
npx tsx --test --test-name-pattern="历史侧栏|删除会话|键盘发送|自动滚动|移动端历史" tests/workbench-ui.test.tsx
npm run lint
npm run typecheck
```

Expected: 全部通过。

### Step 8：提交

```bash
git add app/components/ChatHistorySidebar.tsx app/components/ChatTranscript.tsx app/components/ChatComposer.tsx app/components/ControlDesk.tsx app/globals.css tests/workbench-ui.test.tsx
git commit -m "feat: build dedicated chat workspace"
```

---

## Task 5：首屏安全回归与完整验证

**Files:**

- Modify: `tests/rendered-html.test.mjs`
- Modify only if a verified regression requires it: files already listed in Tasks 1–4

### Step 1：先补首屏失败测试

验证服务端首屏：

- 包含聊天欢迎空态；
- 不包含历史会话；
- 不包含 API Key；
- 不包含上游错误正文；
- 不包含 `localStorage` 聊天记录键。

### Step 2：运行完整测试

Run:

```bash
npm test
```

Expected: build 成功，全部 Node/Testing Library 测试通过。

### Step 3：运行静态检查

Run:

```bash
npm run lint
npm run typecheck
```

Expected: lint 和类型检查均为退出码 0。

### Step 4：浏览器验收

Run:

```bash
npm run dev
```

在实际页面手动验证：

1. 发送第一条问题进入独立聊天页；
2. 连续完成 3 轮；
3. 新建第二会话并确认上下文隔离；
4. 切换模型配置再返回；
5. 切换、删除、删除最后一条；
6. Enter、Shift+Enter、停止、失败重试；
7. 桌面与 760px 以下移动布局；
8. 刷新后历史清空。

浏览器控制台不得出现未处理 Promise rejection。Network/DOM/Storage 中不得出现聊天历史持久化键或明文密钥。

### Step 5：提交回归测试

```bash
git add tests/rendered-html.test.mjs
git commit -m "test: verify session chat workspace"
```

### Step 6：最终状态核对

Run:

```bash
git status --short
git log --oneline -6
```

Expected:

- 本功能文件无未提交改动；
- 前一轮模型配置的 4 个未提交文件仍保持原状；
- 不出现本轮范围外的新修改。
