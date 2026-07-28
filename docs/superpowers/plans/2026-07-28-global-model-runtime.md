# Global Model Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the global model registry into a real, browser-persisted text/image model configuration center and connect the home chat agent to tested text models.

**Architecture:** Keep non-sensitive registry metadata and sensitive API keys in separate versioned browser stores. Use one shared OpenAI-compatible runtime for validation, endpoint construction, safe errors, APINebula browser-direct calls, and three bounded proxy routes. Keep global settings and chat request state in focused client components while leaving the ContentMatrix runtime unchanged.

**Tech Stack:** React 19, TypeScript, JavaScript ESM, localStorage, OpenAI-compatible HTTP APIs, vinext API routes, Node test runner, Testing Library, JSDOM.

## Global Constraints

- Continue on branch `codex/multi-agent-ui`; do not merge into `main`.
- API Keys persist only in the current browser and never enter Git, source, downloads, ordinary model metadata, raw errors, or logs.
- Blank API Key input preserves the stored Key; only an explicit clear flag deletes it.
- Only connected and enabled text models are selectable by chat and ordinary Agents.
- APINebula browser-direct routing uses exact HTTPS hostname matching; all other providers use safe proxy routes.
- Image model testing uses `/models` and never generates an image.
- The ContentMatrix Agent configuration and execution runtime remain unchanged.
- Every production behavior starts with a failing test and completes with a focused commit.

---

## File Structure

### Create

- `app/lib/model-credential-store.mjs` — pure credential parsing, masking, retention, replacement, and deletion rules.
- `app/lib/global-model-runtime.ts` — OpenAI-compatible validation, request construction, direct/proxy selection, safe error mapping, response parsing, and bounded chat execution.
- `app/components/GlobalModelSettings.tsx` — text/image configuration drafts, testing, save/cancel, and status UI.
- `app/api/models/test-text/route.ts` — safe text connection probe proxy.
- `app/api/models/test-image/route.ts` — safe model-list probe proxy.
- `app/api/models/chat/route.ts` — safe non-streaming chat proxy.
- `tests/model-credential-store.test.mjs` — secret store unit coverage.
- `tests/global-model-runtime.test.mjs` — runtime, validation, routing, timeout, cancellation, and redaction coverage.
- `tests/global-model-route.test.mjs` — route boundary and secret-leakage coverage.

### Modify

- `app/lib/model-registry.mjs` — connection metadata, migration, fingerprint invalidation, and availability rules.
- `app/components/ModelRegistryProvider.tsx` — separate local credential/image stores and tested-model selectors.
- `app/components/ModelConfigPanel.tsx` — retain Agent selector and delegate global settings to `GlobalModelSettings`.
- `app/components/ControlDesk.tsx` — real conversation, retry, stop, and prompt-fill behavior.
- `app/globals.css` — settings cards, status badges, chat transcript, errors, mobile layout.
- `tests/model-registry.test.mjs` — metadata migration and connected availability.
- `tests/model-registry-provider.test.tsx` — persistence isolation and secret lifecycle.
- `tests/workbench-ui.test.tsx` — global settings and real chat integration.
- `tests/rendered-html.test.mjs` — new component wiring without changing ContentMatrix ownership.

---

### Task 1: Connection metadata and isolated browser credential storage

**Files:**
- Create: `app/lib/model-credential-store.mjs`
- Create: `tests/model-credential-store.test.mjs`
- Modify: `app/lib/model-registry.mjs`
- Modify: `tests/model-registry.test.mjs`
- Modify: `app/components/ModelRegistryProvider.tsx`
- Modify: `tests/model-registry-provider.test.tsx`

**Interfaces:**
- Produces `maskCredential(value: string): string`.
- Produces `parseStoredCredentials(raw: string | null): Record<string, string>`.
- Produces `updateCredential(credentials, id, draftValue, clearRequested): Record<string, string>`.
- Extends `ChatModel` with `baseUrl`, `connectionStatus`, and `testedFingerprint`.
- Produces `getConnectedModels(models): ChatModel[]`.
- Extends `useModelRegistry()` with `getCredential`, `getMaskedCredential`, `saveCredential`, `imageConfig`, `imageCredential`, and draft-save operations.

