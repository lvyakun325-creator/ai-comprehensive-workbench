<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **ai-comprehensive-workbench** (1150 symbols, 2396 relationships, 97 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/ai-comprehensive-workbench/context` | Codebase overview, check index freshness |
| `gitnexus://repo/ai-comprehensive-workbench/clusters` | All functional areas |
| `gitnexus://repo/ai-comprehensive-workbench/processes` | All execution flows |
| `gitnexus://repo/ai-comprehensive-workbench/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

## 项目进度同步规则

- 项目长期进度入口：`docs/project-progress/00-项目进度总览.md`。
- 每次完成里程碑、模块状态变化、Agent 接入、正式部署、测试基线变化或出现重大阻塞后，必须更新项目进度总览。
- 达到里程碑或状态发生明显变化时，在 `docs/project-progress/` 新增 `YYYY-MM-DD-项目进度更新.md`。
- 同步内容必须区分“已完成、进行中、尚未完成”，并保留项目初衷、日期、关键指标、风险和线上发布状态。
- 同步项目文件后，同时更新 Obsidian 知识库中的 `codex 仓库/Codex产出/AI综合工作台/00-项目进度总览.md`；里程碑快照也要同步到同一目录。
- 不得把 API Key、Token、账号密码、客户隐私或未经脱敏的经营后台数据写入进度文档。
