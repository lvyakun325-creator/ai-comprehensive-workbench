# 竞品洞察 Agent 单链接分析与成果包 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把竞品洞察 Agent 改为只接收抖音/小红书链接，自动完成平台抓取、确定性证据计算、模型证据报告、成果包封装，并在成功后自动切换到按任务聚合的成果页。

**Architecture:** 保留 8765/8766 两个平台 Skill 采集桥，但统一它们的任务级输出合同；8768 报告桥负责受控数据读取、确定性证据、报告校验、任务/成果包持久化和安全 ZIP。前端只负责链接路由、真实进度、模型批次调度和成果包展示，不再接收浏览器 Excel 文件，也不自行计算排名或拼装成果文件。

**Tech Stack:** Next.js 15、React 19、TypeScript、Node test runner + Testing Library、Python 3.10+、`openpyxl`、`unittest`、本机 loopback HTTP bridge、JSON schema、ZIP 标准库。

## Global Constraints

- 只改竞品洞察 Agent；内容矩阵 Agent 和其他 Agent 的任务、Markdown 成果与配置逻辑保持不变。
- 竞品采集页只有链接入口，不渲染 Excel file input、拖拽、50 MB 浏览器校验或 Base64 上传。
- 抖音、小红书均必须区分 `account` 与 `content`；链接提示只能作 hint，Skill 返回的受控结果才是最终分类。
- Top 10、起号期 Top 5、三类互动榜、均值和占比只由 Python 确定性程序计算；模型不得重排或重算。
- 账号报告必须满足已确认的完整章节、证据引用、5 个选题、3 个拍法和 7 天清单合同；单内容报告不得冒充账号报告。
- 每个新任务使用 `outputs/competitor-insight/<platform>/<taskId>/` 独立目录，不覆盖同账号旧任务。
- 新任务只有在主报告、manifest 和安全 ZIP 都存在，且成果包状态为 `ready` 后才能进入 `completed` 并自动跳转。
- 页面顶层一次任务只显示一个成果包；Excel、JSON、Markdown、图片目录作为折叠子成果存在。
- 历史 v1 记录无损迁移为 v2 `legacy` 成果包，不移动、不重命名、不删除旧文件；旧 ZIP 首次下载时延迟生成。
- 不读取、导出、展示或打包 Cookie、Chrome profile、state、API Key、Token、账号密码或客户隐私。
- 两个采集 Skill 仅执行只读抓取，不点赞、收藏、关注、评论、私信或发布。
- 医疗健康分析不得诊断、承诺疗效、引导停换药、夸大食品/保健品/器械功效或编造医生、医院、病例和数据。
- GitNexus 当前影响分析显示 `CompetitorReportRunner`、`AgentResultFiles` 和 `assemble_report` 为 HIGH 风险；执行对应任务前必须再次运行 upstream impact，并在出现 HIGH/CRITICAL 时先报告影响范围。
- 每个任务结束前运行对应定向测试并单独提交；最终提交前运行 `detect_changes --scope compare --base-ref origin/main`。

---

## File Structure

### 新建文件

- `app/lib/competitor-scrape-client.ts`：校验 8765/8766 健康与抓取响应，向 UI 提供统一 `ScrapeReadyResponse`。
- `tests/competitor-scrape-client.test.mjs`：平台桥请求、任务 ID、响应边界和错误脱敏测试。
- `agents/competitor-insight/runtime/source_reader.py`：把四类抓取结果归一成平台无关的账号/单内容证据输入。
- `agents/competitor-insight/runtime/tests/test_source_reader.py`：抖音账号、抖音作品、小红书账号、小红书笔记四类数据读取测试。
- `app/components/CompetitorResultBundles.tsx`：竞品成果包分类、单卡片、子成果折叠、报告预览、ZIP 下载和访达定位。
- `docs/project-progress/2026-08-01-竞品单链接成果包里程碑.md`：实施完成后的里程碑快照。

### 主要修改文件

- `/Users/lvyakun/.codex/skills/douyin-scraper/bridge_server.py`：任务级目录、结构化 JSON 落盘和统一成功合同。
- `/Users/lvyakun/.codex/skills/douyin-scraper/tests/test_bridge_contract.py`：新桥合同测试。
- `/Users/lvyakun/.codex/skills/xiaohongshu-scraper/bridge_server.py`：解析脚本最终 JSON并返回输入类型、文件路径和统计。
- `/Users/lvyakun/.codex/skills/xiaohongshu-scraper/tests/test_bridge_cors.py`：新桥合同和任务目录测试。
- `app/lib/competitor-platform-router.mjs`、`.d.mts`：链接类型 hint 与四类成果分类。
- `agents/competitor-insight/runtime/contracts.py`、`workbook_reader.py`、`analytics.py`、`evidence_bundle.py`：证据合同 v2 和跨平台读取。
- `agents/competitor-insight/reporting/report-policy.md`、`section-batch.schema.json`：账号/单内容模型合同。
- `app/lib/competitor-report-runtime.ts`：平台无关证据 ID、`content` 批次和输入合同。
- `agents/competitor-insight/runtime/section_validator.py`、`report_renderer.py`、`service.py`：四类报告校验、渲染和安全落盘。
- `agents/competitor-insight/runtime/project_records.py`：schema v2、bundle、manifest、ZIP、迁移和安全下载。
- `agents/competitor-insight/runtime/bridge_server.py`：新分析/成果包接口、二进制下载、移除上传路由。
- `app/lib/competitor-report-client.ts`、`competitor-project-records-client.ts`：新 HTTP 合同和严格解析。
- `app/lib/agent-project-records.mjs`、`.d.mts`：`ProjectBundle` 查询与合并。
- `app/components/CompetitorReportRunner.tsx`：移除第二入口，改为链接任务的报告控制器。
- `app/components/CompetitorInsightPanel.tsx`：统一五阶段工作流和最终 bundle 封装。
- `app/components/AgentWorkspace.tsx`：读取 bundle、完成后按 bundle 聚焦成果页。
- `app/components/AgentResultFiles.tsx`：删除竞品专用逐文件分支，保留其他 Agent Markdown 逻辑。
- `app/globals.css`：单入口五阶段与成果包卡片样式。
- `tests/workbench-ui.test.tsx` 及相关 Node/Python 测试：替换 Excel 上传测试，覆盖四类链接与成果包。
- `docs/project-progress/00-项目进度总览.md` 和 Obsidian 对应总览：同步里程碑、测试基线和线上状态。

---

### Task 1: 统一平台路由与两个抓取 Skill 的任务级成功合同

**Files:**
- Create: `app/lib/competitor-scrape-client.ts`
- Create: `tests/competitor-scrape-client.test.mjs`
- Modify: `app/lib/competitor-platform-router.mjs`
- Modify: `app/lib/competitor-platform-router.d.mts`
- Modify: `tests/competitor-platform-router.test.mjs`
- Modify: `/Users/lvyakun/.codex/skills/douyin-scraper/bridge_server.py`
- Modify: `/Users/lvyakun/.codex/skills/douyin-scraper/tests/test_bridge_contract.py`
- Modify: `/Users/lvyakun/.codex/skills/xiaohongshu-scraper/bridge_server.py`
- Modify: `/Users/lvyakun/.codex/skills/xiaohongshu-scraper/tests/test_bridge_cors.py`