- [ ] **Step 1: Write failing credential-store tests**

Add tests proving that malformed storage becomes an empty object, control-character Keys are rejected, blank drafts retain old Keys, explicit clear removes them, replacement trims only outer whitespace, and masks never reveal the full Key:

```js
test("retains, replaces, clears, and masks credentials without exposing the full key", () => {
  const initial = { "model-a": "sk-secret-value-1234" };
  assert.deepEqual(updateCredential(initial, "model-a", "", false), initial);
  assert.deepEqual(updateCredential(initial, "model-a", "", true), {});
  assert.equal(
    updateCredential(initial, "model-a", "  sk-new-value-5678  ", false)["model-a"],
    "sk-new-value-5678",
  );
  const masked = maskCredential(initial["model-a"]);
  assert.match(masked, /^sk-/);
  assert.doesNotMatch(masked, /secret-value/);
});
```

- [ ] **Step 2: Run the new credential test and verify RED**

Run:

```bash
npx tsx --test tests/model-credential-store.test.mjs
```

Expected: FAIL because `app/lib/model-credential-store.mjs` does not exist.

- [ ] **Step 3: Implement the pure credential store**

Implement strict object parsing, maximum Key length, control-character rejection, immutable updates, and a mask that preserves at most a short prefix and suffix:

```js
export function updateCredential(credentials, id, draftValue, clearRequested) {
  const next = { ...normalizeCredentialMap(credentials) };
  if (clearRequested) {
    delete next[id];
    return next;
  }
  const draft = validCredential(draftValue);
  if (draft) next[id] = draft;
  return next;
}
```

- [ ] **Step 4: Run the credential test and verify GREEN**

Run:

```bash
npx tsx --test tests/model-credential-store.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Write failing registry migration and availability tests**

Add assertions that old v1 records migrate to `baseUrl: ""`, `connectionStatus: "untested"`, and `testedFingerprint: ""`; changing `baseUrl` or `modelId` marks a previously connected model as `changed`; only `enabled && connectionStatus === "connected"` models are returned by `getConnectedModels`.

- [ ] **Step 6: Run registry tests and verify RED**

Run:

```bash
npx tsx --test tests/model-registry.test.mjs
```

Expected: FAIL because the connection fields and `getConnectedModels` do not exist.

- [ ] **Step 7: Extend registry normalization and availability**

Add:

```js
export function getConnectedModels(models) {
  return normalizeModels(models).filter(
    (model) => model.enabled && model.connectionStatus === "connected",
  );
}

