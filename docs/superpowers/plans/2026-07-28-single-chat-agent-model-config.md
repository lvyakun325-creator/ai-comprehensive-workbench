# Single Chat Agent and Model Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the total-control composer with one chat agent whose model picker is driven only by browser-local model configuration.

**Architecture:** A pure model registry module owns validation, enable/default rules, and selection fallback. A client provider persists that registry under one versioned localStorage key and exposes it to the chat composer and global model settings. Existing content-matrix session credentials remain isolated in `ContentMatrixConfigPanel` and are not copied into localStorage.

**Tech Stack:** React 19, TypeScript, JavaScript ESM, localStorage, Testing Library, Node test runner, vinext.

## Global Constraints

- The chat window must not describe itself as a total-control, dispatch, scheduling, concurrency, or child-Agent surface.
- The chat picker may show only enabled models from the global model registry.
- Browser localStorage may store provider, display name, model ID, enabled state, and default state only.
- API keys, tokens, passwords, and credentials must never be written to localStorage.
- Real chat model invocation remains out of scope; send continues to disclose that the model is not connected.
- Existing content-matrix model connection behavior and its secret-handling tests must remain unchanged.

---

### Task 1: Pure model registry rules

**Files:**
- Create: `app/lib/model-registry.mjs`
- Create: `app/lib/model-registry.d.ts`
- Create: `tests/model-registry.test.mjs`

**Interfaces:**
- Produces: `DEFAULT_MODELS`, `normalizeModels(models)`, `addModel(models, draft)`, `setModelEnabled(models, id, enabled)`, `setDefaultModel(models, id)`, `removeModel(models, id)`, `getEnabledModels(models)`, `resolveSelectedModelId(models, selectedId)`, and `parseStoredModels(raw)`.
- Model shape: `{ id: string; provider: string; displayName: string; modelId: string; enabled: boolean; isDefault: boolean }`.

- [ ] **Step 1: Write failing registry tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MODELS,
  addModel,
  getEnabledModels,
  parseStoredModels,
  removeModel,
  resolveSelectedModelId,
  setDefaultModel,
  setModelEnabled,
} from "../app/lib/model-registry.mjs";

test("only enabled models reach the chat picker", () => {
  const disabled = setModelEnabled(DEFAULT_MODELS, DEFAULT_MODELS[0].id, false);
  assert.deepEqual(getEnabledModels(disabled), []);
  assert.equal(resolveSelectedModelId(disabled, DEFAULT_MODELS[0].id), null);
});

test("adding and defaulting a model keeps exactly one default", () => {
  const added = addModel(DEFAULT_MODELS, {
    provider: "Anthropic",
    displayName: "Claude Sonnet",
    modelId: "claude-sonnet",
    enabled: true,
    isDefault: false,
  });
  const selected = setDefaultModel(added, added.at(-1).id);
  assert.equal(selected.filter((model) => model.isDefault).length, 1);
  assert.equal(resolveSelectedModelId(selected, null), added.at(-1).id);
});

test("removing the selected model falls back to an enabled default", () => {
  const remaining = removeModel(DEFAULT_MODELS, DEFAULT_MODELS[0].id);
  assert.equal(resolveSelectedModelId(remaining, DEFAULT_MODELS[0].id), null);
});

