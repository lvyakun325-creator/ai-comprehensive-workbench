# Task 3 report — reference-style global model settings UI

## Status

DONE_WITH_CONCERNS

## Change summary

- Added `GlobalModelSettings`, a responsive global settings form with separate text-model cards and a single image-model card, saved-Key masks, explicit credential clearing, save/cancel drafts, test states, enable/default controls, add/delete actions, and semantic status regions.
- Kept `ModelConfigPanel`'s Agent radio-selector path unchanged and delegated only the global branch to `GlobalModelSettings`. The ContentMatrix configuration path was not modified.
- Extended `ModelRegistryProvider` with metadata draft saving, text/image connection invalidation, safe enable gating, and final default-model support.
- Routed exact APINebula HTTPS origins through the direct runtime with explicit `egressMode: "browser-direct"`. All other tests call `/api/models/test-text` or `/api/models/test-image`; no browser input can place `egressMode` into a proxy request body.
- Image validation uses only the direct `/models` probe or `/api/models/test-image`. No image generation endpoint is called.
- Added desktop two-column connection fields, mobile single-column fields and stacked footer actions, with no hidden mobile form controls.
- Added the explicit security boundary: “浏览器本机保存不是硬件级加密，同源脚本可读取。”

## RED / GREEN evidence

| Cycle | RED evidence | GREEN evidence |
| --- | --- | --- |
| Real settings UI | `npx tsx --test tests/workbench-ui.test.tsx tests/rendered-html.test.mjs` failed with 8 UI/HTML failures because the old global panel only managed display metadata and did not provide the settings heading, credential fields, test routes, status regions, or responsive classes. | The implemented settings component passed the focused UI/HTML/Provider suite. |
| APINebula direct egress | `npx tsx --test --test-name-pattern="APINebula" tests/workbench-ui.test.tsx` failed 2/2 because direct text and image probes entered the runtime without the explicit browser-direct mode and ended in “连接失败”. | The same command passed 2/2 after both runtime calls explicitly passed `{ egressMode: "browser-direct" }`. |
| Final default selection | `npx tsx --test --test-name-pattern="final default model" tests/workbench-ui.test.tsx` failed because saving two card drafts left `openai-gpt-5-6` as default instead of `openai-gpt-secondary`. | The same command passed after the UI applied the final selected default after all per-card draft saves. |

## Final verification

```bash
npx tsx --test tests/workbench-ui.test.tsx tests/rendered-html.test.mjs tests/model-registry-provider.test.tsx
```

Result: 37 tests passed, 0 failed, 0 skipped.

```bash
npm run build
```

Result: Vinext production build completed successfully and included the three model API routes. The existing informational dynamic-route classification notice remained.

```bash
npm run lint
```

Result: 0 errors. Three pre-existing `@typescript-eslint/no-unused-vars` warnings remain in `tests/model-registry.test.mjs`; no Task 3 file produced a warning.

```bash
git diff --check
```

Result: passed.

## Commit

Implementation commit: `524c77402adc206b54b127f8feeaa782fdeeade3` (`feat: build connected global model settings`).

## Self-review

- Confirmed a blank password field never receives a stored Key. Text and image saved-Key lines show only masked values, and UI tests prove neither full fake Key appears in `document.body.textContent`.
- Confirmed blank credential drafts retain saved values and only checked clear controls remove them.
- Confirmed every API Key, Base URL, or model-name edit invalidates the prior tested fingerprint and renders “配置已变更”.
- Confirmed untested and failed text/image configurations cannot be enabled; successful tests unlock the controls.
- Confirmed text request state is keyed by model ID, so one card's test does not disable other cards.
- Confirmed APINebula direct routing is selected only through the exact runtime predicate and receives explicit browser-direct egress. Proxy bodies contain only `config`.
- Confirmed proxy image testing calls `/api/models/test-image`; direct image testing calls `/models`; neither path calls `/images/generations`.
- Confirmed cancel restores the pre-edit configuration snapshot, removes newly added drafts, and cancels pending deletions. Delete is committed only by “保存设置”.
- Confirmed final default selection is applied after all card drafts, avoiding registry normalization fallback.
- Confirmed global delegation did not change the Agent selector or ContentMatrix files.
- Mutation check: exposing the full Key, populating password values, retaining connected state after edits, enabling failed models, using a wildcard direct route, omitting browser-direct mode, adding `egressMode` to proxy bodies, calling image generation, or failing to apply the last default would each fail focused coverage.

## Remaining concerns

- Browser local storage is intentionally not hardware-backed encryption and remains readable by any script that gains execution in the same origin; the UI now states this directly.
- APINebula browser-direct success still depends on the provider's live CORS policy and browser network conditions. A provider-side CORS change will surface as a connection failure rather than falling back to the server proxy.
- This task does not implement real home chat; that remains the separately scoped Task 4.

---

## Fix round 1 — stale probes and credential revisions

### Status

DONE

### Fix summary

