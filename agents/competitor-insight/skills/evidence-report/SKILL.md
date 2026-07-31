---
name: evidence-report
description: Render a competitor insight report from supplied evidence using the fixed evidence-report policy and section-batch contract.
---

# Evidence Report

First-phase source scope is restricted to the supplied Excel evidence for one Douyin account. Use `reporting/report-policy.md` as the authoritative reporting policy and validate model section batches against `reporting/section-batch.schema.json` before rendering Markdown. Do not combine other accounts, Xiaohongshu data, web data, or model-invented source material.

Generate exactly three schema-valid JSON batches named `strategy`, `performance`, and `execution`. Every response has only the shared fields `batchId`, `claims`, `topicDirections`, `filmingTemplates`, `conversionItems`, and `executionDays`; do not accept Markdown, code fences, commentary, or extra fields. In `strategy`, claim `section` is restricted to `strategy`, `business`, or `content`. In `performance`, claim `section` is restricted to `traffic` or `data`. Do not infer section placement from claim order. The non-applicable arrays in those two batches are empty. The `execution` batch has no claims and contains the fixed planning outputs.

Preserve evidence IDs exactly. The model must not output, calculate, rewrite, or infer source evidence metrics, total interactions, rankings, source rows, or publication times: those values come only from the deterministic evidence layer. Mark unsupported interpretations as `weak` or `hypothesis` and include their verification plan. Every required `complianceNotes` array contains at least one non-empty warning.

Render the policy's fixed sections in order. The completed report contains five topic directions, three filming templates, seven distinct day entries, and non-empty item-level medical-health compliance notes. Do not invent evidence, claims, medical outcomes, credentials, or platform-rule facts.
