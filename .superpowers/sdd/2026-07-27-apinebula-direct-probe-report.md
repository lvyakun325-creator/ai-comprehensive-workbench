# APINebula direct text-model probe report

## Scope

- Only changed the isolated content-matrix runtime, route-facing tests, and its configuration panel.
- Did not change the other eight Agent projects or the global model configuration.
- Did not read or persist any real API Key.

## RED

Added behavior tests before production changes and ran:

```text
npm test -- --test-name-pattern='APINebula|route APINebula'
```

Observed three expected failures:

- runtime still called `/models`, so the APINebula chat-completion fixture was rejected;
- route returned 502 instead of the minimal successful connection result;
- APINebula UI still exposed `测试连接` instead of `测试文案模型`.

The pre-existing safe status mapping made the new 401/malformed safety case partly pass before the branch change; the direct-probe path itself was still covered by the failing request-shape tests.

## GREEN

Implemented the minimum compatibility branch:

- exact hosts `apinebula.ai` and `api.yhlxj.ai`;
- only for `openai-compatible`;
- POSTs `{baseUrl}/chat/completions`;
- sends only the fixed system/user messages and `max_tokens: 32`;
- validates a non-empty OpenAI `choices[0].message.content`;
- returns only `{ connected: true, modelAvailable: true }`;
- keeps existing safe error mapping, redirect blocking, timeout, and no-store route response;
- keeps every other provider on `GET /models`.

Updated the APINebula-only configuration UI to:

- label the action `测试文案模型`;
- disclose that one fixed short message is sent and may incur a very small model-call charge.

## Verification

- Targeted: `4/4` APINebula tests passed.
- Full `npm test`: build passed; `72/72` tests passed.
- `npm run lint`: exited 0.
- `git diff --check`: exited 0.

## Security and concerns

- The probe has no client-provided prompt and receives no diagnosis, history, or feedback.
- The provider reply is parsed only for validity and is never returned to the browser.
- API Key remains only in the existing React page memory and provider auth header.
- A successful probe is a real generation request and may incur a very small charge; the UI now states this explicitly.

## Review fix: disclosure/runtime predicate alignment

### RED

Added tests for both directions of the UI decision:

- changing the APINebula preset to the wrong protocol or a lookalike hostname must restore `测试连接` and remove the charge disclosure;
- a custom OpenAI-compatible configuration using the exact official hostname must show `测试文案模型` and the charge disclosure.

The UI test failed as expected because it still keyed the disclosure from the selected preset. Runtime boundary fixtures for both lookalike hostnames and the wrong protocol passed, confirming the server branch was already exact.

### GREEN

- Exported one client-safe pure `usesApinebulaDirectProbe(protocol, baseUrl)` predicate from the content-matrix runtime.
- Reused that predicate in both the server runtime and the content-matrix configuration UI.
- Invalid URLs safely return `false`.
- Exact official hostnames plus `openai-compatible` are now the only condition that enables both the paid probe and its disclosure.

Targeted review-fix verification: `3/3` passed.

## Root-cause closure: browser-direct APINebula path

### Evidence

- The reference new-media generator successfully loaded its already-saved text-model configuration and returned `文案模型连接正常`.
- The same saved configuration returned HTTP 200 with non-empty OpenAI `choices/message/content` when called locally with the fixed 32-token probe.
- The deployed Sites route returned the same sanitized `PROVIDER_UNAVAILABLE` result for fake-key requests to both official APINebula hostnames, isolating the failure to the Cloudflare outbound path rather than one hostname or token format.
- Both official domains answered the workbench-origin CORS preflight with status 204 and permitted the required origin, headers, and POST method.
- No real API Key was read, copied, logged, or written during this implementation.

### RED

Added React behavior tests requiring:

- APINebula test and stage execution to call the official provider URL directly instead of the same-origin workbench route;
- a later confirmed stage to preserve the runtime-built history and stage prompt;
- APINebula 401 bodies, URLs, and Keys to be replaced by the runtime's safe error;
- non-APINebula providers to remain on the workbench server proxy;
- browser storage and the rendered DOM to remain free of the Key.

The direct-call and safe-error tests both failed before implementation because APINebula still used the same-origin route and the configuration panel still claimed every request used the server proxy.

### GREEN

- `AgentWorkspace` now calls the existing `createContentMatrixRuntime({ fetchImpl: fetch })` only when the shared exact-host/protocol predicate selects APINebula.
- Both connection testing and stages 2 through 5 reuse the same runtime validation, fixed probe, prompts, confirmation rules, response parsing, timeout, redirect blocking, Key redaction, and final-stage contract.
- The existing revision/request guards still discard stale direct responses.
- Known runtime errors expose only `ContentMatrixRuntimeError.message`; unknown failures use the existing generic safe message.
- Other providers still POST only to `/api/agents/content-matrix`.
- The panel now accurately distinguishes the APINebula browser-direct path from the server-proxy path and discloses the small probe charge.

Final browser-direct targeted verification: `5/5` passed.
Full verification after this change: build passed and `77/77` tests passed.

## Review fix: draft versus active-session disclosure

### RED

A new React test applied an APINebula browser-direct configuration and then edited the draft back to a proxied provider. It failed because the panel described only the draft, incorrectly implying the already-applied session would run through the server. The inverse draft/active mismatch was included in the same behavior test.

### GREEN

- The panel now labels two independent paths:
  - `当前草稿测试路径`, derived from the editable draft;
  - `已应用会话运行路径`, derived from `activeConfig`.
- Applying APINebula and editing the draft to another provider keeps the active-session browser-direct disclosure accurate.
- Applying a proxied provider and editing the draft to APINebula shows the inverse paths accurately.
- Neither disclosure renders a Key.
- The browser-direct integration test now runs and validates every stage from 2 through 5, including each confirmation and the accumulated prior-stage history.

Final verification: build passed; `78/78` tests passed.