export function connectionFingerprint(baseUrl, modelId, keyRevision) {
  return JSON.stringify([text(baseUrl), text(modelId), text(keyRevision)]);
}
```

Preserve duplicate provider/model rules and ensure old records migrate without becoming callable.

- [ ] **Step 8: Run registry tests and verify GREEN**

Run:

```bash
npx tsx --test tests/model-registry.test.mjs
```

Expected: PASS.

- [ ] **Step 9: Write failing provider persistence tests**

Extend the provider harness to save, retain, replace, and clear a fake Key; assert the ordinary model-registry storage never contains it; assert connected models exclude untested entries; assert image configuration and image credential use separate storage keys.

- [ ] **Step 10: Run provider tests and verify RED**

Run:

```bash
npx tsx --test tests/model-registry-provider.test.tsx
```

Expected: FAIL because the context does not expose credential and image configuration methods.

- [ ] **Step 11: Implement provider storage boundaries**

Use separate versioned keys:

```ts
const MODEL_STORAGE_KEY = "ai-workbench:model-registry:v2";
const CREDENTIAL_STORAGE_KEY = "ai-workbench:model-credentials:v1";
const IMAGE_CONFIG_STORAGE_KEY = "ai-workbench:image-model-config:v1";
const IMAGE_CREDENTIAL_STORAGE_KEY = "ai-workbench:image-model-credential:v1";
```

Hydrate all stores once, persist only after hydration, expose connected models separately from all configured models, and preserve chat/Agent selection isolation.

- [ ] **Step 12: Run focused tests and commit**

Run:

```bash
npx tsx --test tests/model-credential-store.test.mjs tests/model-registry.test.mjs tests/model-registry-provider.test.tsx
```

Expected: PASS.

Commit:

```bash
git add app/lib/model-credential-store.mjs app/lib/model-registry.mjs app/components/ModelRegistryProvider.tsx tests/model-credential-store.test.mjs tests/model-registry.test.mjs tests/model-registry-provider.test.tsx
git commit -m "feat: persist connected model configuration"
```

---

### Task 2: Shared OpenAI-compatible runtime and safe proxy routes

**Files:**
- Create: `app/lib/global-model-runtime.ts`
- Create: `tests/global-model-runtime.test.mjs`
- Create: `app/api/models/test-text/route.ts`
- Create: `app/api/models/test-image/route.ts`
- Create: `app/api/models/chat/route.ts`
- Create: `tests/global-model-route.test.mjs`

**Interfaces:**
- Produces `GlobalTextConfig`, `GlobalImageConfig`, `ChatTurn`, and `SafeModelError`.
- Produces `usesBrowserDirectModelRoute(baseUrl: string): boolean`.
- Produces `testTextConnection(config, options): Promise<void>`.
- Produces `testImageConnection(config, options): Promise<void>`.
- Produces `generateChatReply(config, turns, options): Promise<string>`.
- Produces `safeModelErrorMessage(error, apiKey): string`.
- Each route accepts bounded JSON and returns `{ ok: true }`, `{ ok: true, reply }`, or `{ ok: false, code, message }` with `Cache-Control: no-store`.

- [ ] **Step 1: Write failing runtime validation and routing tests**

Cover exact `https://apinebula.ai` browser-direct matching, lookalike rejection, HTTP/private/localhost rejection, safe endpoint appending, bounded turns, control-character Key rejection, redirect blocking, timeout, cancellation, chat parsing, model-list parsing, and Key redaction.

```js
test("APINebula direct routing requires the exact HTTPS hostname", () => {
  assert.equal(usesBrowserDirectModelRoute("https://apinebula.ai/v1"), true);
  assert.equal(usesBrowserDirectModelRoute("https://apinebula.ai.evil.test/v1"), false);
  assert.equal(usesBrowserDirectModelRoute("http://apinebula.ai/v1"), false);
});
```

- [ ] **Step 2: Run runtime tests and verify RED**

Run:

```bash
npx tsx --test tests/global-model-runtime.test.mjs
```

Expected: FAIL because the runtime does not exist.

- [ ] **Step 3: Implement validation, safe errors, and request builders**

Reuse the proven public-HTTPS, redirect, deadline, and redaction patterns from `app/lib/content-matrix-runtime.ts` without importing ContentMatrix prompts or stage logic.

Use fixed downstream endpoints:

```ts
const TEXT_TEST_PATH = ["chat", "completions"];
const IMAGE_TEST_PATH = ["models"];
const CHAT_PATH = ["chat", "completions"];
```

Text tests send a fixed short message and small output budget. Image tests confirm exact model ID membership in the normalized `/models` payload. Chat accepts only bounded `user` and `assistant` turns and returns parsed text.

- [ ] **Step 4: Run runtime tests and verify GREEN**

Run:

