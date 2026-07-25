# Multi-Agent UI Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有首页升级为一个可点击的“总控台 + 九个独立 Agent 项目”UI 原型，同时保留 AI 对话和模型配置入口，不连接真实模型或运行真实 Agent。

**Architecture:** 使用一个客户端页面状态容器控制当前主导航和已选择 Agent，各业务视图拆成独立组件。Agent 定义、任务状态、项目访问规则和成果交接规则放入可由 Node 直接测试的纯数据模块；UI 只消费这些接口，不让某个 Agent 组件直接读取其他 Agent 的私有项目。

**Tech Stack:** Next.js 16、React 19、TypeScript、CSS、Vinext、Node Test Runner。

## Global Constraints

- 保留现有首页 AI 沟通入口，角色名称调整为“总控 Agent”。
- 建立一个总控台和九个一对一对应业务功能的独立 Agent 项目。
- 本计划只实现 UI 外壳和本地模拟数据，不连接模型、不创建真实 Agent、不运行任务、不发布上线。
- 每个 Agent 只能查看自己的模拟项目、任务和成果。
- 跨 Agent 协作只能通过成果交接预览，不允许直接修改其他 Agent 的模拟数据。
- 公共资产库在 UI 中标记为只读。
- API 密钥不写入页面、代码、日志或模拟数据。
- 医药健康内容显示合规检查和人工确认提示。
- 当前并发容量固定展示为一个总控 Agent 加三个子 Agent，超出任务进入队列。
- 桌面端九个 Agent 使用三列卡片，移动端使用单列。
- 未接入的按钮统一提示“当前为设计预览”，不触发外部操作。

---

## File Structure

### Shared domain files

- `app/lib/agent-catalog.mjs`：九个 Agent 的唯一数据源、类型约定和查找函数。
- `app/lib/workbench-state.mjs`：导航、项目隔离、任务筛选和成果交接的纯函数。
- `app/lib/agent-catalog.d.ts`：为 TypeScript 组件提供 Agent 数据声明。
- `tests/agent-catalog.test.mjs`：验证九个 Agent 的数量、编号、唯一性和标准输出。
- `tests/workbench-state.test.mjs`：验证导航状态、项目隔离、并发排队和成果交接。

### UI component files

- `app/components/WorkbenchShell.tsx`：左侧导航、顶部栏、当前视图容器和提示消息。
- `app/components/ControlDesk.tsx`：总控 Agent 对话、经营目标和九个 Agent 总览。
- `app/components/AgentDirectory.tsx`：九个独立 Agent 项目卡片。
- `app/components/AgentWorkspace.tsx`：单个 Agent 的独立项目页和隔离提示。
- `app/components/TaskCenter.tsx`：运行、排队、确认、完成和失败任务视图。
- `app/components/AssetLibrary.tsx`：私有成果、待交接成果、共享成果和公共模板。
- `app/components/DataOverview.tsx`：内容产能、转化和 Agent 调用量的模拟数据概览。
- `app/components/ModelConfigPanel.tsx`：全局模型与 Agent 默认模型的设计入口。
- `app/components/PreviewToast.tsx`：未接入功能的统一设计预览提示。

### Existing files

- `app/page.tsx`：从现有单文件界面收缩为页面状态容器。
- `app/globals.css`：保留现有视觉基调，新增总控台、Agent 工作区、任务和资产样式。
- `tests/rendered-html.test.mjs`：验证服务端输出包含总控台、九个 Agent 和隔离文案。
- `package.json`：让 `npm test` 执行全部 `tests/*.test.mjs`。

---

### Task 1: Lock the nine-Agent catalog contract

**Files:**
- Create: `app/lib/agent-catalog.mjs`
- Create: `app/lib/agent-catalog.d.ts`
- Create: `tests/agent-catalog.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `AGENT_PROJECTS`, `getAgentById(agentId)`, `AGENT_IDS`
- `AgentProject`: `{ id, index, title, shortTitle, responsibility, input, output, icon, accent, complianceRequired }`

- [ ] **Step 1: Write the failing Agent catalog test**

Create `tests/agent-catalog.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_IDS,
  AGENT_PROJECTS,
  getAgentById,
} from "../app/lib/agent-catalog.mjs";