**Interfaces:**
- Consumes: 用户粘贴的分享文字、`competitor-<uuid>` 任务 ID、两个已安装 Skill 的 CLI。
- Produces: `detectCompetitorPlatform(input)` 的 `inputKindHint`/`categoryHint`；`scrapeCompetitorLink(route, sourceUrl, taskId, signal): Promise<ScrapeReadyResponse>`。
- `ScrapeReadyResponse` 精确字段：`platformId`、`skillId`、`inputKind`、`category`、`outputDir`、`dataPath`、`excelPath`、`markdownPath`、`imageDirectory`、`explicitPaths`、`subjectName`、`itemCount`。

- [ ] **Step 1: 对现有路由与调用者做 impact 检查**

Run:

```bash
node .gitnexus/run.cjs impact detectCompetitorPlatform \
  --direction upstream --depth 4 --include-tests \
  --repo '/Users/lvyakun/Documents/AI综合工作台/.worktrees/fix-xhs-prod-verification' \
  --branch codex/link-only-competitor-bundles
```

Expected: 输出 `CompetitorInsightPanel` 和路由测试；若风险为 HIGH/CRITICAL，先把受影响流程发给用户再编辑。

- [ ] **Step 2: 写平台 hint 与严格抓取响应的失败测试**

```js
test("classifies clear account and content paths while short links stay unknown", () => {
  assert.equal(detectCompetitorPlatform("https://www.douyin.com/user/a").inputKindHint, "account");
  assert.equal(detectCompetitorPlatform("https://www.douyin.com/video/1").inputKindHint, "content");
  assert.equal(detectCompetitorPlatform("https://www.xiaohongshu.com/user/profile/a").categoryHint, "xhs-account");
  assert.equal(detectCompetitorPlatform("https://www.xiaohongshu.com/explore/1").categoryHint, "xhs-note");
  assert.equal(detectCompetitorPlatform("https://v.douyin.com/abc/").inputKindHint, "unknown");
});

test("posts taskId and rejects a mismatched platform response", async () => {
  await assert.rejects(
    scrapeCompetitorLink(
      douyinRoute,
      "https://www.douyin.com/user/a",
      "competitor-20260801-a1",
      AbortSignal.timeout(1000),
    ),
    (error) => error.code === "SCRAPE_RESPONSE_INVALID",
  );
});
```

Run:

```bash
npx tsx --test tests/competitor-platform-router.test.mjs tests/competitor-scrape-client.test.mjs
```

Expected: FAIL，因为 hint 字段和 `competitor-scrape-client.ts` 尚不存在。

- [ ] **Step 3: 实现前端平台 hint 与严格客户端**

```ts
export type CompetitorInputKind = "account" | "content";
export type CompetitorInputKindHint = CompetitorInputKind | "unknown";
export type CompetitorBundleCategory =
  | "douyin-account"
  | "douyin-content"
  | "xhs-account"
  | "xhs-note";

export type ScrapeReadyResponse = {
  platformId: "douyin" | "xiaohongshu";
  skillId: "douyin-scraper" | "xiaohongshu-scraper";
  inputKind: CompetitorInputKind;
  category: CompetitorBundleCategory;
  outputDir: string;
  dataPath: string;
  excelPath: string | null;
  markdownPath: string | null;
  imageDirectory: string | null;
  explicitPaths: readonly string[];
  subjectName: string;
  itemCount: number;
};

export async function scrapeCompetitorLink(
  route: CompetitorPlatformRoute,
  sourceUrl: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<ScrapeReadyResponse>;
```

客户端先 `GET <bridge>/health`，再 `POST <bridge>/scrape`，请求体只能是 `{input, taskId}`；响应必须匹配请求平台、任务目录末段必须等于 taskId、路径必须是绝对路径且无 NUL，错误正文不透传给 UI。

- [ ] **Step 4: 为两个 Skill 桥写任务级目录失败测试**

```python
def test_success_contract_uses_task_directory_and_explicit_paths(self):
    payload = build_success_payload(
        parsed_result,
        task_id="competitor-20260801-a1",
        output_dir=self.output_root / "competitor-20260801-a1",
    )
    self.assertEqual(payload["inputKind"], "account")
    self.assertTrue(payload["outputDir"].endswith("competitor-20260801-a1"))
    self.assertIn(payload["dataPath"], payload["explicitPaths"])
```

Run:

```bash
/Users/lvyakun/.codex/skills/douyin-scraper/.venv/bin/python -m unittest \
  /Users/lvyakun/.codex/skills/douyin-scraper/tests/test_bridge_contract.py -v
/Users/lvyakun/.codex/skills/xiaohongshu-scraper/.venv/bin/python -m unittest \
  /Users/lvyakun/.codex/skills/xiaohongshu-scraper/tests/test_bridge_cors.py -v
```

Expected: FAIL，因为两个桥尚未接收 taskId，也未返回统一字段。

- [ ] **Step 5: 实现两个 Skill 桥的统一合同**

```python
TASK_ID = re.compile(r"^competitor-[0-9A-Za-z-]{4,120}$")

def task_output_directory(task_id: str) -> Path:
    if not TASK_ID.fullmatch(task_id):
        raise ValueError("invalid_task_id")
    output = (OUTPUT_DIR / task_id).resolve()
    if output.parent != OUTPUT_DIR:
        raise ValueError("invalid_task_id")
    output.mkdir(parents=True, exist_ok=False)
    return output
```

抖音桥把 CLI 完整成功 JSON原子写入 `结构化数据.json`，并使用任务目录执行 `--excel`；小红书桥解析脚本 stdout 的最终 JSON，验证 `success`、`content_type`、`json_path`、`excel_path`、`markdown_path` 均位于任务目录后再返回。四类映射固定为：抖音账号=`douyin-account`、抖音作品=`douyin-content`、小红书主页=`xhs-account`、小红书笔记=`xhs-note`。

- [ ] **Step 6: 运行合同测试并提交**

Run:

```bash
npx tsx --test tests/competitor-platform-router.test.mjs tests/competitor-scrape-client.test.mjs
/Users/lvyakun/.codex/skills/douyin-scraper/.venv/bin/python -m unittest \
  /Users/lvyakun/.codex/skills/douyin-scraper/tests/test_bridge_contract.py -v
/Users/lvyakun/.codex/skills/xiaohongshu-scraper/.venv/bin/python -m unittest \
  /Users/lvyakun/.codex/skills/xiaohongshu-scraper/tests/test_bridge_cors.py -v
```

Expected: PASS；测试确认桥响应不包含 Cookie/profile/state 路径。

```bash
git add app/lib/competitor-platform-router.mjs app/lib/competitor-platform-router.d.mts \
  app/lib/competitor-scrape-client.ts tests/competitor-platform-router.test.mjs \
  tests/competitor-scrape-client.test.mjs
git commit -m "feat: normalize competitor scraper contracts"
```

---

### Task 2: 建立四类抓取结果的确定性证据合同 v2

**Files:**
- Create: `agents/competitor-insight/runtime/source_reader.py`
- Create: `agents/competitor-insight/runtime/tests/test_source_reader.py`
- Modify: `agents/competitor-insight/runtime/contracts.py`
- Modify: `agents/competitor-insight/runtime/workbook_reader.py`
- Modify: `agents/competitor-insight/runtime/analytics.py`
- Modify: `agents/competitor-insight/runtime/evidence_bundle.py`
- Modify: `agents/competitor-insight/runtime/tests/test_workbook_reader.py`
- Modify: `agents/competitor-insight/runtime/tests/test_analytics.py`
- Modify: `agents/competitor-insight/runtime/tests/test_evidence_bundle.py`

