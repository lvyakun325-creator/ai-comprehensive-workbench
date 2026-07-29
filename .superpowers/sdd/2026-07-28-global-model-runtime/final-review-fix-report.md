# Final review fix report

## Outcome

The final review findings are fixed under the human ruling: arbitrary custom ContentMatrix Base URLs remain supported, but only through validated browser-direct requests. The server route is restricted to the four reviewed official HTTPS origins on the default port and cannot be switched by request JSON or injected runtime options.

No real API Key was read or used. All provider tests use explicit fake fixtures. The pre-existing `progress.md` modification was not touched or submitted.

## Human ruling implemented

- Server proxy accepts only:
  - `https://api.openai.com`
  - `https://api.anthropic.com`
  - `https://generativelanguage.googleapis.com`
  - `https://api.deepseek.com`
- Exact APINebula origins and arbitrary safe third-party origins use browser-direct requests.
- Browser-direct custom origins reject HTTP, credentials, query/fragment components, single-label and local hostnames, private/special IP literals, IPv4-mapped IPv6, unsafe ports, known DNS-rebinding suffixes, and redirects.
- The UI explicitly states that custom direct calls require provider CORS support and send the Key directly from the current browser.

## Product changes

- Added explicit `server-proxy` and `browser-direct` ContentMatrix egress modes.
- Hard-coded the server route to `server-proxy`, after all request/injected options, and propagated caller cancellation.
- Added bounded incremental upstream reads with stream cancellation on overflow.
- Added limits for response bytes, model count, model ID length, generated Markdown, and provider output tokens.
- Kept ContentMatrix validation/compliance/history behavior and APINebula safe errors intact.
- Made unsaved model-settings edits a true navigation transaction: unmount restores the exact entry baseline, aborts probes, and removes orphan `testing` states; Save establishes the new baseline.
- Synchronized `.mjs` declarations, added credential-store and Cloudflare/JSDOM typing support, and added deterministic `npm run typecheck`.
- Updated README and visible runtime copy to describe the real behavior.
- Added accessible chat transcript semantics, textarea focus styling, safe short-Key masking, and removed the unused model-ID tracking ref.

## TDD evidence

Focused RED was recorded before production changes:

- ContentMatrix route: 3 failures for APINebula/custom server rejection, hard-coded egress, and caller cancellation.
- ContentMatrix runtime: 9 failures covering APINebula exact matching, token limits, custom URL hardening, server whitelist, response/model/Markdown bounds.
- Credential masking: the 4-character boundary exposed the full short value.
- ContentMatrix UI: custom provider incorrectly used the server route and generation failed.
- Chat accessibility: transcript had no log semantics.
- Shell copy mutation: the rendered HTML test rejected `本地设计预览`.
- Navigation rollback mutation: removing unmount rollback made the focused settings test file fail and leave orphan async state.
- Initial typecheck: 22 errors from stale/missing declarations and environment/test types.
- Initial lint: 3 branch-introduced warnings.

GREEN after implementation:

- ContentMatrix route/runtime focused suite: 55/55.
- ContentMatrix UI focused checks: 6/6.
- Credential masking: 3/3.
- Chat transcript accessibility: 1/1.
- Model-settings navigation/Save checks: 5/5.
- Shell copy mutation restored and covered by rendered HTML.
- Full suite, lint, typecheck, diff check, and sensitive-data scan are recorded in the final verification section below.

## Files changed

- Runtime and route: `app/lib/content-matrix-runtime.ts`, `app/api/agents/content-matrix/route.ts`
- Provider UI: `app/components/AgentWorkspace.tsx`, `app/components/ContentMatrixConfigPanel.tsx`
- Model transaction: `app/components/GlobalModelSettings.tsx`
- Accessibility/copy: `app/components/ControlDesk.tsx`, `app/components/WorkbenchShell.tsx`, `app/globals.css`
- Types/runtime support: `app/lib/*.d.mts`, `cloudflare-env.d.ts`, `app/page.tsx`, `package.json`, `package-lock.json`
- Documentation: `README.md`
- Focused regression coverage: ContentMatrix, credential, registry, rendered HTML, and workbench UI tests.

## Limits and safety behavior

- Maximum raw upstream response: 2 MiB, enforced for declared and streamed bodies.
- Maximum model list: 1000 entries.
- Maximum model ID: 200 characters.
- Maximum generated Markdown: 200,000 characters.
- Long-form output tokens: 8192 for OpenAI-compatible/DeepSeek/custom and Gemini, 4096 for Anthropic; APINebula retains its measured workflow budgets.
- Provider errors remain sanitized and do not echo Keys or upstream bodies.

## Final verification

- Focused ContentMatrix route/runtime and credential tests: 58/58 passed.
- Focused UI/render regression command: 3/3 matching tests passed.
- `npm test`: build passed; 214/214 tests passed.
- `npm run lint`: passed with zero warnings and zero errors.
- `npm run typecheck`: passed.
- `git diff --check`: passed.
- High-confidence secret-pattern scan: passed with no matches.

## Remaining concern

`npm install` reports 18 dependency advisories (1 low, 4 moderate, 13 high). No broad `npm audit fix` was run because it could introduce unrelated or breaking dependency changes; this should be handled as a separate dependency-maintenance task.
