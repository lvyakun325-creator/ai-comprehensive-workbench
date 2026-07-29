# Agent Task and Markdown Results Final Fix Report

Date: 2026-07-28
Status: DONE_WITH_CONCERNS

## Outcome

All 8 findings in `final-fix-brief.md` are fixed in one final wave:

1. Task cards now render status-specific information:
   - waiting: `等待开始`;
   - running: current step, percentage, and progress bar;
   - completed: `completedAt`;
   - stopped: `stoppedAt`;
   - failed: historical error summary without live-alert semantics.
2. The query layer now provides `getTaskById(taskId)` and explicit result validation. Every result card shows `来源任务：<任务标题>`. Missing, cross-Agent, running-task, or otherwise invalid relations remain visible as abnormal metadata, while preview/copy/download actions are disabled.
3. Task and result empty states use the approved copy. `ProjectResult.markdown` supports `null`, so unavailable Markdown retains filename, size, completion time, and task metadata. Retry remains available and reports its unavailable state inside the modal.
4. The result preview is a real modal interaction:
   - focus moves to the close control;
   - Escape closes;
   - Tab and Shift+Tab remain in the dialog;
   - background body children are `inert` and `aria-hidden`;
   - focus returns to the matching result trigger for both card-opened and task-opened previews.
5. Historical failures no longer use `role="alert"`.
6. The download regression clicks the control and verifies Blob body, Markdown MIME, filename, anchor click, and object URL revocation.
7. Direct `成果文件` tab navigation clears the old one-shot `resultTaskId`, so a closed task-opened preview does not reopen.
8. Fixture sizes are derived from real UTF-8 Markdown bytes and asserted exactly (`123 B` and `88 B`).

Additional review fixes:

- Copy success, clipboard rejection, and unavailable-download feedback are exposed inside the active dialog through a named polite status region; the background toast is no longer the only feedback path while the application root is inert.
- Clipboard rejection is caught and reports `复制失败，请手动选择内容`.
- Invalid source relations cannot expose another Agent's or an unfinished task's Markdown body.
- Explicit `.mjs` declarations for `agent-catalog` and `model-registry` now use `.d.mts`, matching the already established records declaration pattern. `ModelRegistryProvider` copies the readonly defaults before setting mutable React state; runtime model and credential behavior is unchanged.
- The preview portal renders directly into `document.body`; no render-time portal-node allocation or effect-time state update remains.

## TDD Evidence

### Initial RED

- Records command:
  - `npx tsx --test tests/agent-project-records.test.mjs`
  - Exit `1`: 5 passed, 3 failed.
  - Expected failures:
    - `getTaskById` / `isValidProjectResult` were undefined;
    - actual `sizeBytes` was `1480`, expected UTF-8 size `123`;
    - source-task relationship verification could not run without the helper.
- Result/modal/empty-state command:
  - `npx tsx --test --test-name-pattern="Markdown result|Markdown preview|task and result views|five project tabs|task history renders status-specific" tests/workbench-ui.test.tsx`
  - Exit `1`.
  - Expected failures included missing source task text, missing empty-state copy, no unavailable preview behavior, no modal focus movement, and missing abnormal-relation state.
- Status branch command:
  - `npx tsx --test --test-name-pattern="task history renders status-specific" tests/workbench-ui.test.tsx`
  - Exit `1`: `等待开始` was absent because waiting tasks still displayed a generic current step.
- One-shot intent command:
  - `npx tsx --test --test-name-pattern="five project tabs" tests/workbench-ui.test.tsx`
  - Exit `1`: the old task-opened dialog reopened after direct result-tab navigation.

### Review REDs

- Strict AgentWorkspace check initially exited `2` because explicit `.mjs` imports could not resolve the existing `.d.ts` declarations. After moving them to `.d.mts`, the remaining readonly state assignment failed until the state value was copied.
- Lint initially exited `1` on `react-hooks/set-state-in-effect` for the first portal implementation.
- Orphan query test:
  - `npx tsx --test --test-name-pattern="orphan Markdown metadata" tests/agent-project-records.test.mjs`
  - Exit `1`: the query silently returned the normal result instead of preserving orphan metadata for the abnormal UI state.
- Task-opened focus-restoration test exited `1` before trigger refs were registered for `initialTaskId`.
- In-dialog unavailable feedback test exited `1` because retry feedback existed only in the inert background toast.
- In-dialog copy feedback and invalid-relation action tests exited `1` before action status and disabled abnormal actions were implemented.
- Clipboard rejection command:
  - `npx tsx --test --test-name-pattern="clipboard rejection" tests/workbench-ui.test.tsx`
  - Exit `1`: actual message was `复制失败，请稍后重试`, while the actionable expected message was `复制失败，请手动选择内容`.

### Real Download Mutation Check

The original download implementation already met the new test, so the test was mutation-checked:

1. Temporarily changed Blob MIME to `text/plain;charset=utf-8`.
2. Ran:
   - `npx tsx --test --test-name-pattern="exact Blob" tests/workbench-ui.test.tsx`
   - Exit `1`: expected `text/markdown;charset=utf-8`, received `text/plain;charset=utf-8`.
3. Restored the production MIME.
4. Re-ran the same command:
   - Exit `0`: 1 passed, 0 failed.

The temporary mutation is not present in the final diff.

### GREEN

- Focused records and workbench UI:
  - `npx tsx --test tests/agent-project-records.test.mjs tests/workbench-ui.test.tsx`
  - Exit `0`: 29 passed, 0 failed.
- Full build and test suite:
  - `npm test`
  - Exit `0`: production build completed; 121 passed, 0 failed.
- Lint:
  - `npm run lint`
  - Exit `0`: no ESLint errors or warnings.
- Strict project task/result component typecheck:
  - `npx tsc --noEmit --strict --allowJs --skipLibCheck --module esnext --moduleResolution bundler --target ES2023 --jsx react-jsx app/components/AgentTaskList.tsx app/components/AgentResultFiles.tsx app/components/AgentWorkspace.tsx`
  - Exit `0`: no TypeScript errors.
- Diff validation:
  - `git diff --check`
  - Exit `0`.

## ContentMatrix and Credential Safety

- No ContentMatrix diagnosis, connection, provider request, stage generation, regeneration, cancellation, timeout, redaction, credential transport, or credential persistence production code was changed.
- The full 121-test suite passed all ContentMatrix route/runtime/UI cases, including redirect blocking, timeout/cancellation, stale-response rejection, API-key redaction, direct APINebula flow, server-proxy flow, final-output validation, and credential-shaped model-registry rejection.
- No API key, token, password, phone number, identity data, or customer data was added to source, fixtures, logs, or this report.

## Self-review

- External read-only review of the final diff reported:
  - Critical: none;
  - Important: none;
  - Minor: none.
- Result anomalies preserve metadata but cannot expose content.
- Modal cleanup restores every pre-existing `inert` and `aria-hidden` state instead of blindly removing attributes.
- Object URLs are revoked in `finally`.
- ContentMatrix and model-registry focused regressions remained green.

## Concerns

- Non-blocking, pre-existing test-harness limitation: `tests/content-matrix-ui.test.tsx` defines Storage spies on JSDOM storage instances, where those overrides do not intercept prototype methods reliably. This weakness was not introduced by this diff. The current full suite still covers credential rejection/redaction through route, runtime, DOM, request, and model-registry assertions, but the `storageAccesses === 0` checks should later be replaced with `Storage.prototype` spies that allow the known model-registry key and explicitly reject ContentMatrix API-key material.
