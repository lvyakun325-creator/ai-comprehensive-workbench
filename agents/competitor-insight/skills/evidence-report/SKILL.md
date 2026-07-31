---
name: evidence-report
description: Render a competitor insight report from supplied evidence using the fixed evidence-report policy and section-batch contract.
---

# Evidence Report

Use `reporting/report-policy.md` as the authoritative reporting policy and validate model section batches against `reporting/section-batch.schema.json` before rendering Markdown.

Accept only the shared batch fields `batchId`, `claims`, `topicDirections`, `filmingTemplates`, `conversionItems`, and `executionDays`. Preserve evidence IDs exactly. Mark unsupported interpretations as `weak` or `hypothesis` and include their verification plan.

Render the policy's fixed sections in order. The completed report contains five topic directions, three filming templates, seven distinct day entries, and the medical-health compliance review. Do not invent evidence, claims, medical outcomes, credentials, or platform-rule facts.