test("defines exactly nine isolated Agent projects", () => {
  assert.equal(AGENT_PROJECTS.length, 9);
  assert.deepEqual(AGENT_IDS, [
    "content-matrix",
    "competitor-insight",
    "topic-planning",
    "title-planning",
    "media-article",
    "super-writing",
    "viral-speech",
    "lead-video",
    "data-review",
  ]);
  assert.equal(new Set(AGENT_IDS).size, 9);
});

test("every Agent has a stable responsibility and standard output", () => {
  for (const agent of AGENT_PROJECTS) {
    assert.match(agent.index, /^\d{2}$/);
    assert.ok(agent.responsibility.length >= 8);
    assert.ok(agent.output.length >= 4);
    assert.equal(getAgentById(agent.id), agent);
  }
  assert.equal(getAgentById("missing-agent"), null);
});
```

- [ ] **Step 2: Expand the test command and verify failure**

Change `package.json`:

```json
"test": "npm run build && node --test tests/*.test.mjs"
```

Run:

```bash
npm test
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `app/lib/agent-catalog.mjs`.

- [ ] **Step 3: Implement the Agent catalog**

Create `app/lib/agent-catalog.mjs` with this structure and all nine records:

```js
export const AGENT_PROJECTS = Object.freeze([
  {
    id: "content-matrix",
    index: "01",
    title: "内容矩阵 Agent",
    shortTitle: "内容矩阵",
    responsibility: "负责账号定位、栏目结构、平台分工和更新节奏。",
    input: "业务目标、产品、平台与目标人群",
    output: "内容矩阵方案",
    icon: "▦",
    accent: "violet",
    complianceRequired: true,
  },
  {
    id: "competitor-insight",
    index: "02",
    title: "竞品洞察 Agent",
    shortTitle: "竞品洞察",
    responsibility: "负责竞品采集、内容拆解、差异判断和机会识别。",
    input: "竞品链接、截图、数据与分析要求",
    output: "竞品洞察报告",
    icon: "⌕",
    accent: "blue",
    complianceRequired: false,
  },
  {
    id: "topic-planning",
    index: "03",
    title: "选题策划 Agent",
    shortTitle: "选题策划",
    responsibility: "负责人群场景、需求问题、选题池和排期建议。",
    input: "内容矩阵、竞品洞察与产品资料",
    output: "选题清单",
    icon: "✦",
    accent: "orange",
    complianceRequired: true,
  },
  {
    id: "title-planning",
    index: "04",
    title: "标题策划 Agent",
    shortTitle: "标题策划",
    responsibility: "负责标题方向、搜索词、点击表达和风险检查。",
    input: "选题、平台与目标人群",
    output: "标题方案",
    icon: "Aa",
    accent: "pink",
    complianceRequired: true,
  },
  {
    id: "media-article",
    index: "05",
    title: "新媒体图文 Agent",
    shortTitle: "新媒体图文",
    responsibility: "负责正文、内容结构、配图规划和多平台改写。",
    input: "选题、标题与品牌资料",
    output: "图文内容包",
    icon: "◫",
    accent: "cyan",
    complianceRequired: true,
  },
  {
    id: "super-writing",
    index: "06",
    title: "超级 AI 写作 Agent",
    shortTitle: "超级写作",
    responsibility: "负责长文、私域、品牌稿和知识库驱动写作。",
    input: "写作任务、品牌资料与历史稿件",
    output: "完整稿件",
    icon: "✎",
    accent: "indigo",
    complianceRequired: true,
  },
  {
    id: "viral-speech",
    index: "07",
    title: "爆款口播 Agent",
    shortTitle: "爆款口播",
    responsibility: "负责爆款结构拆解、传播钩子和自然口播生成。",
    input: "对标内容、主题与产品资料",
    output: "口播脚本包",
    icon: "▶",
    accent: "red",
    complianceRequired: true,
  },
  {
    id: "lead-video",
    index: "08",
    title: "获客视频 Agent",
    shortTitle: "获客视频",
    responsibility: "负责分镜、配音、画面、字幕和成片生产流程。",
    input: "口播脚本、素材与品牌规范",
    output: "视频生产包",
    icon: "◉",
    accent: "green",
    complianceRequired: true,
  },
  {
    id: "data-review",
    index: "09",
    title: "数据复盘 Agent",
    shortTitle: "数据复盘",
    responsibility: "负责流量、转化、内容产能、复购和行动诊断。",
    input: "平台数据、投放数据与内容结果",
    output: "复盘报告与行动清单",
    icon: "↗",
    accent: "yellow",
    complianceRequired: false,
  },
]);

export const AGENT_IDS = Object.freeze(
  AGENT_PROJECTS.map((agent) => agent.id),
);

export function getAgentById(agentId) {
  return AGENT_PROJECTS.find((agent) => agent.id === agentId) ?? null;
}
```