**Interfaces:**
- Consumes: 统一抓取响应中的 `platformId`、`inputKind`、`dataPath`、`excelPath`。
- Produces: `read_scrape_source(...) -> NormalizedSource`；`build_evidence_bundle(parsed, source) -> EvidenceBundleV2`。
- `EvidenceBundleV2` 固定包含 `platformId`、`inputKind`、`reportType`、`subject`、`completeness`、`metrics`、`rankings`、`items` 和可选 `content`。

- [ ] **Step 1: 对现有读取和证据函数做 impact 检查**

```bash
node .gitnexus/run.cjs impact read_account_workbook --direction upstream --depth 4 --include-tests \
  --repo '/Users/lvyakun/Documents/AI综合工作台/.worktrees/fix-xhs-prod-verification' \
  --branch codex/link-only-competitor-bundles
node .gitnexus/run.cjs impact build_evidence_bundle --direction upstream --depth 4 --include-tests \
  --repo '/Users/lvyakun/Documents/AI综合工作台/.worktrees/fix-xhs-prod-verification' \
  --branch codex/link-only-competitor-bundles
```

- [ ] **Step 2: 写四类归一化与账号排名失败测试**

```python
def test_xhs_profile_json_normalizes_all_notes_without_using_skill_score(self):
    parsed = read_scrape_source("xiaohongshu", "account", self.profile_json, self.profile_xlsx)
    self.assertEqual(parsed["subject"]["nickname"], "测试账号")
    self.assertEqual(len(parsed["items"]), 12)
    self.assertNotIn("internal_score", json.dumps(parsed))

def test_single_content_has_one_evidence_item_and_no_account_rankings(self):
    parsed = read_scrape_source("douyin", "content", self.video_json, self.video_xlsx)
    bundle = build_evidence_bundle(parsed, {"platformId": "douyin", "inputKind": "content"})
    self.assertEqual(len(bundle["items"]), 1)
    self.assertEqual(bundle["rankings"], {})
```

Run:

```bash
agents/competitor-insight/.venv/bin/python -m unittest \
  agents/competitor-insight/runtime/tests/test_source_reader.py \
  agents/competitor-insight/runtime/tests/test_analytics.py \
  agents/competitor-insight/runtime/tests/test_evidence_bundle.py -v
```

Expected: FAIL，因为 `source_reader.py` 和 v2 字段尚不存在。

- [ ] **Step 3: 实现平台无关 NormalizedSource**

```python
def read_scrape_source(
    platform_id: str,
    input_kind: str,
    data_path: Path,
    excel_path: Path | None,
) -> dict[str, object]:
    dispatch = {
        ("douyin", "account"): _read_douyin_account,
        ("douyin", "content"): _read_douyin_content,
        ("xiaohongshu", "account"): _read_xhs_account,
        ("xiaohongshu", "content"): _read_xhs_note,
    }
    try:
        return dispatch[(platform_id, input_kind)](data_path, excel_path)
    except KeyError:
        raise ValueError("unsupported_report_source") from None
```

账号 `items` 的统一字段是 `sourceRow/title/likes/comments/collects/shares/publishedAt/url`；缺失互动字段按 0 进入计算，同时写入 `missingFields`。单内容 `content` 只能保存已抓到的正文、转写、OCR、作者公开字段和素材计数，缺失项进入 `warnings`，不得生成替代文本。

- [ ] **Step 4: 实现证据合同 v2 和确定性规则**

```python
class EvidenceBundle(TypedDict):
    evidenceVersion: Literal["2.0"]
    evidenceId: str
    platformId: Literal["douyin", "xiaohongshu"]
    inputKind: Literal["account", "content"]
    reportType: Literal["douyin-account", "douyin-content", "xhs-account", "xhs-note"]
    subject: dict[str, object]
    completeness: dict[str, object]
    metrics: dict[str, int | float | None]
    rankings: dict[str, dict[str, object]]
    items: list[EvidenceItem]
    content: NotRequired[dict[str, object]]
```

账号继续严格执行综合互动量、Top 10、前 25%/不足 20 条最早 5 条、2 倍均值优先、高收藏/分享/评论和全部均值规则。证据 ID 由平台前缀和稳定顺序生成：`DY-E0001` 或 `XHS-E0001`；同一规范化输入生成相同 evidence session digest。

- [ ] **Step 5: 运行完整确定性测试并提交**

```bash
agents/competitor-insight/.venv/bin/python -m unittest \
  agents/competitor-insight/runtime/tests/test_metrics.py \
  agents/competitor-insight/runtime/tests/test_workbook_reader.py \
  agents/competitor-insight/runtime/tests/test_source_reader.py \
  agents/competitor-insight/runtime/tests/test_analytics.py \
  agents/competitor-insight/runtime/tests/test_evidence_bundle.py -v
```

Expected: PASS，并覆盖 `1.5w`、`1.5万`、空值、缺失时间和字段缺失。

```bash
git add agents/competitor-insight/runtime/contracts.py \
  agents/competitor-insight/runtime/source_reader.py \
  agents/competitor-insight/runtime/workbook_reader.py \
  agents/competitor-insight/runtime/analytics.py \
  agents/competitor-insight/runtime/evidence_bundle.py \
  agents/competitor-insight/runtime/tests/test_source_reader.py \
  agents/competitor-insight/runtime/tests/test_workbook_reader.py \
  agents/competitor-insight/runtime/tests/test_analytics.py \
  agents/competitor-insight/runtime/tests/test_evidence_bundle.py
git commit -m "feat: add cross-platform competitor evidence"
```

---

### Task 3: 扩展账号/单内容模型合同与证据型 Markdown 渲染

**Files:**
- Modify: `agents/competitor-insight/reporting/report-policy.md`
- Modify: `agents/competitor-insight/reporting/section-batch.schema.json`
- Modify: `app/lib/competitor-report-runtime.ts`
- Modify: `tests/competitor-report-runtime.test.mjs`
- Modify: `agents/competitor-insight/runtime/section_validator.py`
- Modify: `agents/competitor-insight/runtime/report_renderer.py`
- Modify: `agents/competitor-insight/runtime/tests/test_section_validator.py`
- Modify: `agents/competitor-insight/runtime/tests/test_report_renderer.py`

**Interfaces:**
- Consumes: `EvidenceBundleV2` 和由后端生成的 `batchInputs`。
- Produces: 账号三批 `strategy/performance/execution` 或单内容一批 `content`；最终 Markdown 只能由确定性 renderer 组装。
- `CompetitorBatchId = "strategy" | "performance" | "execution" | "content"`。

- [ ] **Step 1: 对报告生成和渲染做 HIGH 风险 impact 检查并报告**

```bash
node .gitnexus/run.cjs impact assemble_report --direction upstream --depth 4 --include-tests \
  --repo '/Users/lvyakun/Documents/AI综合工作台/.worktrees/fix-xhs-prod-verification' \
  --branch codex/link-only-competitor-bundles
node .gitnexus/run.cjs impact buildCompetitorBatchPrompt --direction upstream --depth 4 --include-tests \
  --repo '/Users/lvyakun/Documents/AI综合工作台/.worktrees/fix-xhs-prod-verification' \
  --branch codex/link-only-competitor-bundles
```

Expected: `assemble_report` 为 HIGH；实施前明确告诉用户受影响的是报告服务、桥接组装和对应测试，不影响其他 Agent。