```bash
npx tsx --test tests/global-model-runtime.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Write failing proxy route tests**

Test all three routes for valid Bearer forwarding, `redirect: "error"`, `Cache-Control: no-store`, oversize rejection, malformed JSON, unsafe URL rejection, timeout, caller cancellation, missing model, and absence of fake Keys/provider bodies in every response.

- [ ] **Step 6: Run route tests and verify RED**

Run:

```bash
npx tsx --test tests/global-model-route.test.mjs
```

Expected: FAIL because the route modules do not exist.

- [ ] **Step 7: Implement the three thin route adapters**

Each route must parse the bounded request, call one runtime function, and return only safe payloads:

```ts
export async function POST(request: Request) {
  try {
    const input = await readBoundedModelRequest(request);
    const reply = await generateChatReply(input.config, input.turns, {
      signal: request.signal,
    });
    return noStoreJson({ ok: true, reply });
  } catch (error) {
    return modelErrorResponse(error);
  }
}
```

The test routes return no provider response content.

- [ ] **Step 8: Run runtime and route tests and commit**

Run:

```bash
npx tsx --test tests/global-model-runtime.test.mjs tests/global-model-route.test.mjs
```

Expected: PASS.

Commit:

```bash
git add app/lib/global-model-runtime.ts app/api/models/test-text/route.ts app/api/models/test-image/route.ts app/api/models/chat/route.ts tests/global-model-runtime.test.mjs tests/global-model-route.test.mjs
git commit -m "feat: add safe global model runtime"
```

---

### Task 3: Reference-style global model settings UI

**Files:**
- Create: `app/components/GlobalModelSettings.tsx`
- Modify: `app/components/ModelConfigPanel.tsx`
- Modify: `app/components/ModelRegistryProvider.tsx`
- Modify: `app/globals.css`
- Modify: `tests/workbench-ui.test.tsx`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- `GlobalModelSettings` consumes the registry context and `onPreview`.
- A text draft contains `provider`, `displayName`, `baseUrl`, `modelId`, `apiKeyDraft`, `clearCredential`, `enabled`, and `isDefault`.
- An image draft contains `baseUrl`, `modelId`, `apiKeyDraft`, `clearCredential`, and `enabled`.
- Testing uses the direct runtime only when `usesBrowserDirectModelRoute(baseUrl)` is true; otherwise it calls the matching proxy route.

- [ ] **Step 1: Replace preview-oriented UI assertions with failing real-settings tests**

Test:

- “模型设置” heading and explanatory text.
- Text and image sections.
- Masked saved Key with no full fake Key in `document.body.textContent`.
- Blank Key retention and explicit clear.
- Save/cancel draft behavior.
- Text test success enabling the model.
- Parameter edits changing status to “配置已变更”.
- Failed/untested model cannot be enabled.
- Image test uses `/models` or `/api/models/test-image` and never `/images/generations`.
- Mobile form controls remain available.

- [ ] **Step 2: Run UI tests and verify RED**

Run:

```bash
npx tsx --test tests/workbench-ui.test.tsx tests/rendered-html.test.mjs
```

Expected: FAIL because the current global panel only manages display metadata.

- [ ] **Step 3: Implement `GlobalModelSettings`**

Use semantic forms and status regions. The saved-Key line must render only `getMaskedCredential(id)`. A blank password input never receives the stored Key as its `value`.

Use request state keyed by text model ID so testing one card does not block the others. On any connection-field edit, call a provider action that invalidates the tested fingerprint.

- [ ] **Step 4: Delegate only global scope from `ModelConfigPanel`**

Keep the existing Agent radio-selector branch. Replace the global branch with:

```tsx
return <GlobalModelSettings onPreview={onPreview} />;
```

Do not alter the ContentMatrix Agent configuration path.

- [ ] **Step 5: Add reference-style responsive CSS**

Add focused classes for:

- `.global-model-settings`
- `.model-settings-header`
- `.model-settings-card`
- `.credential-saved-line`
- `.connection-status`
- `.model-settings-actions`
- `.model-settings-footer`

Desktop uses two-column Base URL/model fields. At the existing mobile breakpoint, fields and footer actions stack without horizontal overflow.

- [ ] **Step 6: Run UI tests and verify GREEN**

Run:

```bash
npx tsx --test tests/workbench-ui.test.tsx tests/rendered-html.test.mjs tests/model-registry-provider.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit settings UI**

```bash
git add app/components/GlobalModelSettings.tsx app/components/ModelConfigPanel.tsx app/components/ModelRegistryProvider.tsx app/globals.css tests/workbench-ui.test.tsx tests/rendered-html.test.mjs tests/model-registry-provider.test.tsx
git commit -m "feat: build connected global model settings"
```

---

### Task 4: Real home chat with retry and cancellation

**Files:**
- Modify: `app/components/ControlDesk.tsx`
- Modify: `app/globals.css`
- Modify: `tests/workbench-ui.test.tsx`

**Interfaces:**
- `ControlDesk` consumes only connected enabled text models.
- Visible messages use `{ id, role, content, modelName? }`.
- Provider turns sent to the runtime use `{ role: "user" | "assistant", content: string }`.
- Browser-direct models call `generateChatReply`.
- Proxy models call `POST /api/models/chat`.

- [ ] **Step 1: Write failing real-chat UI tests**