Create `app/lib/agent-catalog.d.ts`:

```ts
export type AgentProject = {
  id: string;
  index: string;
  title: string;
  shortTitle: string;
  responsibility: string;
  input: string;
  output: string;
  icon: string;
  accent: string;
  complianceRequired: boolean;
};

export const AGENT_PROJECTS: readonly AgentProject[];
export const AGENT_IDS: readonly string[];
export function getAgentById(agentId: string): AgentProject | null;
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test
```

Expected: all Agent catalog and existing rendered HTML tests PASS.

- [ ] **Step 5: Commit the catalog contract**

```bash
git add app/lib/agent-catalog.mjs app/lib/agent-catalog.d.ts tests/agent-catalog.test.mjs package.json
git commit -m "feat: define isolated agent project catalog"
```

---

### Task 2: Implement navigation and isolation state

**Files:**
- Create: `app/lib/workbench-state.mjs`
- Create: `app/lib/workbench-state.d.ts`
- Create: `tests/workbench-state.test.mjs`

**Interfaces:**
- Consumes: `AGENT_IDS`, `getAgentById(agentId)`
- Produces: `createInitialState()`, `navigateTo(state, view)`, `openAgent(state, agentId)`, `canAgentAccessProject(agentId, project)`, `scheduleTasks(tasks, concurrency)`

- [ ] **Step 1: Write failing state and isolation tests**

Create `tests/workbench-state.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  canAgentAccessProject,
  createHandoffPreview,
  createInitialState,
  navigateTo,
  openAgent,
  scheduleTasks,
} from "../app/lib/workbench-state.mjs";

test("opens only known Agent projects", () => {
  const state = createInitialState();
  assert.deepEqual(state, { view: "control", activeAgentId: null });
  assert.equal(navigateTo(state, "tasks").view, "tasks");
  assert.equal(openAgent(state, "competitor-insight").activeAgentId, "competitor-insight");
  assert.throws(() => openAgent(state, "unknown"), /Unknown Agent/);
});

test("prevents an Agent from accessing another Agent private project", () => {
  const ownProject = { id: "p-1", ownerAgentId: "topic-planning", visibility: "private" };
  const publicAsset = { id: "a-1", ownerAgentId: "control", visibility: "public-readonly" };
  assert.equal(canAgentAccessProject("topic-planning", ownProject), true);
  assert.equal(canAgentAccessProject("title-planning", ownProject), false);
  assert.equal(canAgentAccessProject("title-planning", publicAsset), true);
});

test("runs three tasks and queues the rest", () => {
  const tasks = ["t1", "t2", "t3", "t4", "t5"].map((id) => ({ id }));
  const result = scheduleTasks(tasks, 3);
  assert.deepEqual(result.running.map((task) => task.id), ["t1", "t2", "t3"]);
  assert.deepEqual(result.queued.map((task) => task.id), ["t4", "t5"]);
});

test("handoff preview contains no source project write permission", () => {
  assert.deepEqual(
    createHandoffPreview("competitor-insight", "content-matrix", "artifact-12"),
    {
      sourceAgentId: "competitor-insight",
      targetAgentId: "content-matrix",
      artifactId: "artifact-12",
      access: "readonly-copy",
      confirmed: false,
    },
  );
});
```

- [ ] **Step 2: Run state test to verify failure**

Run:

```bash
node --test tests/workbench-state.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `app/lib/workbench-state.mjs`.

- [ ] **Step 3: Implement the pure state functions**

Create `app/lib/workbench-state.mjs`:

```js
import { getAgentById } from "./agent-catalog.mjs";

