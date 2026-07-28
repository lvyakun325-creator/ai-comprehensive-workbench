# Task 2 report — shared OpenAI-compatible runtime and safe proxy routes

## Status

DONE_WITH_CONCERNS

## Change summary

- Added `app/lib/global-model-runtime.ts` with the required `GlobalTextConfig`, `GlobalImageConfig`, `ChatTurn`, and `SafeModelError` interfaces and the required browser-direct matcher, text/image connection tests, chat generation, and safe error-message API.
- Restricted provider URLs to normalized public HTTPS endpoints without credentials, query strings, fragments, localhost/private IP literals, or unsafe endpoint replacement. Downstream paths are fixed to `/chat/completions` and `/models`.
- Added bounded config, Key, model, turn-count, per-turn, total-chat, and route-body validation. API Keys and model IDs reject control characters.
- Added deadline and caller-cancellation propagation, `redirect: "error"`, Bearer-only forwarding, exact image-model membership checks, strict chat/model-list parsing, and safe Key redaction.
- Added the thin `/api/models/test-text`, `/api/models/test-image`, and `/api/models/chat` POST adapters. Every success and error response is JSON with `Cache-Control: no-store`; connection-test routes never return provider content.
- Added focused runtime and route behavior tests. No ContentMatrix, settings UI, home-chat, or unrelated application files were changed by the implementation commit.

## RED / GREEN evidence

| Behavior | RED evidence | GREEN evidence |
| --- | --- | --- |
| Exact APINebula browser-direct matching and lookalike/wrong-protocol rejection | Runtime test command failed with `ERR_MODULE_NOT_FOUND` for `app/lib/global-model-runtime.ts` before implementation. | Runtime test passed the exact-host, uppercase-host, lookalike, HTTP, and malformed URL cases. |
| Public HTTPS validation and control-character Key rejection | Same runtime RED; the runtime module did not exist. | Runtime test rejected HTTP, localhost, private IPv4/IPv6, and CRLF-bearing Keys before any fetch. |
| Safe endpoint appending and bounded text probe | Same runtime RED. | Runtime test observed only `https://api.example.com/v1/chat/completions`, fixed short content, `max_tokens: 16`, Bearer auth, and `redirect: "error"`. |
| Normalized model-list parsing and exact image-model match | Same runtime RED. | Runtime test accepted exact `data[].id` membership and returned safe `MODEL_NOT_FOUND` for a partial match. |
| Bounded user/assistant chat turns | Same runtime RED. | Runtime test rejected empty turns, system roles, blank content, overlong content, and more than 40 turns before fetch. |
| Chat forwarding, parsing, and Key redaction | Same runtime RED. | Runtime test forwarded only bounded turns, parsed `choices[0].message.content`, and redacted an echoed Key. |
| Redirect blocking and safe provider failures | Same runtime RED. | Runtime test confirmed redirect blocking and fixed safe errors without provider detail or Key text. |
| Deadline and caller cancellation | Same runtime RED. | Runtime test distinguished `PROVIDER_TIMEOUT` from `REQUEST_CANCELLED` and verified the provider signal was aborted. |
| Malformed chat/model payload rejection and safe error text | Same runtime RED. | Runtime test returned only fixed `INVALID_PROVIDER_RESPONSE`/safe fallback messages. |
| Three route modules and minimal success payloads | Route test command failed with `ERR_MODULE_NOT_FOUND` for `app/api/models/test-text/route.ts` before implementation. | Route test passed Bearer forwarding, redirect blocking, exact `{ ok: true }`/`{ ok: true, reply }`, and `no-store` checks for all three routes. |
| Bounded/malformed route JSON and unsafe URL response | Same route RED; route modules did not exist. | Route test passed malformed JSON, 64 KiB body-boundary, no-provider-call, and unsafe URL cases. |
| Route timeout, caller cancellation, and missing model | Same route RED. | Route test passed safe 504, safe 499 with downstream abort, and safe exact-model absence responses. |
| No Key/provider-body leakage from any route error | Same route RED. | Route test exercised transport throw, 401 provider body, malformed chat body, and missing-model body; no response contained the fake Key, provider detail, endpoint, list, or test reply. |

## Verification

```bash
npx tsx --test tests/global-model-runtime.test.mjs
```

Initial RED: failed with `ERR_MODULE_NOT_FOUND` for `app/lib/global-model-runtime.ts`.

Runtime GREEN: 11 tests passed, 0 failed, 0 skipped.

```bash
npx tsx --test tests/global-model-route.test.mjs
```

Initial RED: failed with `ERR_MODULE_NOT_FOUND` for `app/api/models/test-text/route.ts`.

Route GREEN: 7 tests passed, 0 failed, 0 skipped.

```bash
npx tsx --test tests/global-model-runtime.test.mjs tests/global-model-route.test.mjs
```

Final focused result: 18 tests passed, 0 failed, 0 skipped.

```bash
npm run build
```

Result: Vinext production build completed successfully and listed all three new model API routes. It retained the existing informational warning that some dynamic routes cannot be classified by static analysis.

```bash
npm run lint
```

Result: 0 errors. Three existing warnings remain in `tests/model-registry.test.mjs`; none are in Task 2 files.

```bash
npx tsc --noEmit
```

Result: did not pass because of pre-existing errors outside Task 2, including `ModelRegistryProvider.tsx`, `TaskCenter.tsx`, `WorkbenchShell.tsx`, `page.tsx`, Cloudflare worker types, and missing `jsdom` declarations. The successful production build and focused Task 2 tests are the applicable passing gates; unrelated type errors were not modified.

## Commit

Implementation commit: `0fd43bf58c31f6c0c6b5c58200030a91fbd56bc4` (`feat: add safe global model runtime`).

## Self-review

- Verified every downstream request carries `redirect: "error"` and a composed abort signal before credentials are sent.
- Verified provider response bodies are never read for non-OK responses and are never included in route payloads.
- Verified text/image test routes return no provider content; chat is the sole route allowed to return parsed model text, with exact configured-Key redaction applied.
- Verified all error payloads contain only `ok`, fixed `code`, and fixed safe `message`; all responses are `no-store`.
- Verified route body reads are incrementally bounded and cancel the reader when the limit is exceeded.
- Verified URL validation rejects credentials, search/hash suffixes, localhost/private literals, and non-HTTPS schemes before fetch.
- Mutation check: wrong endpoint, missing redirect blocking, wrong auth header, permissive model matching, missing turn/body limits, missing abort propagation, missing Key redaction, provider-error passthrough, or missing `no-store` would each fail at least one focused test.
- `git diff --check`, focused tests, production build, and lint completed before the tracking commit.
- `git show --stat 0fd43bf` contains only the six Task 2 implementation/test files required by the brief.

## Remaining concerns

- This runtime blocks private and local IP literals but does not perform DNS resolution or pinning, so a malicious public hostname that later resolves to a private address remains a DNS-rebinding/SSRF concern. A network-layer egress policy or resolver-aware proxy is required for a complete defense.
- API Keys are necessarily present in server-process memory and outbound Authorization headers for the duration of a request. Logging and observability layers outside this runtime must continue to avoid request-header/body capture.
- The repository-wide TypeScript command has unrelated existing failures as listed above; Task 2 did not expand scope to repair them.