Test:

- Empty send stays disabled.
- Quick prompt fills the textarea.
- A submitted user message appears immediately.
- APINebula exact-domain config calls the provider URL directly.
- Other configs call `/api/models/chat`.
- Successful reply renders with the actual model display name.
- The outbound history is bounded.
- Model switching retains visible conversation.
- Stop aborts the current request.
- Failure keeps the user message and exposes “重新发送”.
- Full fake Keys and provider raw error bodies never render.

- [ ] **Step 2: Run chat UI tests and verify RED**

Run:

```bash
npx tsx --test tests/workbench-ui.test.tsx
```

Expected: FAIL because send still emits the preview toast.

- [ ] **Step 3: Implement controlled input and conversation state**

Add controlled input, message list, pending request metadata, `AbortController`, and a bounded conversion helper:

```ts
const MAX_CONTEXT_TURNS = 20;

function toProviderTurns(messages: ChatMessage[]): ChatTurn[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-MAX_CONTEXT_TURNS)
    .map(({ role, content }) => ({ role, content }));
}
```

Disable send when the input is blank, no connected model is selected, or a request is pending.

- [ ] **Step 4: Implement direct/proxy request dispatch**

Resolve the selected model credential at send time. Use direct runtime only for the exact direct-route predicate; otherwise send the config, Key, and bounded turns to `/api/models/chat`. Never put the Key into message state or UI error state.

- [ ] **Step 5: Implement stop and retry**

“停止” aborts the active controller and leaves existing messages intact. “重新发送” retries the last failed user turn using the currently selected connected model.

- [ ] **Step 6: Add chat transcript CSS**

Add accessible transcript spacing, distinct user/assistant surfaces, model labels, pending indicator, safe error panel, retry/stop controls, and mobile dynamic-width behavior.

- [ ] **Step 7: Run chat and regression tests and commit**

Run:

```bash
npx tsx --test tests/workbench-ui.test.tsx tests/global-model-runtime.test.mjs tests/global-model-route.test.mjs
```

Expected: PASS.

Commit:

```bash
git add app/components/ControlDesk.tsx app/globals.css tests/workbench-ui.test.tsx
git commit -m "feat: connect home chat to configured models"
```

---

### Task 5: Full regression, security verification, and branch handoff

**Files:**
- Modify only files required to fix failures caused by Tasks 1–4.

**Interfaces:**
- No new product behavior.
- Produces a clean, tested `codex/multi-agent-ui` branch without merging.

- [ ] **Step 1: Run targeted security scans**

Run:

```bash
rg -n "console\\.(log|error)|localStorage|apiKey|authorization" app/components app/api/models app/lib/global-model-runtime.ts app/lib/model-credential-store.mjs
```

Inspect every hit and verify no code logs a Key, places it in ordinary registry metadata, or returns it from a route.

- [ ] **Step 2: Run all tests**

Run:

```bash
npm test
```

Expected: all tests pass, including build.

- [ ] **Step 3: Run lint and diff checks**

Run:

```bash
npm run lint
git diff --check
git status --short
```

Expected: lint and diff checks pass; only intentional tracked changes exist before the final commit.

- [ ] **Step 4: Manually verify the local preview with fake credentials**

Start:

```bash
npm run dev
```

Verify:

- Model settings match the approved reference structure.
- A fake failed Key remains masked and produces only a safe error.
- A configured connected test fixture can send and render a chat response.
- No full Key appears in the DOM, page source, URL, or terminal output.
- ContentMatrix Agent still opens its independent configuration and runner.

- [ ] **Step 5: Handle any verification failure at its owning task**

If verification finds a regression, return to the task that owns the affected file, add a failing regression test, implement the smallest fix, run that task's focused command, and commit the exact files listed by that task. If verification is clean, create no additional commit.

- [ ] **Step 6: Re-run final verification after the last tracked change**

Run:

```bash
npm test
npm run lint
git diff --check
git status --short
```

Expected: all checks pass and the tracked worktree is clean.

- [ ] **Step 7: Present branch integration choices**

Report the implemented behavior, verification evidence, branch name, and latest commit. Keep the branch unmerged until the user explicitly selects local merge or PR creation.