export const WORKBENCH_VIEWS = Object.freeze([
  "control",
  "agents",
  "tasks",
  "assets",
  "analytics",
  "models",
  "settings",
]);

export function createInitialState() {
  return { view: "control", activeAgentId: null };
}

export function navigateTo(state, view) {
  if (!WORKBENCH_VIEWS.includes(view)) {
    throw new Error(`Unknown view: ${view}`);
  }
  return { ...state, view, activeAgentId: null };
}

export function openAgent(state, agentId) {
  if (!getAgentById(agentId)) {
    throw new Error(`Unknown Agent: ${agentId}`);
  }
  return { ...state, view: "agent", activeAgentId: agentId };
}

export function canAgentAccessProject(agentId, project) {
  return (
    project.ownerAgentId === agentId ||
    project.visibility === "public-readonly"
  );
}

export function scheduleTasks(tasks, concurrency = 3) {
  return {
    running: tasks.slice(0, concurrency),
    queued: tasks.slice(concurrency),
  };
}

export function createHandoffPreview(sourceAgentId, targetAgentId, artifactId) {
  return {
    sourceAgentId,
    targetAgentId,
    artifactId,
    access: "readonly-copy",
    confirmed: false,
  };
}
```

Create `app/lib/workbench-state.d.ts` with matching signatures:

```ts
export type WorkbenchView =
  | "control"
  | "agents"
  | "tasks"
  | "assets"
  | "analytics"
  | "models"
  | "settings";

export type WorkbenchState = {
  view: WorkbenchView | "agent";
  activeAgentId: string | null;
};

export type ProjectAccess = {
  ownerAgentId: string;
  visibility: "private" | "public-readonly";
};

export const WORKBENCH_VIEWS: readonly WorkbenchView[];
export function createInitialState(): WorkbenchState;
export function navigateTo(
  state: WorkbenchState,
  view: WorkbenchView,
): WorkbenchState;
export function openAgent(
  state: WorkbenchState,
  agentId: string,
): WorkbenchState;
export function canAgentAccessProject(
  agentId: string,
  project: ProjectAccess,
): boolean;
export function scheduleTasks<T>(
  tasks: readonly T[],
  concurrency?: number,
): { running: T[]; queued: T[] };
export function createHandoffPreview(
  sourceAgentId: string,
  targetAgentId: string,
  artifactId: string,
): {
  sourceAgentId: string;
  targetAgentId: string;
  artifactId: string;
  access: "readonly-copy";
  confirmed: false;
};
```

- [ ] **Step 4: Run tests and commit**

Run:

```bash
npm test
```

Expected: all tests PASS.

```bash
git add app/lib/workbench-state.mjs app/lib/workbench-state.d.ts tests/workbench-state.test.mjs
git commit -m "feat: add workbench isolation state"
```

---

### Task 3: Extract the app shell and preserve the total-control conversation

**Files:**
- Create: `app/components/PreviewToast.tsx`
- Create: `app/components/WorkbenchShell.tsx`
- Create: `app/components/ControlDesk.tsx`
- Modify: `app/page.tsx`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: `WorkbenchState`, `navigateTo`, `openAgent`
- Produces: `WorkbenchShell`, `ControlDesk`, `PreviewToast`
- `WorkbenchShell` callbacks: `onNavigate(view)`, `onOpenAgent(agentId)`, `onPreview(message)`

- [ ] **Step 1: Update rendered HTML test with the total-control requirements**

Add to the first test in `tests/rendered-html.test.mjs`:

```js
assert.match(html, /总控 Agent/);
assert.match(html, /拆解并分配/);
assert.match(html, /最大并发 3/);
assert.match(html, /总控台/);
assert.match(html, /Agent 项目/);
assert.match(html, /任务中心/);
assert.match(html, /成果资产库/);
```

- [ ] **Step 2: Run the rendered HTML test and verify failure**

Run:

```bash
npm test
```

Expected: FAIL because the current page uses `AI 经营助手` and does not render the new navigation labels.

- [ ] **Step 3: Implement the reusable preview toast**

Create `app/components/PreviewToast.tsx`:

```tsx
type PreviewToastProps = {
  message: string;
};

