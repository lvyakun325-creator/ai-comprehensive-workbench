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