- [ ] **Step 2: 写完整账号结构与单内容禁止项失败测试**

```python
def test_douyin_account_report_has_every_confirmed_heading_and_table(self):
    markdown = assemble_report(douyin_bundle(), valid_account_batches())
    for heading in (
        "## 账号概览",
        "## 一、战略层：账号定位与人设分析",
        "## 二、业务层：转化路径与商业价值分析",
        "### 3.1 Top 10 高表现作品",
        "### 3.2 起号期 Top 5 作品",
        "### 3.3 高收藏 / 高分享 / 高评论作品观察",
        "### 第一步：拍什么",
        "### 第二步：怎么拍",
        "### 第三步：怎么承接转化",
        "### 对标执行清单",
    ):
        self.assertIn(heading, markdown)

def test_single_note_report_never_renders_account_rankings(self):
    markdown = assemble_report(xhs_note_bundle(), valid_content_batch())
    self.assertNotIn("Top 10", markdown)
    self.assertNotIn("起号期", markdown)
    self.assertIn("# 小红书单篇笔记分析报告", markdown)
```

Run:

```bash
agents/competitor-insight/.venv/bin/python -m unittest \
  agents/competitor-insight/runtime/tests/test_section_validator.py \
  agents/competitor-insight/runtime/tests/test_report_renderer.py -v
npx tsx --test tests/competitor-report-runtime.test.mjs
```

Expected: FAIL，因为当前只接受三批和抖音账号标题。

- [ ] **Step 3: 扩展严格模型批次合同**

```ts
export type CompetitorBatchId =
  | "strategy"
  | "performance"
  | "execution"
  | "content";

const BATCH_CONTRACTS = {
  strategy: { sections: new Set(["strategy", "business", "content"]), topicCount: 0, filmingCount: 0, executionDayCount: 0 },
  performance: { sections: new Set(["traffic", "data"]), topicCount: 0, filmingCount: 0, executionDayCount: 0 },
  execution: { sections: new Set<string>(), topicCount: 5, filmingCount: 3, executionDayCount: 7 },
  content: {
    sections: new Set(["content-overview", "content-structure", "interaction", "conversion"]),
    topicCount: 3,
    filmingCount: 1,
    executionDayCount: 0,
  },
} as const;
```

系统提示不再硬编码 `DY-E`，改为“只能复制输入 `allowedEvidenceIds` 中的 ID”；账号 execution 仍要求 5/3/7，content 要求 3 个复用角度、1 个拍法、0 个执行日。所有模型文本继续经过数值泄露、证据 ID 和医疗合规校验。

- [ ] **Step 4: 实现平台/类型分派的确定性 renderer**

```python
def assemble_report(bundle: EvidenceBundle, batches: list[dict[str, object]]) -> str:
    if bundle["inputKind"] == "content":
        return _assemble_content_report(bundle, batches)
    return _assemble_account_report(bundle, batches)
```

账号 renderer 必须直接生成用户确认的完整表格列、数据摘要表、5 个选题方向字段、3 个拍法模板字段、A/B 转化判断和 7 天表格；所有作品数字从 bundle 注入。小红书账号把“作品/视频链接”替换为“笔记/笔记链接”。单内容 renderer 只输出内容概览、数据完整性、主题与钩子、互动结构、可复用角度、拍法、转化假设和合规边界。

- [ ] **Step 5: 加强终检并运行测试**

```python
def validate_final_report(markdown, bundle, batches):
    expected = assemble_report(bundle, batches)
    errors = [] if markdown == expected else ["report_content_mismatch"]
    errors.extend(_validate_expected_headings(markdown, bundle["reportType"]))
    errors.extend(_validate_evidence_sequence(markdown, bundle, batches))
    errors.extend(_validate_model_text_only(markdown, bundle))
    return sorted(set(errors))
```

Run:

```bash
agents/competitor-insight/.venv/bin/python -m unittest \
  agents/competitor-insight/runtime/tests/test_contracts.py \
  agents/competitor-insight/runtime/tests/test_section_validator.py \
  agents/competitor-insight/runtime/tests/test_report_renderer.py -v
npx tsx --test tests/competitor-report-runtime.test.mjs
```

Expected: PASS，且测试明确拒绝证据外评论正文、画面结构、商品/私域断言和数值重算。

- [ ] **Step 6: 提交报告合同**

```bash
git add agents/competitor-insight/reporting/report-policy.md \
  agents/competitor-insight/reporting/section-batch.schema.json \
  agents/competitor-insight/runtime/section_validator.py \
  agents/competitor-insight/runtime/report_renderer.py \
  agents/competitor-insight/runtime/tests/test_section_validator.py \
  agents/competitor-insight/runtime/tests/test_report_renderer.py \
  app/lib/competitor-report-runtime.ts tests/competitor-report-runtime.test.mjs
git commit -m "feat: render evidence-bound competitor reports"
```

---

### Task 4: 用受控抓取成果分析接口替换浏览器 Excel 上传

**Files:**
- Modify: `agents/competitor-insight/runtime/service.py`
- Modify: `agents/competitor-insight/runtime/bridge_server.py`
- Modify: `agents/competitor-insight/runtime/tests/test_service.py`
- Modify: `agents/competitor-insight/runtime/tests/test_bridge_server.py`
- Modify: `app/lib/competitor-report-client.ts`
- Modify: `tests/competitor-report-client.test.mjs`

**Interfaces:**
- Consumes: `POST /analyze-artifacts` 的任务级抓取路径。
- Produces: `EvidenceReadyResponse`，包含 `platformId/inputKind/reportType/outputDir/subjectName/itemCount/batchInputs`。
- 移除: 浏览器 `analyzeReportUpload(file)` 与公开 `POST /analyze-upload`。

- [ ] **Step 1: 对 service 和 bridge 分派做 impact 检查**

```bash
node .gitnexus/run.cjs impact analyze_path --direction upstream --depth 4 --include-tests \
  --repo '/Users/lvyakun/Documents/AI综合工作台/.worktrees/fix-xhs-prod-verification' \
  --branch codex/link-only-competitor-bundles
node .gitnexus/run.cjs impact _dispatch -f agents/competitor-insight/runtime/bridge_server.py \
  --direction upstream --depth 4 --include-tests \
  --repo '/Users/lvyakun/Documents/AI综合工作台/.worktrees/fix-xhs-prod-verification' \
  --branch codex/link-only-competitor-bundles
```

- [ ] **Step 2: 写新接口和上传 404 的失败测试**

```python
def test_analyze_artifacts_rejects_cross_task_paths(self):
    with self.assertRaisesRegex(ValueError, "path_not_allowed"):
        service.analyze_artifacts({
            "taskId": "competitor-20260801-a1",
            "platformId": "douyin",
            "inputKind": "account",
            "outputDir": str(self.douyin_root / "another-task"),
            "dataPath": str(self.douyin_root / "another-task" / "结构化数据.json"),
            "excelPath": str(self.douyin_root / "another-task" / "账号.xlsx"),
        })

def test_analyze_upload_is_not_a_route(self):
    status, _headers, body = self._post_json("/analyze-upload", {})
    self.assertEqual(status, 404)
    self.assertEqual(json.loads(body)["error"], "NOT_FOUND")
```

Run:

```bash
agents/competitor-insight/.venv/bin/python -m unittest \
  agents/competitor-insight/runtime/tests/test_service.py \
  agents/competitor-insight/runtime/tests/test_bridge_server.py -v
npx tsx --test tests/competitor-report-client.test.mjs
```

