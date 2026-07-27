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
