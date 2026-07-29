# Task 1 report — connection metadata and isolated browser credential storage

## Status

DONE_WITH_CONCERNS

## Change summary

- Added `app/lib/model-credential-store.mjs`, a pure, bounded credential map that rejects malformed storage and control characters, preserves an existing Key for blank drafts, clears only on an explicit request, and exposes only a masked display value.
- Upgraded model metadata to registry v2: `baseUrl`, `connectionStatus`, and `testedFingerprint` are normalized; v1 records migrate to safe `untested` values; changed URL/model metadata invalidates a previous connected state; only enabled, connected models are selectable.
- Kept text model metadata, text credentials, image metadata, and image credentials in four separate versioned browser stores. The Provider migrates `model-registry:v1` into v2 after hydration and keeps chat and per-Agent selections isolated.
- Added image-config persistence and invalidation when its tested connection address or model changes.
- Updated the `.d.mts` declaration so TypeScript callers receive the extended `ChatModel` contract.

## RED / GREEN evidence

| Cycle | RED evidence | GREEN evidence |
| --- | --- | --- |
| Credential store | `npx tsx --test tests/model-credential-store.test.mjs` failed with `ERR_MODULE_NOT_FOUND` for `app/lib/model-credential-store.mjs`. | The same command passed: 2 tests, 0 failures. |
| Registry metadata | `npx tsx --test tests/model-registry.test.mjs` failed because `connectionFingerprint` was not exported. | The same command passed: 10 tests, 0 failures. |
| Provider isolation | `npx tsx --test tests/model-registry-provider.test.tsx` failed because `connectedModels` and credential/image context values did not exist. | The same command passed after the storage boundaries were implemented. |
| v1 browser migration | Provider test failed because v2 hydration retained the demo model rather than the legacy v1 model. | The same provider command passed after v1 fallback hydration was added. |
| Image invalidation | Provider test failed because a changed image URL/model retained `connectionStatus: connected`. | The same provider command passed after draft save changed the status to `changed`. |
| Selector boundary | Provider test failed because an enabled but untested model remained in the selectable collection. | The same provider command passed after selectable models were restricted to `getConnectedModels`. |

## Verification

```bash
npx tsx --test tests/model-credential-store.test.mjs tests/model-registry.test.mjs tests/model-registry-provider.test.tsx
```

Result: 18 tests passed, 0 failed, 0 skipped.

```bash
npm run build
```

Result: Vinext production build completed successfully. It retained the pre-existing informational warning that dynamic API routes cannot be fully classified by static analysis.

## Commit

Implementation commit: `51f097a1e74ab319b6f042188a7b72ba33570412` (`feat: persist connected model configuration`).

## Self-review

- The ordinary model-registry store is tested not to contain either fake text or image Keys; only the dedicated credential keys persist those values.
- Key replacement trims outer whitespace only; blank drafts retain the old value and explicit clear removes it.
- Old registry records remain non-callable after migration, and chat/Agent selection reconciliation now uses only connected models.
- No ContentMatrix runtime files were changed.
- `git diff --check`, the focused test command, and the production build all passed before the implementation commit.

## Remaining concern

Browser `localStorage` is intentionally used by the approved design, but it is not hardware-backed encryption and is readable by code executing in the same page origin. The settings UI in a later task should present that boundary clearly; this Task 1 implementation does not add UI copy.

## Fix round 1 — review corrections

Status: DONE_WITH_CONCERNS

### Fixed findings

- `maskCredential` now returns the fixed mask `••••` for every valid Key of length 1–3. This prevents a one-, two-, or three-character Key from appearing verbatim in the UI.
- Added the controlled `saveModelConfig(id, draft)` Provider API for an existing text model. It persists `baseUrl`, `modelId`, `connectionStatus`, and `testedFingerprint`; rejects empty connection fields and duplicate provider/model outcomes; clears the fingerprint and changes a previously connected model to `changed` when its URL or model ID is edited. A subsequent successful test result can persist `connected` plus its current fingerprint.

### TDD evidence

| Finding | New coverage | RED command and observed failure | GREEN command and result |
| --- | --- | --- | --- |
| Short Key masking | `tests/model-credential-store.test.mjs` — `masks every character of credentials too short to safely preserve a prefix` | `npx tsx --test tests/model-credential-store.test.mjs` failed: actual `a…`, expected fixed `••••`. | The same command passed: 3 tests, 0 failures. |
| Text draft save and invalidation | `tests/model-registry-provider.test.tsx` — `saves text connection metadata and invalidates a changed successful configuration` | `npx tsx --test tests/model-registry-provider.test.tsx` failed: `saveModelConfig is not a function`, with unchanged connected metadata. | The same command passed: 7 tests, 0 failures. |

### Verification

```bash
npx tsx --test tests/model-credential-store.test.mjs tests/model-registry.test.mjs tests/model-registry-provider.test.tsx
```

Result: 20 tests passed, 0 failed, 0 skipped.

```bash
npm run build
```

Result: Vinext production build completed successfully; the existing dynamic-route static-analysis notice remained informational only.

Fix implementation commit: `1c9046c15d4c269c9503b718b99ae6df0b782686` (`fix: preserve model credential masking and drafts`).