Expected: FAIL，因为 `/analyze-artifacts` 尚不存在且上传路由仍可用。

- [ ] **Step 3: 实现任务级路径验证与证据落盘**

```python
def analyze_artifacts(payload: dict[str, object]) -> dict[str, object]:
    request = _validate_analysis_request(payload)
    parsed = read_scrape_source(
        request.platform_id,
        request.input_kind,
        request.data_path,
        request.excel_path,
    )
    bundle = build_evidence_bundle(parsed, request.source_metadata())
    evidence_path = write_evidence_bundle(bundle, request.output_dir)
    return _evidence_ready(bundle, evidence_path, request.output_dir)
```

`_validate_analysis_request` 必须保证 outputDir 精确等于 `outputs/competitor-insight/<platform>/<taskId>`，所有输入路径均为该目录内普通文件，拒绝符号链接、越界、类型不匹配和超限 JSON/XLSX。证据包保存到同一任务目录；`service.assemble` 从 evidence session 读取该 outputDir，并把最终 Markdown 写回同一目录，禁止浏览器另传报告输出路径。`_batch_inputs` 给每一批附带同一份 `allowedEvidenceIds`；只有 strategy 批包含账号身份字段，单内容 content 批只包含当前内容和作者公开字段。

- [ ] **Step 4: 修改桥和 TypeScript 客户端**

```ts
export type AnalyzeScrapeArtifactsInput = {
  taskId: string;
  platformId: "douyin" | "xiaohongshu";
  inputKind: "account" | "content";
  outputDir: string;
  dataPath: string;
  excelPath: string | null;
};

export function analyzeScrapeArtifacts(
  input: AnalyzeScrapeArtifactsInput,
  signal?: AbortSignal,
): Promise<EvidenceReadyResponse>;
```

删除 `analyzeReportUpload`、`encodeBase64`、浏览器文件大小常量和 `/analyze-upload` 白名单；保留 `/analyze-path` 仅供内部兼容测试，不在前端导出调用。

- [ ] **Step 5: 运行接口测试并提交**

```bash
agents/competitor-insight/.venv/bin/python -m unittest \
  agents/competitor-insight/runtime/tests/test_service.py \
  agents/competitor-insight/runtime/tests/test_bridge_server.py -v
npx tsx --test tests/competitor-report-client.test.mjs
```

Expected: PASS；对允许 Origin 的 `/analyze-upload` 也返回 404。

```bash
git add agents/competitor-insight/runtime/service.py \
  agents/competitor-insight/runtime/bridge_server.py \
  agents/competitor-insight/runtime/tests/test_service.py \
  agents/competitor-insight/runtime/tests/test_bridge_server.py \
  app/lib/competitor-report-client.ts tests/competitor-report-client.test.mjs
git commit -m "feat: analyze controlled scraper artifacts"
```

---

### Task 5: 升级本地记录 schema v2 并实现安全成果包

**Files:**
- Modify: `agents/competitor-insight/runtime/project_records.py`
- Modify: `agents/competitor-insight/runtime/tests/test_project_records.py`

**Interfaces:**
- Consumes: 运行中任务、任务级 outputDir、主报告路径、subjectName、itemCount。
- Produces: `finalize_bundle(task_id, payload) -> snapshot`、`read_bundle(bundle_id)`、`bundle_archive(bundle_id)`、`reveal_bundle(bundle_id)`。
- 持久化根结构：`{"schemaVersion":2,"tasks":[],"artifacts":[],"bundles":[]}`。
- 任务新增字段：`inputKind: "unknown" | "account" | "content"`、`category: null | CompetitorBundleCategory`、`bundleId: null | string`；只允许分类从 unknown 解析一次，完成时写入 bundleId。

- [ ] **Step 1: 对 `register_artifacts` 做 impact 检查**

```bash
node .gitnexus/run.cjs impact register_artifacts --direction upstream --depth 4 --include-tests \
  --repo '/Users/lvyakun/Documents/AI综合工作台/.worktrees/fix-xhs-prod-verification' \
  --branch codex/link-only-competitor-bundles
```

- [ ] **Step 2: 写 v1 迁移、单 bundle 和安全 ZIP 失败测试**

```python
def test_v1_completed_task_migrates_to_one_legacy_bundle_without_moving_files(self):
    original_paths = self.write_v1_store_with_three_artifacts()
    snapshot = project_records.read_records("competitor-insight")
    self.assertEqual(len(snapshot["bundles"]), 1)
    self.assertEqual(snapshot["bundles"][0]["status"], "legacy")
    self.assertTrue(all(path.exists() for path in original_paths))

def test_finalize_bundle_is_atomic_and_completes_task_only_after_zip(self):
    snapshot = project_records.finalize_bundle(self.task_id, self.bundle_payload())
    self.assertEqual(snapshot["tasks"][0]["status"], "completed")
    self.assertEqual(len(snapshot["bundles"]), 1)
    self.assertTrue(Path(snapshot["bundles"][0]["archivePath"]).is_file())

def test_task_classification_can_only_resolve_unknown_once(self):
    task = project_records.update_task(self.task_id, {
        "inputKind": "account",
        "category": "xhs-account",
    })
    self.assertEqual(task["inputKind"], "account")
    with self.assertRaisesRegex(ValueError, "invalid_task_classification"):
        project_records.update_task(self.task_id, {
            "inputKind": "content",
            "category": "xhs-note",
        })

def test_zip_excludes_sensitive_symlink_and_unregistered_files(self):
    with zipfile.ZipFile(project_records.bundle_archive(self.bundle_id)) as archive:
        names = set(archive.namelist())
    self.assertNotIn("douyin_state.json", names)
    self.assertFalse(any(name.startswith("/") or ".." in Path(name).parts for name in names))
```

Run:

```bash
agents/competitor-insight/.venv/bin/python -m unittest \
  agents/competitor-insight/runtime/tests/test_project_records.py -v
```

Expected: FAIL，因为 store 仍是 v1 且没有 bundles。

- [ ] **Step 3: 实现 v1 到 v2 原子迁移**

```python
def _migrate_v1(store: dict[str, object]) -> dict[str, object]:
    migrated = {
        "schemaVersion": 2,
        "tasks": [dict(task) for task in cast(list[dict[str, object]], store["tasks"])],
        "artifacts": [dict(item) for item in cast(list[dict[str, object]], store["artifacts"])],
        "bundles": [],
    }
    for task in migrated["tasks"]:
        _append_legacy_bundle(migrated, task)
    return migrated
```

迁移只在锁内执行并通过现有 `_atomic_write` 落盘；损坏 v1 继续抛 `record_store_damaged`，不替换成空 v2。历史主报告优先选择 Markdown，找不到时 bundle 标记 `missing`。

新任务创建时把前端 hint 持久化为 `unknown/account/content`；authoritative Skill 响应通过同一个 PATCH 同时写入 inputKind 和 category。后端校验平台/分类组合，拒绝 `douyin + xhs-note`、只写其中一个字段或对已解析分类二次改写。

- [ ] **Step 4: 实现 manifest、ZIP 和 bundle 原子完成**

