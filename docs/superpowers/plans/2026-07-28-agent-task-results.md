# Agent Task History and Markdown Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify each Agent project to five tabs, show current and historical task progress, and expose completed Markdown documents as read-only results.

**Architecture:** A pure project-record module supplies normalized task/result data and filtering. Two focused UI components render task history and read-only Markdown results, while `AgentWorkspace` remains responsible only for tab routing and existing content-matrix execution. Result preview state is local to the results component and never edits source Markdown.

**Tech Stack:** React 19, TypeScript, JavaScript ESM, Testing Library, Node test runner, Blob downloads, Clipboard API, vinext.

## Global Constraints

- Project navigation must contain only `项目总览`, `Agent 对话`, `任务列表`, `成果文件`, and `Agent 配置`.
- `项目资料`, `执行过程`, and `成果交接` must have no tab, placeholder page, or call-to-action.
- Task statuses are `waiting`, `running`, `completed`, `failed`, and `stopped`.
- Only completed tasks may own `.md` result documents.
- Result documents are read-only and support preview, copy, and `.md` download.
- Existing content-matrix diagnosis, connection, generation, cancellation, redaction, and medical-compliance behavior must remain unchanged.

---

### Task 1: Pure task and result record model

**Files:**
- Create: `app/lib/agent-project-records.mjs`
- Create: `app/lib/agent-project-records.d.ts`
- Create: `tests/agent-project-records.test.mjs`

**Interfaces:**
- Produces: `TASK_STATUSES`, `PROJECT_TASKS`, `PROJECT_RESULTS`, `getAgentTasks(agentId, status)`, `getAgentResults(agentId)`, and `getTaskResults(taskId)`.
- Task shape: `{ id, agentId, title, status, progress, currentStep, model, createdAt, updatedAt, completedAt, stoppedAt, errorSummary }`.
- Result shape: `{ id, agentId, taskId, filename, completedAt, sizeBytes, markdown }`.

- [ ] **Step 1: Write failing data-rule tests**

```js
test("sorts current and historical tasks newest first", () => {
  const tasks = getAgentTasks("content-matrix", "all");
  assert.deepEqual(tasks.map((task) => task.id), ["matrix-running", "matrix-completed"]);
});

test("filters task status without mutating records", () => {
  assert.ok(getAgentTasks("content-matrix", "running").every((task) => task.status === "running"));
});

test("exposes markdown only for completed tasks", () => {
  const results = getAgentResults("content-matrix");
  assert.ok(results.every((result) => result.filename.endsWith(".md")));
  assert.ok(results.every((result) =>
    getAgentTasks("content-matrix", "completed").some((task) => task.id === result.taskId),
  ));
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npx tsx --test tests/agent-project-records.test.mjs`  
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement immutable preview records and helpers**

Include at least one running and one completed content-matrix task, plus completed history for another Agent. Use ISO date strings, clamp progress to `0..100`, and freeze exported fixture arrays. Include one Markdown result whose content begins with `# 内容矩阵方案`.

- [ ] **Step 4: Run focused tests**

Run: `npx tsx --test tests/agent-project-records.test.mjs`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/agent-project-records.mjs app/lib/agent-project-records.d.ts tests/agent-project-records.test.mjs
git commit -m "feat: add agent task and result records"
```

### Task 2: Task history component

**Files:**
- Create: `app/components/AgentTaskList.tsx`
- Modify: `app/globals.css`
- Test: `tests/workbench-ui.test.tsx`

**Interfaces:**
- Consumes: `agentId`, `filter`, `onFilterChange(filter)`, `getAgentTasks(agentId, filter)`, and `onOpenResult(taskId)`.
- Produces: status filter buttons, newest-first task cards, progress bars, current-step text, timestamps, error summaries, and completed-result links.

- [ ] **Step 1: Add failing task-history UI tests**

Render `<AgentTaskList agentId="content-matrix" filter="all" onFilterChange={setFilter} onOpenResult={handler} />` directly and assert:

```tsx
assert.ok(screen.getByRole("heading", { name: "任务列表" }));
assert.ok(screen.getByText("进行中"));
assert.ok(screen.getByText(/当前步骤：/));
assert.ok(screen.getByRole("progressbar"));
assert.ok(screen.getByRole("button", { name: "查看成果" }));
```

Click the `已完成` filter and assert that running cards are hidden while completed cards remain.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npx tsx --test --test-name-pattern="task history" tests/workbench-ui.test.tsx`  
Expected: FAIL because `AgentTaskList` does not exist.

- [ ] **Step 3: Implement `AgentTaskList`**

Map status labels exactly: `waiting → 等待中`, `running → 进行中`, `completed → 已完成`, `failed → 失败`, `stopped → 已停止`. Give running progress elements `role="progressbar"` with `aria-valuenow`, `aria-valuemin="0"`, and `aria-valuemax="100"`. Show `查看成果` only when `getTaskResults(task.id).length > 0`.

- [ ] **Step 4: Add responsive styles**