test("stored data rejects credential-shaped fields", () => {
  const raw = JSON.stringify([{ ...DEFAULT_MODELS[0], apiKey: "secret" }]);
  assert.deepEqual(parseStoredModels(raw), DEFAULT_MODELS);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npx tsx --test tests/model-registry.test.mjs`  
Expected: FAIL because `app/lib/model-registry.mjs` does not exist.

- [ ] **Step 3: Implement the pure registry and declarations**

Implement immutable helpers. Use `crypto.randomUUID()` when available and a timestamp/random suffix fallback. Trim all text fields, reject duplicate `provider + modelId`, force disabled models to `isDefault: false`, and promote the first enabled model when no enabled default exists. `parseStoredModels` must return `DEFAULT_MODELS` when JSON is invalid, the value is not an array, required fields are missing, or any object contains keys matching `/api.?key|token|password|credential/i`.

- [ ] **Step 4: Run the focused test**

Run: `npx tsx --test tests/model-registry.test.mjs`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/model-registry.mjs app/lib/model-registry.d.ts tests/model-registry.test.mjs
git commit -m "feat: add browser-safe model registry"
```

### Task 2: Shared browser-local model provider

**Files:**
- Create: `app/components/ModelRegistryProvider.tsx`
- Modify: `app/page.tsx`
- Create: `tests/model-registry-provider.test.tsx`

**Interfaces:**
- Consumes: all Task 1 registry helpers.
- Produces: `useModelRegistry()` returning `{ models, enabledModels, selectedModelId, selectedModel, setSelectedModelId, addModel, setModelEnabled, setDefaultModel, removeModel }`.
- Storage key: `ai-workbench:model-registry:v1`.

- [ ] **Step 1: Add a failing provider persistence and fallback test**

Create a small `RegistryHarness` inside the test. It calls `useModelRegistry()`, renders the selected model and buttons that call `addModel`, `setSelectedModelId`, and `setModelEnabled`. Clear localStorage, render the harness inside `ModelRegistryProvider`, add a model, unmount, render again, and verify the added model remains. Also disable the selected model and verify selection falls back to the enabled default.

- [ ] **Step 2: Run the focused UI test and verify failure**

Run: `npx tsx --test tests/model-registry-provider.test.tsx`  
Expected: FAIL because the provider and interactive registry do not exist.

- [ ] **Step 3: Implement the provider**

Use lazy `useState` with `DEFAULT_MODELS` for server rendering. In `useEffect`, read and parse the storage key, then mark hydration complete. Persist only after hydration. Resolve selection after every mutation through `resolveSelectedModelId`; never persist any field outside the declared model shape.

Wrap the existing page content:

```tsx
export default function Home() {
  return (
    <ModelRegistryProvider>
      <WorkbenchHome />
    </ModelRegistryProvider>
  );
}
```

Move the current `Home` body into the private `WorkbenchHome` component so all existing child views can consume the registry.

- [ ] **Step 4: Run the focused UI test**

Run: `npx tsx --test tests/model-registry-provider.test.tsx`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/components/ModelRegistryProvider.tsx app/page.tsx tests/model-registry-provider.test.tsx
git commit -m "feat: share local model configuration"
```

### Task 3: Interactive global model configuration

**Files:**
- Modify: `app/components/ModelConfigPanel.tsx`
- Modify: `app/globals.css`
- Test: `tests/workbench-ui.test.tsx`
- Test: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: `useModelRegistry()`.
- Produces: add-model form fields `服务商`, `模型显示名称`, and `模型 ID`; per-model controls `启用/停用`, `设为默认`, and `删除`.

- [ ] **Step 1: Add failing model configuration tests**

Test this exact flow:

```tsx
await user.click(screen.getByRole("button", { name: "模型配置" }));
await user.type(screen.getByLabelText("服务商"), "Anthropic");
await user.type(screen.getByLabelText("模型显示名称"), "Claude Sonnet");
await user.type(screen.getByLabelText("模型 ID"), "claude-sonnet");
await user.click(screen.getByRole("checkbox", { name: "添加后启用" }));
await user.click(screen.getByRole("button", { name: "添加模型" }));
assert.ok(screen.getByText("Claude Sonnet"));
```

Verify duplicate provider/model ID submission shows a readable error, disabled models remain in configuration but not in chat, and delete asks for no credential input.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npx tsx --test --test-name-pattern="model configuration|model registry" tests/workbench-ui.test.tsx`  
Expected: FAIL because the panel is still a provider preview.

- [ ] **Step 3: Implement global configuration**

For `scope="global"`, render the add form and configured-model list. Keep `scope="agent"` as a lightweight selector over enabled global models for non-content-matrix Agents. Do not add API-key fields. Use inline validation messages with `role="alert"`.

- [ ] **Step 4: Add responsive styles**

Add `.model-config-form`, `.configured-model-list`, `.configured-model-row`, `.model-state-actions`, and mobile stacking under the existing `@media (max-width: 720px)` block.

- [ ] **Step 5: Run focused tests**

Run: `npx tsx --test --test-name-pattern="model configuration|model registry" tests/workbench-ui.test.tsx`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/components/ModelConfigPanel.tsx app/globals.css tests/workbench-ui.test.tsx tests/rendered-html.test.mjs
git commit -m "feat: manage configured chat models"
```

### Task 4: Replace total-control composer with one chat agent

**Files:**
- Modify: `app/components/ControlDesk.tsx`
- Modify: `app/components/WorkbenchShell.tsx`
- Modify: `app/page.tsx`
- Modify: `app/globals.css`
- Test: `tests/rendered-html.test.mjs`
- Test: `tests/workbench-ui.test.tsx`

**Interfaces:**
- Consumes: `useModelRegistry()` and an `onOpenModels()` callback.
- Produces: chat title `聊天智能体`, enabled-only model picker, empty-state configuration action, and ordinary `发送` button.

- [ ] **Step 1: Replace total-control assertions with failing single-chat assertions**

Assert the rendered HTML contains `聊天智能体`, `选择模型后，直接描述你想完成的事情`, and `发送`. Assert it does not contain `总控 Agent`, `拆解并分配`, `最大并发`, `子 Agent`, `任务调度预览`, or `成果交接预览`.

Add a UI test that opens the model picker, selects an enabled configured model, disables all models, verifies `请先添加模型`, and verifies the send button is disabled.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm run build && npx tsx --test tests/rendered-html.test.mjs --test-name-pattern="server-renders|single chat"`  
Expected: FAIL on old total-control copy.

- [ ] **Step 3: Implement the single chat composer**

Remove `PREVIEW_TASK_SCHEDULE`, capacity text, dispatch button, and control-summary cards from `ControlDesk`. Rename the eyebrow to `CHAT AGENT`, the heading to `今天想聊什么，或推进什么任务？`, and the primary button to `发送`. Sending without a model is disabled; sending with a model calls `onPreview("当前为界面预览，真实聊天模型尚未接入")`.

Change the primary navigation label from `总控台` to `AI 对话`, the brand aria-label to `返回 AI 对话`, and the subtitle from `多 Agent 经营协作中心` to `经营与内容 AI 工作台`.

- [ ] **Step 4: Run focused and full tests**

Run: `npm test`  
Expected: all tests PASS, including content-matrix secret redaction and timeout tests.

- [ ] **Step 5: Run lint**

Run: `npm run lint`  
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add app/components/ControlDesk.tsx app/components/WorkbenchShell.tsx app/page.tsx app/globals.css tests/rendered-html.test.mjs tests/workbench-ui.test.tsx
git commit -m "feat: replace total control with chat agent"
```