```python
def finalize_bundle(task_id: str, payload: dict[str, object]) -> dict[str, object]:
    request = _validate_bundle_request(task_id, payload)
    discovered = _discover_bundle_files(request.output_dir, request.explicit_paths)
    primary = _require_primary_markdown(discovered, request.primary_report_path)
    manifest_path = _write_manifest_exclusive(request, discovered, primary)
    archive_path = _write_archive_exclusive(request, discovered + [manifest_path])
    with _STORE_LOCK:
        store = _load_store()
        _commit_ready_bundle(store, request, primary, manifest_path, archive_path)
        _atomic_write(store)
        return _snapshot(store, AGENT_ID)
```

manifest 每个成员记录安全相对路径、大小和 SHA-256；ZIP 只包含 manifest 白名单里的普通文件，排除自身、`.workbench`、Cookie/state/profile、符号链接和解析后越界文件。新 bundle ID 固定为 `bundle-<16 hex>`，同一任务重复 finalize 返回既有 ready bundle，不创建第二张卡片。

- [ ] **Step 5: 实现 bundle 查询、延迟旧 ZIP 和访达定位**

```python
def bundle_archive(bundle_id: str) -> Path:
    bundle = _find_bundle(_load_store(), _bundle_id(bundle_id))
    if bundle["status"] == "legacy" and not _archive_exists(bundle):
        _materialize_legacy_archive(bundle)
    return _validate_existing_path(bundle["archivePath"])
```

`reveal_bundle` 只接收持久化 bundle ID，使用 `open -- <rootDirectory>` 参数数组；子文件缺失时 `_snapshot` 把 bundle 标记 `missing`，不删除历史记录。

- [ ] **Step 6: 运行持久化测试并提交**

```bash
agents/competitor-insight/.venv/bin/python -m unittest \
  agents/competitor-insight/runtime/tests/test_project_records.py -v
```

Expected: PASS，包括迁移失败保留原文件、同任务幂等和 ZIP 安全测试。

```bash
git add agents/competitor-insight/runtime/project_records.py \
  agents/competitor-insight/runtime/tests/test_project_records.py
git commit -m "feat: persist competitor result bundles"
```

---

### Task 6: 暴露成果包 HTTP API 与严格前端类型

**Files:**
- Modify: `agents/competitor-insight/runtime/bridge_server.py`
- Modify: `agents/competitor-insight/runtime/tests/test_bridge_server.py`
- Modify: `app/lib/agent-project-records.d.mts`
- Modify: `app/lib/agent-project-records.mjs`
- Modify: `tests/agent-project-records.test.mjs`
- Modify: `app/lib/competitor-project-records-client.ts`
- Modify: `tests/competitor-project-records-client.test.mjs`

**Interfaces:**
- Produces HTTP: `POST /project-tasks/{taskId}/bundle`、`GET /project-bundles/{bundleId}`、`GET /project-bundles/{bundleId}/download`、`POST /project-bundles/{bundleId}/reveal`。
- Produces TS: `ProjectBundle`、`finalizeCompetitorBundle`、`loadCompetitorBundleDetail`、`downloadCompetitorBundle`、`revealCompetitorBundle`。

- [ ] **Step 1: 写桥、类型解析和查询失败测试**

```js
test("parses one bundle with child artifact ids", async () => {
  globalThis.fetch = async () => jsonResponse({
    ok: true,
    tasks: [TASK_FIXTURE],
    bundles: [BUNDLE_FIXTURE],
    artifacts: [REPORT_ARTIFACT, EXCEL_ARTIFACT],
  });
  const snapshot = await loadCompetitorProjectRecords();
  assert.equal(snapshot.bundles[0].category, "xhs-account");
  assert.deepEqual(snapshot.bundles[0].artifactIds, [REPORT_ARTIFACT.id, EXCEL_ARTIFACT.id]);
});
```

```python
def test_bundle_download_returns_zip_not_json(self):
    status, headers, body = self._request(
        "GET", f"/project-bundles/{self.bundle_id}/download",
        headers={"Origin": "http://localhost:3000"},
    )
    self.assertEqual(status, 200)
    self.assertEqual(headers["content-type"], "application/zip")
    self.assertTrue(body.startswith(b"PK"))
```

Run:

```bash
agents/competitor-insight/.venv/bin/python -m unittest \
  agents/competitor-insight/runtime/tests/test_bridge_server.py -v
npx tsx --test tests/agent-project-records.test.mjs \
  tests/competitor-project-records-client.test.mjs
```

Expected: FAIL，因为 API 和 bundle 类型尚不存在。

- [ ] **Step 2: 定义 bundle 类型和纯查询函数**

```ts
import type { CompetitorBundleCategory } from "./competitor-platform-router.mjs";

export type ProjectBundleStatus = "ready" | "missing" | "legacy";
export type ProjectBundleCategory = CompetitorBundleCategory;

export type ProjectBundle = {
  id: string;
  agentId: string;
  taskId: string;
  platformId: string;
  platformLabel: string;
  inputKind: "account" | "content";
  category: ProjectBundleCategory;
  title: string;
  subjectName: string;
  sourceUrl: string;
  status: ProjectBundleStatus;
  primaryArtifactId: string | null;
  manifestPath: string | null;
  archivePath: string | null;
  rootDirectory: string;
  artifactIds: readonly string[];
  itemCount: number;
  createdAt: string;
  completedAt: string;
};
```

同时扩展 `ProjectTask` 的 `inputKind/category/bundleId` 类型。新增 `mergeProjectBundles`、`getAgentBundles`、`getTaskBundle` 和 `getBundleArtifacts`；只返回任务关系一致的 bundle，排序按 completedAt 倒序。

- [ ] **Step 3: 实现桥路由和二进制响应**

```python
BUNDLE_PATH = re.compile(r"^/project-bundles/(?P<bundle_id>bundle-[0-9a-f]{16})$")
BUNDLE_DOWNLOAD_PATH = re.compile(r"^/project-bundles/(?P<bundle_id>bundle-[0-9a-f]{16})/download$")
BUNDLE_REVEAL_PATH = re.compile(r"^/project-bundles/(?P<bundle_id>bundle-[0-9a-f]{16})/reveal$")
```

下载响应设置 `Content-Type: application/zip`、安全 `Content-Disposition`、`Content-Length`、`Cache-Control: no-store` 和精确 CORS；不接受 URL 文件路径。bundle detail 的 Markdown 预览沿用 2 MB 上限，超限只返回 `markdown: null` 与 `previewable: false`。

- [ ] **Step 4: 实现严格前端客户端**

```ts
export async function finalizeCompetitorBundle(
  taskId: string,
  input: FinalizeCompetitorBundleInput,
  signal?: AbortSignal,
): Promise<{snapshot: CompetitorProjectSnapshot; bundle: ProjectBundle}>;

export async function downloadCompetitorBundle(
  bundleId: string,
  signal?: AbortSignal,
): Promise<{filename: string; blob: Blob}>;
```

ZIP 下载验证 `content-type`、`content-length <= 512 MiB` 和 `PK` 文件头；服务端错误只映射稳定错误码，不显示响应正文。

- [ ] **Step 5: 运行 API 测试并提交**

```bash
agents/competitor-insight/.venv/bin/python -m unittest \
  agents/competitor-insight/runtime/tests/test_bridge_server.py -v
npx tsx --test tests/agent-project-records.test.mjs \
  tests/competitor-project-records-client.test.mjs
```

Expected: PASS，且恶意 Origin、非法 bundle ID、缺失 ZIP 和任意路径下载均失败。