Add `.agent-task-view`, `.task-filter-bar`, `.agent-task-card`, `.task-progress`, and status modifier styles. Stack metadata and actions under `720px`.

- [ ] **Step 5: Run the focused test**

Run: `npx tsx --test --test-name-pattern="task history" tests/workbench-ui.test.tsx`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/components/AgentTaskList.tsx app/globals.css tests/workbench-ui.test.tsx
git commit -m "feat: render agent task history"
```

### Task 3: Read-only Markdown results

**Files:**
- Create: `app/components/AgentResultFiles.tsx`
- Modify: `app/globals.css`
- Test: `tests/workbench-ui.test.tsx`

**Interfaces:**
- Consumes: `agentId`, optional `initialTaskId`, and `getAgentResults(agentId)`.
- Produces: result list, read-only preview dialog, `复制内容`, `下载 MD`, and `关闭预览`.

- [ ] **Step 1: Add failing result-file UI tests**

Render `<AgentResultFiles agentId="content-matrix" initialTaskId={null} onPreview={handler} />` directly. Test that only `.md` files are listed, clicking the file opens a dialog containing the Markdown, no textbox/editor exists, and copy/download actions are available. Stub clipboard and URL methods:

```ts
Object.assign(navigator, {
  clipboard: { writeText: async (value: string) => value },
});
Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:test" });
Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => undefined });
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npx tsx --test --test-name-pattern="Markdown result" tests/workbench-ui.test.tsx`  
Expected: FAIL because result files are not implemented.

- [ ] **Step 3: Implement result list, preview, copy, and download**

Render Markdown inside `<pre className="markdown-result-content">` with no `contentEditable`, `textarea`, or edit button. Download with:

```ts
const blob = new Blob([result.markdown], { type: "text/markdown;charset=utf-8" });
const url = URL.createObjectURL(blob);
const anchor = document.createElement("a");
anchor.href = url;
anchor.download = result.filename;
anchor.click();
URL.revokeObjectURL(url);
```

Copy through `navigator.clipboard.writeText(result.markdown)` and report success through `onPreview`.

- [ ] **Step 4: Add result and dialog styles**

Add `.agent-results-view`, `.result-file-card`, `.result-preview-backdrop`, `.result-preview-dialog`, and `.markdown-result-content`, including mobile width and reduced-motion behavior.

- [ ] **Step 5: Run focused tests**

Run: `npx tsx --test --test-name-pattern="Markdown result" tests/workbench-ui.test.tsx`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/components/AgentResultFiles.tsx app/globals.css tests/workbench-ui.test.tsx
git commit -m "feat: add read-only markdown results"
```

### Task 4: Wire five-tab Agent project navigation

**Files:**
- Modify: `app/components/AgentWorkspace.tsx`
- Modify: `tests/workbench-ui.test.tsx`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: `AgentTaskList`, `AgentResultFiles`, and `taskId` result navigation.
- Produces: exactly five project tabs and task-to-result navigation preserving task filter state in the mounted task component.

- [ ] **Step 1: Add failing five-tab navigation tests**

Assert the project navigation button names equal:

```ts
["项目总览", "Agent 对话", "任务列表", "成果文件", "Agent 配置"]
```

Assert `项目资料`, `执行过程`, and `成果交接` are absent. From `任务列表`, click `查看成果`, verify `成果文件` becomes current, and verify the matching Markdown preview opens.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npx tsx --test --test-name-pattern="five project tabs|task history|Markdown result" tests/workbench-ui.test.tsx`  
Expected: FAIL on the current eight-tab navigation.

- [ ] **Step 3: Wire the components**

Change `PROJECT_TABS` to five values. Add `resultTaskId` and `taskFilter` state in `AgentWorkspace` so the selected filter survives navigation to a result and back. Render:

```tsx
activeTab === "任务列表"
  ? <AgentTaskList
      agentId={agent.id}
      filter={taskFilter}
      onFilterChange={setTaskFilter}
      onOpenResult={(taskId) => {
        setResultTaskId(taskId);
        setActiveTab("成果文件");
      }}
    />
  : activeTab === "成果文件"
    ? <AgentResultFiles agentId={agent.id} initialTaskId={resultTaskId} onPreview={onPreview} />
    : existingBranches
```

Remove generic preview notifications for the task and result tabs. Change overview copy from cross-Agent handoff to `已完成的 Markdown 文档会保存在成果文件中。` Change the isolation banner to `它只会操作当前项目，不会修改其他 Agent 项目。`

- [ ] **Step 4: Update server-render assertions**

Ensure source/render tests assert the five values and reject the three removed tab labels in `PROJECT_TABS`. Do not reject historical specification files; scope string checks to `AgentWorkspace.tsx` and rendered navigation.

- [ ] **Step 5: Run full validation**

Run: `npm test`  
Expected: all registry, workbench, content-matrix runtime, route, UI, and server-render tests PASS.

Run: `npm run lint`  
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add app/components/AgentWorkspace.tsx tests/workbench-ui.test.tsx tests/rendered-html.test.mjs
git commit -m "feat: simplify agent project navigation"
```
