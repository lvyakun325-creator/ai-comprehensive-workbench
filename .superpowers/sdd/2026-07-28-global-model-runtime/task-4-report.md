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

---

## Fix round 1 — exchange-safe context and recoverable retry state

### Status

DONE

### Fix summary

- Replaced single-message slicing with complete-exchange selection. Provider history now contains at most the latest nine complete `user`/`assistant` exchanges plus the current `user` turn, for a maximum of 19 valid turns under the 20-turn ceiling.
- Unanswered historical user turns and stray assistants are omitted instead of producing consecutive users or an assistant-first payload. The newest complete exchanges and current user are always retained.
- Made the minimal failure state explicit through the existing `failedRequest` and `pendingRequest` states: unresolved failure blocks ordinary send; retry preserves the failure while pending; retry success clears it; retry failure or stop leaves it retryable.
- Retry continues to reuse the same visible user message and re-resolve the current selected model without inserting a duplicate turn.
- Left the controller-deferred `aria-live` minor unchanged.

### RED / GREEN evidence

| Cycle | RED evidence | GREEN evidence |
| --- | --- | --- |
| Complete exchanges | `npx tsx --test --test-name-pattern="complete exchanges\|unanswered intermediate\|stop during retry\|blocks ordinary sends" tests/workbench-ui.test.tsx` failed 4/4. The long history began with orphaned `assistant: 回复 3`, and an unanswered historical user produced consecutive user roles. | The same focused suite passed 4/4 after exchange-aware selection. The 13th request contains exactly questions/replies 4 through 12 plus question 13, and the unanswered-user case emits one complete exchange plus the current user. |
| Recoverable retry state | Before the fix, retry startup removed “重新发送”, stop could not restore it, and failed state left ordinary send enabled. | After the fix, failure → retry pending → stop → retry again → success passes, all three requests contain the same single user turn, and failed state blocks ordinary send without issuing another request. |

### Final verification

```bash
npx tsx --test --test-name-pattern="home chat|leaving home chat" tests/workbench-ui.test.tsx
```

Result: 11 tests passed, 0 failed.

```bash
npx tsx --test tests/workbench-ui.test.tsx tests/global-model-runtime.test.mjs tests/global-model-route.test.mjs
```

Result: 80 tests passed, 0 failed.

```bash
npm test
```

Result: Vinext production build completed and all 201 tests passed, 0 failed.

```bash
npm run lint
```

Result: 0 errors. The same three pre-existing unused-variable warnings remain in `tests/model-registry.test.mjs`.

```bash
git diff --check
```

Result: passed.

### Commit

- `376481c` (`fix: preserve valid home chat retry context`)

### Self-review

- Confirmed every emitted provider history begins with a user, ends with the current user, alternates roles inside complete historical exchanges, and stays below the 20-turn runtime limit.
- Confirmed an unanswered historical user cannot be paired with a later unrelated assistant or retained beside the current user.
- Confirmed retry startup no longer clears failure state; only a token-current successful reply for the same user clears it.
- Confirmed stop invalidates and aborts the retry request while leaving the failure and original visible user message intact.
- Confirmed failed state is enforced both by the send-button disabled condition and the send-handler guard.
- Mutation check: raw `.slice(-20)`, retaining unmatched users, clearing failure at retry start, omitting failure from either send guard, or failing to clear it on success would each fail focused coverage.

### Remaining concerns

- The provider context maximum is intentionally 19 in the normal request shape because valid alternating history must both begin and end with a user; this remains within the required 20-turn ceiling.
- Browser-local credential and APINebula CORS concerns from the original Task 4 report remain unchanged.
- Transcript persistence and the deferred `aria-live` minor remain outside this fix round.
