# Task 4 report — real home chat with retry and cancellation

## Status

DONE

## Change summary

- Replaced the home preview-only send action with controlled input and an in-memory visible transcript using `{ id, role, content, modelName? }`.
- Limited selectable models to the Provider's connected models and resolved the selected model credential and opaque credential revision at send or retry time.
- Routed only the exact APINebula HTTPS hostname through `generateChatReply` with explicit `egressMode: "browser-direct"`. All other models call `POST /api/models/chat`; the proxy body contains only `config` and bounded `turns`, with no caller-controlled egress field.
- Bounded runtime history to the latest 20 user/assistant turns and stripped all display-only metadata from provider turns.
- Captured the actual sending model display name per request, so later model switching does not relabel existing assistant messages.
- Added request tokens and `AbortController` ownership for stop, stale completion rejection, credential/model availability changes, and component unmount.
- Added safe failure UI with “重新发送”. Retry preserves the original visible user message and resolves the currently selected connected model and credential again.
- Added responsive transcript, user/assistant surfaces, pending state, safe error panel, retry, and stop styling.
- Kept model settings, ContentMatrix, and all other business modules unchanged.

## RED / GREEN evidence

| Cycle | RED evidence | GREEN evidence |
| --- | --- | --- |
| Real home chat UI | `npx tsx --test tests/workbench-ui.test.tsx` returned 43 passed / 7 failed. All seven new tests failed because quick prompts still emitted preview behavior, send still emitted the preview toast, and no transcript, runtime dispatch, stop, retry, or unmount cancellation existed. | `npx tsx --test --test-name-pattern="home chat\|leaving home chat" tests/workbench-ui.test.tsx` returned 8 passed / 0 failed, including the pre-existing independent-selection test. |
| Direct/proxy routing and security | The APINebula, proxy, safe-failure, and retry tests failed before implementation because no provider request was made and no actual reply or model label was rendered. | The focused tests prove exact APINebula browser-direct dispatch, `/api/models/chat` proxy dispatch without `egressMode`, actual send-time model labels, current-model retry, and no full fake Key or raw provider error body in the DOM. |
| Cancellation and bounded history | The stop, unmount, and bounded-history tests failed before implementation because no request signal or provider turns existed. | The focused tests prove a 20-turn maximum, stop abort, late-reply rejection, visible user-turn preservation, and unmount abort. |

## Final verification

```bash
npx tsx --test tests/workbench-ui.test.tsx tests/global-model-runtime.test.mjs tests/global-model-route.test.mjs
```

Result: 77 tests passed, 0 failed.

```bash
npm test
```

Result: Vinext production build completed and all 198 tests passed, 0 failed.

```bash
npm run lint
```

Result: 0 errors. Three pre-existing `@typescript-eslint/no-unused-vars` warnings remain in `tests/model-registry.test.mjs`; no Task 4 file produced a warning.

```bash
git diff --check
```

Result: passed.

## Commits

- Implementation: `5cbb8e0` (`feat: connect home chat to configured models`)

## Self-review

- Confirmed message and error state never receive the API Key. Pending metadata contains only request identity, model identity/display name, credential revision, user-message identity, and the abort controller.
- Confirmed direct success and error handling reuse the global runtime's secret redaction and safe errors. Proxy failures never parse or render the response body and use a fixed local error.
- Confirmed the proxy body cannot select an egress mode. Server routing remains authoritative.
- Confirmed each assistant message captures the model display name before dispatch; visible conversation remains intact across later model changes.
- Confirmed stop invalidates the active token before aborting. A fetch implementation that ignores abort still cannot append its late reply.
- Confirmed unmount invalidates and aborts the active request without a post-unmount state write.
- Confirmed retry does not append a duplicate user message and re-resolves the current model credential at retry time.
- Confirmed provider turns contain only `role` and `content` and never exceed 20 turns.
- Mutation check: restoring the preview toast, using a non-exact direct predicate, proxying with an egress override, labeling with the current rather than sending model, removing the history slice, accepting a stale completion, omitting abort, duplicating retry turns, or rendering proxy error bodies would each fail focused coverage.

## Remaining concerns

- Credentials remain browser-local and origin-readable as disclosed by the existing global settings UI; Task 4 does not change the storage boundary.
- APINebula browser-direct chat depends on the provider's live CORS policy and browser network conditions. It intentionally does not fall back to the server proxy.
- The home transcript is intentionally in-memory for this task and is cleared when the user leaves the home view or reloads the page.