export function PreviewToast({ message }: PreviewToastProps) {
  if (!message) return null;
  return (
    <div className="toast" role="status" aria-live="polite">
      {message}
    </div>
  );
}
```

- [ ] **Step 4: Build the total-control conversation component**

Move the current greeting, textarea, model trigger and quick prompts into `ControlDesk.tsx`. Change the identity and primary action:

```tsx
type ControlDeskProps = {
  onOpenAgent: (agentId: string) => void;
  onPreview: (message: string) => void;
};

export function ControlDesk({ onOpenAgent, onPreview }: ControlDeskProps) {
  return (
    <section className="control-desk">
      <div className="control-hero">
        <span className="eyebrow">TOTAL CONTROL AGENT</span>
        <h1>今天想推进什么经营目标？</h1>
        <p>总控 Agent 只负责拆解、调度和汇总，不直接生产专业内容。</p>
        <div className="capacity-badge">1 个总控台 · 最大并发 3 个子 Agent</div>
      </div>
      <div className="chat-card">
        <div className="chat-label">
          <span className="ai-dot">✦</span>
          <div>
            <strong>总控 Agent</strong>
            <small>描述目标后预览任务拆解、依赖顺序和项目分配</small>
          </div>
        </div>
        <textarea
          aria-label="经营目标输入框"
          placeholder="例如：为新品制定 30 天内容矩阵，并完成图文、口播和复盘方案…"
        />
        <div className="chat-toolbar">
          <span className="model-trigger">✦ GPT-5.6⌄</span>
          <button
            className="dispatch-button"
            onClick={() => onPreview("当前为设计预览，尚未运行真实 Agent")}
          >
            拆解并分配
          </button>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Build the navigation shell and reduce `page.tsx`**

`WorkbenchShell.tsx` renders these fixed navigation IDs:

```ts
const NAV_ITEMS = [
  ["control", "总控台", "⌂"],
  ["agents", "Agent 项目", "▦"],
  ["tasks", "任务中心", "◷"],
  ["assets", "成果资产库", "◇"],
  ["analytics", "数据概览", "↗"],
  ["models", "模型配置", "⚙"],
] as const;
```

Replace `app/page.tsx` with a state container using:

```tsx
const [state, setState] = useState(createInitialState());
const [toast, setToast] = useState("");

const showPreview = (message: string) => {
  setToast(message);
  window.setTimeout(() => setToast(""), 2200);
};
```

Default `state.view === "control"` renders `ControlDesk`.

Keep a separate bottom “系统设置” button in `WorkbenchShell`. It calls
`onNavigate("settings")`; the settings view renders a design-preview card with
the exact copy `系统设置将在接口与权限阶段启用`, and does not expose account,
permission or credential controls.

- [ ] **Step 6: Run tests and commit**

Run:

```bash
npm test
```

Expected: rendered HTML and domain tests PASS.

```bash
git add app/page.tsx app/components/PreviewToast.tsx app/components/WorkbenchShell.tsx app/components/ControlDesk.tsx tests/rendered-html.test.mjs
git commit -m "feat: add total-control workbench shell"
```

---

### Task 4: Add the nine-Agent directory and isolated project view

**Files:**
- Create: `app/components/AgentDirectory.tsx`
- Create: `app/components/AgentWorkspace.tsx`
- Modify: `app/page.tsx`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: `AGENT_PROJECTS`, `AgentProject`, `openAgent`
- Produces: `AgentDirectory`, `AgentWorkspace`
- `AgentWorkspace` receives exactly one `agent: AgentProject`; it does not receive the full catalog.

- [ ] **Step 1: Add failing Agent UI assertions**

Add to `tests/rendered-html.test.mjs`:

```js
assert.match(html, /9 个独立 Agent 项目/);
assert.match(html, /项目隔离已开启/);
assert.match(html, /只会操作本项目资料/);
assert.match(html, /进入独立项目/);
```

- [ ] **Step 2: Run the test and verify failure**

Run:

```bash
npm test
```

Expected: FAIL because Agent directory and isolation copy are not rendered.

- [ ] **Step 3: Implement `AgentDirectory`**

Render `AGENT_PROJECTS.map(agent => ...)` with:

```tsx
<button
  className={`agent-card ${agent.accent}`}
  key={agent.id}
  onClick={() => onOpenAgent(agent.id)}
>
  <div className="agent-card-head">
    <span className="agent-icon">{agent.icon}</span>
    <span className="isolation-state">项目隔离已开启</span>
    <span>{agent.index}</span>
  </div>
  <h3>{agent.title}</h3>
  <p>{agent.responsibility}</p>
  <dl>
    <div><dt>输入</dt><dd>{agent.input}</dd></div>
    <div><dt>输出</dt><dd>{agent.output}</dd></div>
  </dl>
  <div className="agent-card-footer">
    <span>进入独立项目</span><b>↗</b>
  </div>
</button>
```

- [ ] **Step 4: Implement `AgentWorkspace`**

The component must receive only the selected `agent`:

```tsx
type AgentWorkspaceProps = {
  agent: AgentProject;
  onBack: () => void;
  onPreview: (message: string) => void;
};

const PROJECT_TABS = [
  "项目总览",
  "Agent 对话",
  "任务列表",
  "项目资料",
  "执行过程",
  "成果文件",
  "成果交接",
  "Agent 配置",
];
```

Render a fixed warning:

```tsx
<div className="isolation-banner">
  <span>✓</span>
  <p>
    当前位于「{agent.title}」。它只会操作本项目资料，不会修改其他 Agent 项目。
  </p>
</div>
```

The mock project content must use only `agent.input`, `agent.output` and local constants declared inside `AgentWorkspace.tsx`.

- [ ] **Step 5: Wire the selected Agent into `page.tsx`**

Use:

```tsx
const activeAgent = state.activeAgentId
  ? getAgentById(state.activeAgentId)
  : null;
```

When `state.view === "agent"` and `activeAgent` exists, render:

```tsx
<AgentWorkspace
  agent={activeAgent}
  onBack={() => setState(navigateTo(state, "agents"))}
  onPreview={showPreview}
/>
```

Keep `AgentDirectory` present on the default total-control page below the conversation so server rendering includes all nine projects.

- [ ] **Step 6: Run tests and commit**

Run:

```bash
npm test
```

Expected: all tests PASS.

```bash
git add app/page.tsx app/components/AgentDirectory.tsx app/components/AgentWorkspace.tsx tests/rendered-html.test.mjs
git commit -m "feat: add isolated agent project views"
```

---

### Task 5: Add task center, asset library and handoff preview

**Files:**
- Create: `app/components/TaskCenter.tsx`
- Create: `app/components/AssetLibrary.tsx`
- Create: `app/components/DataOverview.tsx`
- Modify: `app/page.tsx`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: `scheduleTasks`, `createHandoffPreview`, `AGENT_PROJECTS`
- Produces: `TaskCenter`, `AssetLibrary`
- Mock task status values: `"running" | "queued" | "approval" | "completed" | "failed" | "paused"`

- [ ] **Step 1: Add failing task and asset assertions**

Add:

```js
assert.match(html, /运行中 3/);
assert.match(html, /排队中 2/);
assert.match(html, /待人工确认/);
assert.match(html, /公共资产只读/);
assert.match(html, /只读副本/);
assert.match(html, /内容产能/);
assert.match(html, /Agent 调用量/);
```

- [ ] **Step 2: Run the test and verify failure**

Run:

```bash
npm test
```

Expected: FAIL because the task summary and asset handoff preview do not exist.

- [ ] **Step 3: Implement `TaskCenter` with deterministic mock data**

Declare five tasks using unique Agent IDs and call `scheduleTasks(tasks, 3)`.

Render:

```tsx
<section className="task-center">
  <header>
    <div>
      <span className="eyebrow">TASK ORCHESTRATION</span>
      <h2>任务中心</h2>
    </div>
    <div className="task-capacity">运行中 3 · 排队中 2 · 最大并发 3</div>
  </header>
  <div className="task-filters">
    {["全部", "运行中", "排队中", "待人工确认", "已完成", "失败", "已暂停"].map(
      (label) => <button key={label}>{label}</button>,
    )}
  </div>
</section>
```

Task buttons call `onPreview("当前为设计预览，未暂停或终止真实任务")`.

- [ ] **Step 4: Implement `AssetLibrary`**

Render four asset groups:

```ts
const ASSET_GROUPS = [
  ["私有成果", "仅所属 Agent 项目可见"],
  ["待交接成果", "等待确认目标和使用范围"],
  ["已共享成果", "目标 Agent 获得只读副本"],
  ["公共资产只读", "品牌、产品、平台和合规模板"],
] as const;
```

Show one handoff preview:

```tsx
<div className="handoff-card">
  <span>竞品洞察 Agent</span>
  <b>竞品洞察报告 v1</b>
  <span>→ 内容矩阵 Agent</span>
  <em>只读副本 · 等待确认</em>
</div>
```

- [ ] **Step 5: Wire both views and preserve server-visible summaries**

Create `app/components/DataOverview.tsx` with local display-only metrics:

```tsx
const METRICS = [
  ["内容产能", "128", "本周模拟产出"],
  ["平均完成率", "86%", "模拟任务口径"],
  ["Agent 调用量", "342", "不含真实接口调用"],
  ["待复盘项目", "6", "等待数据确认"],
] as const;

export function DataOverview() {
  return (
    <section className="data-overview">
      <span className="eyebrow">OPERATING OVERVIEW</span>
      <h2>数据概览</h2>
      <p>当前全部为界面模拟数据，不读取真实平台经营数据。</p>
      <div className="metric-grid">
        {METRICS.map(([label, value, note]) => (
          <article key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{note}</small>
          </article>
        ))}
      </div>
    </section>
  );
}
```

In `page.tsx`:

```tsx
{state.view === "tasks" && <TaskCenter onPreview={showPreview} />}
{state.view === "assets" && <AssetLibrary onPreview={showPreview} />}
{state.view === "analytics" && <DataOverview />}
```

Also render compact task and asset summary cards inside `ControlDesk`, so the default server output contains the required status text.

- [ ] **Step 6: Run tests and commit**

Run:

```bash
npm test
```

Expected: all tests PASS.

```bash
git add app/page.tsx app/components/TaskCenter.tsx app/components/AssetLibrary.tsx app/components/DataOverview.tsx tests/rendered-html.test.mjs
git commit -m "feat: add task and artifact handoff previews"
```

---

### Task 6: Split model configuration into global and per-Agent scopes

**Files:**
- Create: `app/components/ModelConfigPanel.tsx`
- Modify: `app/page.tsx`
- Modify: `app/components/AgentWorkspace.tsx`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Produces: `ModelConfigPanel`
- Props: `scope: "global" | "agent"`, `agentTitle?: string`, `onPreview(message)`
- No prop may accept an API key, token or credential value.

- [ ] **Step 1: Add failing model-scope assertions**

Add:

```js
assert.match(html, /全局可用模型/);
assert.match(html, /Agent 默认模型/);
assert.match(html, /密钥仅在后续接口阶段通过服务端保存/);
assert.doesNotMatch(html, /api[_-]?key\s*[:=]/i);
```

- [ ] **Step 2: Run the test and verify failure**

Run:

```bash
npm test
```

Expected: FAIL because the two-level configuration copy is absent.

- [ ] **Step 3: Implement the scoped model panel**

Use provider metadata without credential fields:

```ts
const PROVIDERS = [
  ["OpenAI", "GPT 系列"],
  ["Anthropic", "Claude 系列"],
  ["Google AI", "Gemini 系列"],
  ["阿里云百炼", "通义千问系列"],
  ["DeepSeek", "DeepSeek 系列"],
  ["火山方舟", "豆包系列"],
] as const;
```

Header behavior:

```tsx
<h2>{scope === "global" ? "全局可用模型" : `${agentTitle} · Agent 默认模型`}</h2>
<p>密钥仅在后续接口阶段通过服务端保存，当前页面不收集、不显示。</p>
```

Every provider action calls:

```tsx
onPreview("当前为设计预览，未填写或保存任何模型密钥");
```

- [ ] **Step 4: Wire global and Agent-level entry points**

- `state.view === "models"` renders `<ModelConfigPanel scope="global" ... />`.
- The Agent workspace `Agent 配置` tab renders `<ModelConfigPanel scope="agent" agentTitle={agent.title} ... />`.
- Changing one mock selection must be local component state and must not modify other Agent cards.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm test
```

Expected: all tests PASS.

```bash
git add app/page.tsx app/components/AgentWorkspace.tsx app/components/ModelConfigPanel.tsx tests/rendered-html.test.mjs
git commit -m "feat: add scoped model configuration preview"
```

---

### Task 7: Complete responsive visual design and full verification

**Files:**
- Modify: `app/globals.css`
- Modify: `tests/rendered-html.test.mjs`
- Modify: `README.md`

**Interfaces:**
- Consumes all component class names from Tasks 3–6.
- Produces the final local UI shell with desktop, tablet and mobile layouts.

- [ ] **Step 1: Add source-level responsive and safety assertions**

Extend the second rendered HTML test:

```js
assert.match(styles, /\.agent-directory\s*\{/);
assert.match(styles, /grid-template-columns:\s*repeat\(3/);
assert.match(styles, /\.isolation-banner\s*\{/);
assert.match(styles, /\.task-center\s*\{/);
assert.match(styles, /\.asset-library\s*\{/);
assert.match(styles, /\.data-overview\s*\{/);
assert.match(styles, /@media \(max-width: 1020px\)/);
assert.match(styles, /@media \(max-width: 720px\)/);
assert.match(styles, /prefers-reduced-motion/);
```

- [ ] **Step 2: Run tests and verify style assertions fail**

Run:

```bash
npm test
```

Expected: FAIL for the new component class selectors.

- [ ] **Step 3: Add the component styles**

Add focused sections to `app/globals.css`:

```css
.agent-directory {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}

.isolation-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 15px;
  border: 1px solid #cfe8dd;
  border-radius: 14px;
  background: #eef9f4;
  color: #236c50;
}

.task-center,
.asset-library,
.data-overview {
  padding: clamp(22px, 4vw, 52px);
  border: 1px solid var(--line);
  border-radius: 26px;
  background: var(--paper);
}

@media (max-width: 1020px) {
  .agent-directory {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 720px) {
  .agent-directory {
    grid-template-columns: 1fr;
  }
}
```

Continue using the existing accent variables for the nine cards. Do not introduce external icon or image dependencies.

- [ ] **Step 4: Document the preview boundary**

Add to `README.md`:

```md
## 当前阶段

当前版本是“总控台 + 九个独立 Agent 项目”的本地 UI 原型。

- 已实现：项目导航、Agent 隔离界面、任务状态、成果交接和模型配置入口。
- 未实现：真实模型调用、Agent 运行、外部数据抓取、持久化和线上发布。
- 安全边界：页面不收集或保存 API 密钥，所有执行按钮只显示设计预览提示。

本地预览地址默认为 `http://localhost:3000/`。
```

- [ ] **Step 5: Run complete verification**

Run:

```bash
npm test
npm run lint
curl -sS -I http://localhost:3000/ | sed -n '1,8p'
```

Expected:

- All Node tests PASS.
- Build completes successfully.
- Lint reports no errors.
- Local response returns `HTTP/1.1 200 OK`.

- [ ] **Step 6: Check project boundaries**

Run:

```bash
rg -n "API.?key|token|password|手机号|身份证" app tests README.md
```

Expected: no credential values or personal identifiers. Copy explaining that API keys are not stored is allowed.

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only Task 7 files are pending.

- [ ] **Step 7: Commit the completed UI shell**

```bash
git add app/globals.css tests/rendered-html.test.mjs README.md
git commit -m "feat: finish multi-agent workbench UI shell"
```

---

## Plan Completion Criteria

- The default page visibly contains the total-control conversation and all nine independent Agent projects.
- Every Agent opens in the same workspace shell but receives only its own `AgentProject` record.
- The isolation banner is present on every Agent project view.
- Three mock tasks run and excess tasks queue.
- Artifacts are classified as private, pending handoff, shared copy or public read-only.
- Global model configuration and Agent default model configuration are separate.
- No credential fields, real API calls, external writes or Agent execution exist.
- `npm test`, `npm run lint` and the local HTTP check succeed.