```bash
git add agents/competitor-insight/runtime/bridge_server.py \
  agents/competitor-insight/runtime/tests/test_bridge_server.py \
  app/lib/agent-project-records.mjs app/lib/agent-project-records.d.mts \
  app/lib/competitor-project-records-client.ts \
  tests/agent-project-records.test.mjs \
  tests/competitor-project-records-client.test.mjs
git commit -m "feat: expose competitor bundle APIs"
```

---

### Task 7: 把竞品采集页收口为单链接五阶段流程

**Files:**
- Modify: `app/components/CompetitorReportRunner.tsx`
- Modify: `app/components/CompetitorInsightPanel.tsx`
- Modify: `app/globals.css`
- Modify: `tests/workbench-ui.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `scrapeCompetitorLink`、Task 4 的 `analyzeScrapeArtifacts`、Task 6 的 `finalizeCompetitorBundle`。
- Produces: `onTaskCompleted(taskId, bundleId)`，只在 ready bundle 返回后触发。
- `CompetitorAnalysisRequest` 替代 `CompetitorReportPathRequest`。

- [ ] **Step 1: 对两个 HIGH 风险组件做 impact 检查并报告**

```bash
node .gitnexus/run.cjs impact CompetitorReportRunner --direction upstream --depth 4 --include-tests \
  --repo '/Users/lvyakun/Documents/AI综合工作台/.worktrees/fix-xhs-prod-verification' \
  --branch codex/link-only-competitor-bundles
node .gitnexus/run.cjs impact CompetitorInsightPanel --direction upstream --depth 4 --include-tests \
  --repo '/Users/lvyakun/Documents/AI综合工作台/.worktrees/fix-xhs-prod-verification' \
  --branch codex/link-only-competitor-bundles
```

- [ ] **Step 2: 删除旧上传测试并写单入口/五阶段失败测试**

删除以“竞品洞察报告显示双入口且拒绝非 xlsx 文件而不请求服务”“新选文件校验失败会隔离旧证据和旧报告”“新选超限 Excel 会清理旧证据且不暴露重试”为目标的测试；把后续模型中止/重试测试的触发入口改为 `CompetitorAnalysisRequest` harness。

```tsx
test("竞品洞察只有链接入口且完整成功显示五阶段", async () => {
  await openCompetitorReportRunner();
  assert.equal(screen.queryByLabelText("选择已有 Excel 文件"), null);
  assert.equal(screen.queryByText("分析已有 Excel"), null);
  assert.ok(screen.getByRole("button", {name: "抓取并分析"}));
  assert.equal(screen.getAllByRole("listitem").filter((item) => /（/.test(item.getAttribute("aria-label") ?? "")).length, 5);
});

test("模型未配置时任务停在报告阶段且不封装成果包", async () => {
  await runAccountLinkWithoutModel();
  assert.match(screen.getByRole("status", {name: "竞品分析进度"}).textContent ?? "", /证据包已生成，等待配置模型/);
  assert.equal(fetchCalls.some((call) => call.url.endsWith("/bundle")), false);
});
```

Run:

```bash
npx tsx --test --test-name-pattern "竞品洞察|竞品抓取|竞品报告" tests/workbench-ui.test.tsx
```

Expected: FAIL，旧第二入口仍存在且流程还是两套进度。

- [ ] **Step 3: 把 ReportRunner 改为任务报告控制器**

```ts
export type CompetitorAnalysisRequest = {
  requestId: number;
  taskId: string;
  platformId: "douyin" | "xiaohongshu";
  inputKind: "account" | "content";
  outputDir: string;
  dataPath: string;
  excelPath: string | null;
};
```

删除 `ChangeEvent`、`MAX_EXCEL_BYTES`、`selectExcel`、`failFileSelection`、上传 heading/file input 和页面内 Markdown 下载预览。保留模型配置变化中止、停止生成、证据暂停、单批自动重试一次和安全错误文案；根据 evidence.inputKind 使用三批或 content 一批，并通过 `onStageChange(stage,message)` 把状态交给父组件。

- [ ] **Step 4: 实现父组件唯一五阶段状态机**

```ts
const WORKFLOW = [
  "识别平台",
  "调用抓取 Skill",
  "整理账号数据",
  "生成洞察报告",
  "整理成果包",
] as const;

type AnalysisPhase =
  | "idle" | "connecting" | "scraping" | "normalizing"
  | "generating" | "bundling" | "completed" | "failed";
```

submit 顺序固定为：create task → scraper health/scrape → PATCH authoritative inputKind/category → analyze artifacts → model batches → register internal artifacts → finalize bundle。`finalizeCompetitorBundle` 返回 ready bundle 后才调用 `onTaskCompleted`；ZIP/manifest/报告任一失败时 PATCH failed，不自动跳转。

- [ ] **Step 5: 更新样式并运行 UI 定向测试**

删除 `.competitor-upload-button` 和第二入口布局；保留证据摘要、停止/重试和错误状态。五阶段在窄屏按现有媒体查询换行，不横向溢出。

```bash
npx tsx --test --test-name-pattern "竞品洞察|竞品抓取|竞品报告" tests/workbench-ui.test.tsx
npm run typecheck
```

Expected: PASS；DOM 中不存在 file input、`第二入口`、`分析已有 Excel` 或 `50 MB`。

- [ ] **Step 6: 提交单入口流程**

```bash
git add app/components/CompetitorReportRunner.tsx \
  app/components/CompetitorInsightPanel.tsx app/globals.css \
  tests/workbench-ui.test.tsx
git commit -m "feat: run competitor analysis from links only"
```

---

### Task 8: 用分类成果包替换竞品逐文件列表并完成自动聚焦

**Files:**
- Create: `app/components/CompetitorResultBundles.tsx`
- Modify: `app/components/AgentResultFiles.tsx`
- Modify: `app/components/AgentWorkspace.tsx`
- Modify: `app/globals.css`
- Modify: `tests/workbench-ui.test.tsx`

**Interfaces:**
- Consumes: `ProjectBundle[]`、子 `ProjectResult[]`、Task 6 bundle 客户端。
- Produces: 分类筛选、每任务一张卡片、主报告预览、折叠明细、ZIP 下载、访达定位、`initialTaskId` 聚焦。

- [ ] **Step 1: 对 HIGH 风险成果组件做 impact 检查并报告**

```bash
node .gitnexus/run.cjs impact AgentResultFiles --direction upstream --depth 4 --include-tests \
  --repo '/Users/lvyakun/Documents/AI综合工作台/.worktrees/fix-xhs-prod-verification' \
  --branch codex/link-only-competitor-bundles
node .gitnexus/run.cjs impact AgentWorkspace --direction upstream --depth 4 --include-tests \
  --repo '/Users/lvyakun/Documents/AI综合工作台/.worktrees/fix-xhs-prod-verification' \
  --branch codex/link-only-competitor-bundles
```

- [ ] **Step 2: 写单卡片、分类和自动聚焦失败测试**

```tsx
test("竞品成果按任务显示一张成果包卡片并默认收起子文件", async () => {
  renderCompetitorBundles({bundles: [bundle], artifacts: [report, excel, json]});
  assert.equal(screen.getAllByRole("article", {name: /成果包/}).length, 1);
  assert.equal(screen.queryByText("原始数据.xlsx"), null);
  await user.click(screen.getByRole("button", {name: "展开明细"}));
  assert.ok(screen.getByText("原始数据.xlsx"));
});