- Every text and image connection probe now owns an `AbortController`, an opaque request token, the exact credential revision, and the complete connection fingerprint.
- Editing connection fields, replacing or clearing a Key, retesting, deleting, saving, canceling, leaving model settings, and unmounting all abort the affected probe. A stale completion must also pass token, revision, and fingerprint checks before it can write status, configuration, or credentials.
- Retest remains available while a request is active; the newer request aborts and supersedes the older request.
- Added persistent opaque text/image credential revisions. Blank drafts retain the prior revision, replacement and clear generate a new revision, and cancel can restore or remove the exact baseline revision.
- Successful connection fingerprints now bind Base URL, model ID, and opaque credential revision without including credential material.
- Cancel now restores credentials, credential revisions, deleted models, newly added models, image configuration, and the original default model.
- Updated the legacy content-matrix UI assertion to the current global settings heading.

### RED / GREEN evidence

| Cycle | RED evidence | GREEN evidence |
| --- | --- | --- |
| Credential revisions | `npx tsx --test --test-name-pattern="opaque credential revisions" tests/model-registry-provider.test.tsx` failed because the Provider returned `missing`. | The same focused test passed after adding persistent opaque revisions and public revision accessors. |
| Fingerprint normalization | `npx tsx --test --test-name-pattern="opaque credential revision" tests/model-registry.test.mjs` failed because a valid revision-bound fingerprint normalized to `changed`. | The same test passed after validating the fingerprint structure and matching its Base URL and model ID while retaining the opaque revision. |
| Deferred probe races | The focused stale/retest/cancel/delete/unmount suite failed 7/7: proxy requests had no abort signal, a second test could not start, and stale successes or failures could overwrite current state. | The expanded focused suite passed 8/8, including full cancel restoration. |
| Full cancel restoration | `npx tsx --test --test-name-pattern="cancel fully restores" tests/workbench-ui.test.tsx` failed because original revisions were regenerated and a newly added model left an orphan revision. | The same test passed after exact baseline revision restoration and explicit removal of revisions for canceled additions. |

### Final verification

```bash
npm test
```

Result: production build completed and all 177 tests passed with 0 failures.

```bash
npm run lint
```

Result: 0 errors. The same three existing unused-variable warnings remain in `tests/model-registry.test.mjs`.

```bash
git diff --check
```

Result: passed.

### Remaining concerns

- Credential storage remains origin-readable browser storage, not hardware-backed encryption; the existing UI disclosure remains accurate.
- The opaque revision is a connection-validity token, not an encryption key or credential hash.

---

## Fix round 2 — revision-bound availability and interrupted-save settling

### Status

DONE

### Fix summary

- Provider hydration now reconciles every text and image connection against the complete stored fingerprint: Base URL, model ID, and the current opaque credential revision.
- Connected or orphaned testing metadata without a usable credential/revision becomes `untested` when it has no fingerprint, or `changed` when an old/mismatched fingerprint exists. A fully matching interrupted testing record settles back to `connected`.
- Legacy credentials still receive a newly generated opaque revision, but their former empty-revision fingerprint is invalidated instead of being trusted.
- Replacing or clearing a credential immediately invalidates the prior text/image connection. Provider save APIs also reject a `connected` result whose fingerprint carries a stale revision.
- Saving while a text or image probe is active now captures the interrupted request, aborts it, and persists a settled non-testing state. The aborted response cannot later overwrite the saved state.
- Probe startup retains a prior valid fingerprint so an interrupted retest of unchanged configuration can settle back to `connected`.
- The mount effect now explicitly restores `mounted.current = true`; a StrictMode replay test verifies that a current probe can still finish after effect setup/cleanup replay.
- Existing connected test fixtures now include matching credential and revision storage, reflecting states that can actually be available.

### RED / GREEN evidence

| Cycle | RED evidence | GREEN evidence |
| --- | --- | --- |
| Hydration revision reconciliation | Four focused Provider tests failed 4/4: text mismatch stayed connected, missing-revision testing stayed testing, legacy migration stayed connected, and image mismatch stayed connected. | The same four tests passed after full revision reconciliation for text and image hydration. |
| Immediate credential replacement | The focused Provider test failed because replacing the Key left the model in the connected set. | It passed after replacement/clear synchronously invalidated connection metadata. |
| Stale result rejection | Two focused Provider tests failed because text and image save APIs accepted `connected` fingerprints carrying an old revision. | Both passed after Provider writes validated connected results against synchronous credential/revision refs. |
| Save during probe | Deferred text and image tests failed because saving aborted the signal but left page/storage as `testing` or `changed` without applying the required fingerprint-based settling rule. | Both passed after save captured active probes and settled exact matches to `connected`, mismatches to `changed`, and empty fingerprints to `untested`. |
| StrictMode effect replay | The focused test failed with the text model stuck at “测试中” because the first cleanup left `mounted.current` false. | It passed after each mount setup restores the flag before registering cleanup. |

### Final verification

```bash
npx tsx --test tests/model-registry.test.mjs tests/model-registry-provider.test.tsx tests/workbench-ui.test.tsx
```

Result: 65 tests passed, 0 failed.

```bash
npm test
```

Result: production build completed and all 187 tests passed with 0 failures.

```bash
npm run lint
```

Result: 0 errors. The same three existing unused-variable warnings remain in `tests/model-registry.test.mjs`.

```bash
git diff --check
```

Result: passed.

### Remaining concerns

- Revision reconciliation protects connection eligibility and stale-result writes; it does not encrypt browser storage.
- A migrated legacy credential must be tested once after upgrade because its newly generated revision intentionally invalidates the old empty-revision fingerprint.
