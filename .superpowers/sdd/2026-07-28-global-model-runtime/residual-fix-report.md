# Residual fix report

## Scope

Completed only the two residual findings authorized by
`residual-fix-brief.md`:

1. Bound the final sanitized `runStage` Markdown to 200,000 characters.
2. Establish the image-model settings transaction baseline before a direct
   no-edit probe persists `connectionStatus: "testing"`.

No dependency versions, unrelated product behavior, `main`, or
`progress.md` were changed by this repair cycle. All credentials added by the
tests are explicit fake fixtures.

## Finding 1 — final Markdown bound after redaction

### RED

Added:

`rejects generated Markdown that exceeds the final bound only after API Key redaction`

The fixture uses the clearly fake short Key `fake`, reflected 50,000 times.
The raw Markdown is exactly 200,000 characters, so it passes the existing raw
Markdown limit, while redaction expands the final sanitized value beyond the
same limit.

Focused RED command:

```text
npx tsx --test --test-name-pattern "exceeds the final bound only after API Key redaction" tests/content-matrix-runtime.test.mjs
```

Expected failing assertion observed before production changes:

```text
AssertionError [ERR_ASSERTION]: Missing expected rejection.
tests/content-matrix-runtime.test.mjs:1439
```

Result: 0 passed, 1 failed.

### GREEN

After `redactSecret` and before stage-output validation or return, `runStage`
now applies `MAX_GENERATED_MARKDOWN_LENGTH` to the sanitized Markdown. An
oversized value throws the existing `INVALID_PROVIDER_RESPONSE` safe error.
The error does not contain the fake Key, sanitized expansion, endpoint, or
provider body.

Focused GREEN result: 1 passed, 0 failed.

The existing raw provider-response byte, model-count, model-ID, raw Markdown,
token, redirect, URL, and safe-error limits were not changed.

## Finding 2 — image probe baseline before persistent testing state

### RED

Added:

`leaving an unedited image probe restores the exact configured entry baseline`

The UI test hydrates an already connected image model and saved fake
credential, edits no fields, starts the image probe, navigates away while the
request is active, and then returns to model settings.

Focused RED command:

```text
npx tsx --test --test-name-pattern "leaving an unedited image probe restores the exact configured entry baseline" tests/workbench-ui.test.tsx
```

Expected failing assertion observed before production changes:

```text
AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
+ connectionStatus: 'testing'
- connectionStatus: 'connected'
tests/workbench-ui.test.tsx:1972
```

Result: 0 passed, 1 failed.

### GREEN

`testImageModel` now calls `ensureBaseline()` after validating the effective
draft and credential, but before creating probe state or persisting
`connectionStatus: "testing"`. Unmount aborts the upstream request and the
existing rollback restores the exact entry image config, credential, and
credential revision.

Focused GREEN result: 1 passed, 0 failed.

The existing image/text navigation rollback, stale-probe, and Save behavior
remains covered by the focused file and full suite.

## Verification

All commands were run from:

`/Users/lvyakun/Documents/AI综合工作台/.worktrees/codex-multi-agent-ui`

| Check | Result |
| --- | --- |
| Runtime focused test file: `npx tsx --test tests/content-matrix-runtime.test.mjs` | PASS — 43/43 |
| UI focused test file: `npx tsx --test tests/workbench-ui.test.tsx` | PASS — 58/58 |
| Full build and tests: `npm test` | PASS — build complete, 216/216 |
| Lint: `npm run lint` | PASS |
| Typecheck: `npm run typecheck` | PASS |
| Whitespace/error check: `git diff --check` | PASS |
| Added-line credential scan for private keys and common live-token formats | PASS |

The sensitive-data scan covered the scoped product and test diff and
explicitly allowed only the fake `sk-fake...` fixture family.

## Files changed

- `app/lib/content-matrix-runtime.ts`
- `app/components/GlobalModelSettings.tsx`
- `tests/content-matrix-runtime.test.mjs`
- `tests/workbench-ui.test.tsx`
- `.superpowers/sdd/2026-07-28-global-model-runtime/residual-fix-report.md`

## Concerns

None.