test("自动完成只聚焦本次 bundle 且可恢复全部成果", async () => {
  await completeCompetitorTask();
  assert.ok(screen.getByText("正在查看本次成果"));
  assert.equal(screen.queryByText("历史账号成果包"), null);
  await user.click(screen.getByRole("button", {name: "查看全部成果"}));
  assert.ok(screen.getByText("历史账号成果包"));
});
```

Run:

```bash
npx tsx --test --test-name-pattern "成果包|成果文件|自动切换" tests/workbench-ui.test.tsx
```

Expected: FAIL，因为当前每个 artifact 都是一张顶层卡片。

- [ ] **Step 3: 实现 `CompetitorResultBundles`**

```tsx
const CATEGORIES = [
  ["all", "全部成果"],
  ["douyin-account", "抖音账号"],
  ["douyin-content", "抖音作品"],
  ["xhs-account", "小红书账号"],
  ["xhs-note", "小红书笔记"],
] as const;
```

卡片显示名称、平台分类、subject、脱敏 source URL、账号作品数、生成时间、主报告名和完整性；操作固定为“查看分析报告”“下载成果包”“在访达中显示”“展开明细”。只有点击查看时才请求 bundle detail；只有点击下载时才获取 ZIP Blob 并在 finally 中撤销 object URL。

- [ ] **Step 4: 让 Workspace 使用 bundles 作为完成条件**

```ts
const [competitorRecords, setCompetitorRecords] = useState<CompetitorProjectSnapshot>({
  tasks: [],
  bundles: [],
  results: [],
});

const openCompletedCompetitorTask = useCallback(async (taskId: string) => {
  const snapshot = await refreshCompetitorRecords();
  const task = snapshot.tasks.find((item) => item.id === taskId);
  const bundle = snapshot.bundles.find((item) => item.taskId === taskId);
  if (task?.status !== "completed" || bundle?.status !== "ready" || !bundle.primaryArtifactId) return;
  setResultTaskId(taskId);
  setActiveTab("成果文件");
}, [refreshCompetitorRecords]);
```

竞品成果标签渲染 `CompetitorResultBundles`；其他 Agent 继续渲染 `AgentResultFiles`。从 `AgentResultFiles` 删除竞品逐 artifact 分支，不改变非竞品 Markdown 预览。

- [ ] **Step 5: 运行 UI 和非竞品回归测试**

```bash
npx tsx --test --test-name-pattern "成果包|成果文件|Markdown 成果|自动切换" tests/workbench-ui.test.tsx
npm run typecheck
```

Expected: PASS；内容矩阵 Markdown 成果预览测试保持通过。

- [ ] **Step 6: 提交成果包界面**

```bash
git add app/components/CompetitorResultBundles.tsx \
  app/components/AgentResultFiles.tsx app/components/AgentWorkspace.tsx \
  app/globals.css tests/workbench-ui.test.tsx
git commit -m "feat: group competitor outputs into bundles"
```

---

### Task 9: 全链路回归、长期进度同步与发布前检查

**Files:**
- Modify: `docs/project-progress/00-项目进度总览.md`
- Create: `docs/project-progress/2026-08-01-竞品单链接成果包里程碑.md`
- Modify: `/Users/lvyakun/Desktop/吕亚坤笔记库/codex 仓库/Codex产出/AI综合工作台/00-项目进度总览.md`
- Create: `/Users/lvyakun/Desktop/吕亚坤笔记库/codex 仓库/Codex产出/AI综合工作台/2026-08-01-竞品单链接成果包里程碑.md`

**Interfaces:**
- Consumes: Tasks 1–8 的已提交功能。
- Produces: 全量自动化验证结果、项目/Obsidian 同步和可发布分支；本任务不自动发布 Sites。

- [ ] **Step 1: 运行全部 Python 测试**

```bash
agents/competitor-insight/.venv/bin/python -m unittest discover \
  -s agents/competitor-insight/runtime/tests -p 'test_*.py' -v
/Users/lvyakun/.codex/skills/douyin-scraper/.venv/bin/python -m unittest \
  /Users/lvyakun/.codex/skills/douyin-scraper/tests/test_bridge_contract.py -v
/Users/lvyakun/.codex/skills/xiaohongshu-scraper/.venv/bin/python -m unittest \
  /Users/lvyakun/.codex/skills/xiaohongshu-scraper/tests/test_bridge_cors.py -v
```

Expected: 全部 PASS；失败时只修本计划相关回归，并重新运行对应定向测试后再跑全量。

- [ ] **Step 2: 运行前端完整验证**

```bash
npm run typecheck
npm run lint
npm test
```

Expected: 三条命令均退出 0；现有非竞品失败必须与本次变更分开记录，不得误报为本功能通过。

- [ ] **Step 3: 做本地四路合同烟测但不抓取真实账号**

```bash
curl -sS http://127.0.0.1:8765/health
curl -sS http://127.0.0.1:8766/health
curl -sS http://127.0.0.1:8768/health
```

Expected: 三个服务分别返回 `douyin-scraper`、`xiaohongshu-scraper`、`competitor-insight-report` 身份。真实平台抓取只在用户再次授权公开链接和当前登录态后执行；不读取或导出 Cookie。

- [ ] **Step 4: 更新项目进度和 Obsidian 镜像**

里程碑文档必须分别写清：已完成（单入口、四路分析合同、成果包、迁移、自动跳转、自动测试）、进行中（真实账号业务验收）、尚未完成（Sites 正式发布，若尚未执行）。不得写入 API Key、Token、Cookie、未脱敏链接或真实后台数据。

- [ ] **Step 5: 检查变更范围并提交文档**

```bash
node .gitnexus/run.cjs detect-changes --scope compare --base-ref origin/main \
  --repo '/Users/lvyakun/Documents/AI综合工作台/.worktrees/fix-xhs-prod-verification' \
  --branch codex/link-only-competitor-bundles
git diff --check
git status --short
```

Expected: 变更只覆盖竞品洞察、共享类型的必要扩展、测试和进度文档；若检测到其他 Agent 的执行流变化，先修正再提交。

```bash
git add docs/project-progress/00-项目进度总览.md \
  docs/project-progress/2026-08-01-竞品单链接成果包里程碑.md
git commit -m "docs: record competitor bundle milestone"
git push -u origin codex/link-only-competitor-bundles
```

- [ ] **Step 6: 形成发布决策点**

向用户交付：测试总数与结果、真实抓取是否执行、分支/提交、未完成风险和现有 Sites 是否仍是旧版。只有用户明确确认“发布”后，才调用 Sites 发布流程并在发布成功后再次更新项目总览和 Obsidian 线上状态。

---

## Acceptance Mapping

| 设计验收项 | 实施任务 |
|---|---|
| 只有链接入口、删除 Excel 上传 | Task 4、Task 7 |
| 抖音/小红书账号与单内容四类路由 | Task 1、Task 2 |
| 确定性 Top 10、起号期和指标 | Task 2 |
| 完整证据型账号报告 | Task 3 |
| 单内容不冒充账号 | Task 2、Task 3 |
| 一任务一成果包、子文件折叠 | Task 5、Task 8 |
| 主报告预览、ZIP、访达定位 | Task 5、Task 6、Task 8 |
| 成果分类 | Task 6、Task 8 |
| ready 后自动跳转并聚焦 | Task 7、Task 8 |
| v1 历史无损迁移 | Task 5 |
| 长期本机保留 | Task 5、Task 6 |
| 其他 Agent 不受影响 | Task 8、Task 9 |
| 安全、隐私和医疗合规 | Task 1–6、Task 9 |
