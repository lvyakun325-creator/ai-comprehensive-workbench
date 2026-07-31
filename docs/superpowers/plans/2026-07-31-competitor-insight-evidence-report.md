# 竞品洞察 Agent 证据型账号报告实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为竞品洞察 Agent 增加“抖音抓取后自动分析”和“已有 Excel 直接分析”双入口，使用确定性数据计算、结构化模型洞察和确定性 Markdown 渲染生成可追溯的账号分析报告。

**Architecture:** 项目内 Python 报告运行时负责 Excel 解析、证据计算、章节校验、Markdown 组装和受控文件保存；浏览器端使用竞品洞察 Agent 已选择的模型分三批生成结构化章节 JSON，模型不接触最终数字。现有 `douyin-scraper` 只补充精确 `excel_path` 输出契约，不承担报告生成。

**Tech Stack:** Python 3.13、openpyxl 3.1.x、Python `unittest`、React 19、TypeScript 5.9、Vinext/Next、Node test runner、Testing Library、JSDOM、本机 `ThreadingHTTPServer`。

## Global Constraints

- 首期只分析抖音账号 Excel；小红书继续使用现有抓取路由，不复用抖音字段或报告模板。
- Python 报告桥固定监听 `127.0.0.1:8768`，只允许 `http://localhost:3000` 与 `http://127.0.0.1:3000`；`8767` 保留给已占用的无关服务。
- Excel 上传上限固定为 50 MB，只接受 `.xlsx` 扩展名和有效 ZIP/XLSX 文件签名。
- 路径分析只接受 `outputs/competitor-insight/douyin/` 下的普通 `.xlsx` 文件，拒绝路径穿越和符号链接逃逸。
- 原始 Excel 永不改写；上传副本在证据包生成后删除。
- 综合互动量固定为 `点赞 + 评论 + 收藏 + 分享`。
- 缺失互动字段按 0 计算并记录缺口；缺失发布时间的作品不参加起号期筛选。
- 起号期作品数不少于 20 时取 `ceil(总作品数 × 25%)`，不足 20 时取最早 5 条。
- 榜单并列时依次按目标指标降序、发布时间降序、Excel 原始行号升序。
- 必须分别生成高收藏 Top 5、高分享 Top 5 和高评论 Top 5；对应字段整体缺失时停止该榜单并明确说明无法判断。
- 模型只返回结构化章节 JSON，不返回最终 Markdown，不得提供或修改证据数字。
- API Key 不得进入 Python、报告桥、Excel、证据包、Markdown、日志或测试快照。
- 医药健康结论不得形成诊断、疗效承诺、停换药建议、绝对化表达或虚假权威背书。
- 不读取、导出或展示抖音 Cookie；自动化测试不得发起真实平台抓取或真实模型请求。
- 当前工作树已有竞品洞察基础能力和用户本机文件；每次只暂存任务列出的精确路径，禁止 `git add .`。
- 修改任何既有函数前先执行 GitNexus `impact --direction upstream`；HIGH 或 CRITICAL 必须先向用户报告。
- 每次代码提交前运行 `node .gitnexus/run.cjs detect-changes --scope all`，最终再运行全量检测。

---

## File Structure

### Create

- `agents/competitor-insight/reporting/report-policy.md`
  - 保存从用户 656 行提示词整理出的固定报告规则和证据约束。
- `agents/competitor-insight/reporting/section-batch.schema.json`
  - 模型三批结构化输出的 JSON Schema。
- `agents/competitor-insight/skills/evidence-report/SKILL.md`
  - Agent 调用证据型报告能力的正式说明。
- `agents/competitor-insight/runtime/requirements.txt`
  - 仅声明 `openpyxl>=3.1,<4`。
- `agents/competitor-insight/runtime/contracts.py`
  - 证据包、字段映射、排行榜、章节批次和报告结果的数据契约。
- `agents/competitor-insight/runtime/metrics.py`
  - 互动数字和发布时间的纯函数清洗。
- `agents/competitor-insight/runtime/workbook_reader.py`
  - 工作表识别、账号信息读取、作品字段语义匹配。
- `agents/competitor-insight/runtime/analytics.py`
  - Top 10、起号期、三类互动榜单和汇总指标。
- `agents/competitor-insight/runtime/evidence_bundle.py`
  - 生成稳定证据编号、数据完整性摘要和 JSON 证据包。
- `agents/competitor-insight/runtime/section_validator.py`
  - 校验模型结构化章节、证据引用、推断等级和数量要求。
- `agents/competitor-insight/runtime/report_renderer.py`
  - 确定性渲染固定表格、证据详情和最终 Markdown。
- `agents/competitor-insight/runtime/service.py`
  - 受控路径、上传临时文件、证据会话和报告保存服务。
- `agents/competitor-insight/runtime/bridge_server.py`
  - 本机 HTTP 端点和 CORS/请求大小边界。
- `agents/competitor-insight/runtime/tests/`
  - Python 单元和服务安全测试。
- `app/lib/competitor-report-client.ts`
  - 浏览器到 `127.0.0.1:8768` 的类型安全客户端。
- `app/lib/competitor-report-runtime.ts`
  - 三批模型提示、结构化响应解析、取消和安全错误。
- `app/api/agents/competitor-insight/route.ts`
  - 受控服务端代理模型调用。
- `app/components/CompetitorReportRunner.tsx`
  - 双入口、阶段状态、模型调度、重试、预览和下载。
- `tests/competitor-report-runtime.test.mjs`
  - 模型输入、响应、取消、密钥和大小边界测试。
- `tests/competitor-report-route.test.mjs`
  - 服务端代理安全测试。

### Modify

- `/Users/lvyakun/.codex/skills/douyin-scraper/main.py`
  - 账号模式先生成 Excel，再输出带绝对 `excel_path` 的成功 JSON。
- `/Users/lvyakun/.codex/skills/douyin-scraper/bridge_server.py`
  - 将 `excelPath`、`inputType` 提升到桥响应顶层。
- `/Users/lvyakun/.codex/skills/douyin-scraper/SKILL.md`
  - 记录账号抓取返回精确 Excel 路径的契约。
- `agents/competitor-insight/agent.json`
  - 注册 `skills/evidence-report/SKILL.md`。
- `.gitignore`
  - 忽略 `agents/competitor-insight/.venv/` 和报告运行时缓存。
- `app/lib/competitor-platform-router.mjs`
  - 为平台路由增加 `reportMode`，抖音为 `douyin-account`，小红书为 `none`。
- `app/lib/competitor-platform-router.d.mts`
  - 同步路由类型。
- `app/components/CompetitorInsightPanel.tsx`
  - 将抖音成功抓取结果交给 `CompetitorReportRunner`，保留小红书现有行为。
- `app/globals.css`
  - 双入口、阶段条、完整性卡片、错误与报告预览样式。
- `tests/competitor-platform-router.test.mjs`
  - 验证平台对应报告模式。
- `tests/workbench-ui.test.tsx`
  - 覆盖双入口、自动分析、模型缺失、停止和重试。
- `docs/project-progress/00-项目进度总览.md`
  - 更新竞品洞察真实能力和测试基线。
- `docs/project-progress/2026-07-31-项目进度更新.md`
  - 记录证据型报告里程碑。
- `/Users/lvyakun/Desktop/吕亚坤笔记库/codex 仓库/Codex产出/AI综合工作台/`
  - 同步两份项目进度文档。

---

### Task 1: 固化报告政策与跨语言数据契约

**Files:**

- Create: `agents/competitor-insight/reporting/report-policy.md`
- Create: `agents/competitor-insight/reporting/section-batch.schema.json`
- Create: `agents/competitor-insight/skills/evidence-report/SKILL.md`
- Create: `agents/competitor-insight/runtime/contracts.py`
- Create: `agents/competitor-insight/runtime/tests/test_contracts.py`
- Create: `agents/competitor-insight/runtime/requirements.txt`
- Modify: `agents/competitor-insight/agent.json`
- Modify: `.gitignore`

**Interfaces:**

- Consumes: 已确认设计文档和用户提供的固定报告结构。
- Produces:
  - `EvidenceItem`, `EvidenceBundle`, `SectionBatch`, `ReportArtifact` TypedDict。
  - `validate_contract_shape(value: object, required_keys: set[str]) -> dict[str, object]`。
  - 三批模型输出统一字段名：`batchId`, `claims`, `topicDirections`, `filmingTemplates`, `conversionItems`, `executionDays`。

- [ ] **Step 1: 写失败的契约测试**

在 `test_contracts.py` 写入：

```python
from contracts import validate_contract_shape


def test_contract_rejects_missing_required_key():
    with self.assertRaisesRegex(ValueError, "missing_keys:evidenceId"):
        validate_contract_shape({"title": "测试作品"}, {"evidenceId", "title"})


def test_contract_returns_plain_mapping():
    result = validate_contract_shape(
        {"evidenceId": "DY-E0001", "title": "测试作品"},
        {"evidenceId", "title"},
    )
    self.assertEqual(result["evidenceId"], "DY-E0001")
```

同时读取 `section-batch.schema.json`，断言根对象禁止额外属性，`strength` 只能是 `direct|weak|hypothesis`，`evidenceIds` 是非空字符串数组。

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
python3 -m unittest agents/competitor-insight/runtime/tests/test_contracts.py -v
```

Expected: FAIL，原因是 `contracts` 或 Schema 尚不存在。

- [ ] **Step 3: 创建最小契约和报告政策**

`contracts.py` 至少定义：

```python
class EvidenceItem(TypedDict):
    evidenceId: str
    sourceRow: int
    title: str
    likes: int
    comments: int
    collects: int
    shares: int
    totalInteractions: int
    publishedAt: str
    url: str
    ranks: dict[str, int | None]


class EvidenceBundle(TypedDict):
    evidenceVersion: Literal["1.0"]
    evidenceId: str
    account: dict[str, object]
    completeness: dict[str, object]
    metrics: dict[str, int | float | None]
    rankings: dict[str, dict[str, object]]
    items: list[EvidenceItem]


def validate_contract_shape(
    value: object,
    required_keys: set[str],
) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ValueError("expected_object")
    missing = sorted(required_keys - value.keys())
    if missing:
        raise ValueError(f"missing_keys:{','.join(missing)}")
    return value
```

`report-policy.md` 必须明确固定章节、证据字段、5 个选题方向、3 个拍法模板、7 天清单、弱判断、待验证假设和医疗合规边界，不复制过程性指令。

`requirements.txt` 固定为：

```text
openpyxl>=3.1,<4
```

- [ ] **Step 4: 注册 Agent Skill 并忽略本地环境**

`agent.json` 的 `skills` 增加：

```json
"skills/evidence-report/SKILL.md"
```

`.gitignore` 增加：

```text
agents/competitor-insight/.venv/
agents/competitor-insight/runtime/**/__pycache__/
```

- [ ] **Step 5: 运行契约测试**

Run:

```bash
python3 -m unittest agents/competitor-insight/runtime/tests/test_contracts.py -v
```

Expected: PASS。

- [ ] **Step 6: 检测范围并提交**

Run:

```bash
node .gitnexus/run.cjs detect-changes --scope all
git add .gitignore agents/competitor-insight/agent.json agents/competitor-insight/reporting agents/competitor-insight/skills/evidence-report agents/competitor-insight/runtime/contracts.py agents/competitor-insight/runtime/requirements.txt agents/competitor-insight/runtime/tests/test_contracts.py
git commit -m "feat: define competitor report evidence contracts"
```

---

### Task 2: 实现 Excel 字段识别与数据清洗

**Files:**

- Create: `agents/competitor-insight/runtime/metrics.py`
- Create: `agents/competitor-insight/runtime/workbook_reader.py`
- Create: `agents/competitor-insight/runtime/tests/test_metrics.py`
- Create: `agents/competitor-insight/runtime/tests/test_workbook_reader.py`

**Interfaces:**

- Consumes: `contracts.py` 的账号与作品映射形状。
- Produces:
  - `parse_metric(value: object) -> tuple[int, list[str]]`
  - `parse_publish_time(value: object) -> tuple[datetime | None, list[str]]`
  - `read_account_workbook(path: Path) -> dict[str, object]`
  - 返回值固定包含 `account`, `works`, `fieldMap`, `missingFields`, `warnings`。

- [ ] **Step 1: 写数值清洗失败测试**

```python
CASES = {
    "1.5w": 15000,
    "1.5W": 15000,
    "1.5万": 15000,
    "8,000": 8000,
    8000: 8000,
    None: 0,
    "无法识别": 0,
    -5: 0,
}

for raw, expected in CASES.items():
    with self.subTest(raw=raw):
        actual, warnings = parse_metric(raw)
        self.assertEqual(actual, expected)
```

负数必须包含 `negative_metric` 警告，无法识别字符串必须包含 `unrecognized_metric`。

- [ ] **Step 2: 写工作簿失败测试**

使用 `TemporaryDirectory` 和 `openpyxl.Workbook()` 动态创建：

- 标准 `账号概览` + `全部作品`；
- 表头为 `文案/likes/comments/collects/shares/create_time/url`；
- 缺少收藏和分享；
- 没有标题字段；
- 没有作品行；
- 多工作表但名称不同。

核心断言：

```python
parsed = read_account_workbook(path)
self.assertEqual(parsed["account"]["nickname"], "测试账号")
self.assertEqual(parsed["works"][0]["title"], "第一条作品")
self.assertEqual(parsed["fieldMap"]["likes"], "点赞")
self.assertIn("collects", parsed["missingFields"])
```

- [ ] **Step 3: 运行测试确认失败**

Run:

```bash
agents/competitor-insight/.venv/bin/python -m unittest \
  agents/competitor-insight/runtime/tests/test_metrics.py \
  agents/competitor-insight/runtime/tests/test_workbook_reader.py -v
```

Expected: FAIL，模块尚不存在。若 `.venv` 不存在，先执行：

```bash
python3 -m venv agents/competitor-insight/.venv
agents/competitor-insight/.venv/bin/python -m pip install -r agents/competitor-insight/runtime/requirements.txt
```

- [ ] **Step 4: 实现纯清洗函数**

`parse_metric` 按顺序处理数字、空值、逗号、`w/W/万` 后缀和异常值；禁止通过字符串排序。

`parse_publish_time` 支持：

- Excel `datetime`
- Excel 日期序列
- 秒和毫秒时间戳
- `YYYY-MM-DD HH:MM[:SS]`
- 无法解析返回 `None` 和 `invalid_publish_time`

- [ ] **Step 5: 实现工作表和字段语义匹配**

标准字段映射：

```python
FIELD_ALIASES = {
    "title": ("标题", "文案", "作品标题", "desc"),
    "likes": ("点赞", "点赞数", "likes"),
    "comments": ("评论", "评论数", "comments"),
    "collects": ("收藏", "收藏数", "collects"),
    "shares": ("分享", "分享数", "shares"),
    "publishedAt": ("发布时间", "发布时间戳", "publish_time", "create_time"),
    "url": ("视频链接", "链接", "url"),
}
```

标题字段或作品行缺失时抛出：

```python
ValueError("missing_title_field")
ValueError("no_work_rows")
```

- [ ] **Step 6: 运行测试确认通过**

Run:

```bash
agents/competitor-insight/.venv/bin/python -m unittest \
  agents/competitor-insight/runtime/tests/test_metrics.py \
  agents/competitor-insight/runtime/tests/test_workbook_reader.py -v
```

Expected: PASS。

- [ ] **Step 7: 检测范围并提交**

```bash
node .gitnexus/run.cjs detect-changes --scope all
git add agents/competitor-insight/runtime/metrics.py agents/competitor-insight/runtime/workbook_reader.py agents/competitor-insight/runtime/tests/test_metrics.py agents/competitor-insight/runtime/tests/test_workbook_reader.py
git commit -m "feat: parse competitor account workbooks"
```

---

### Task 3: 实现排行榜、汇总指标和稳定证据包

**Files:**

- Create: `agents/competitor-insight/runtime/analytics.py`
- Create: `agents/competitor-insight/runtime/evidence_bundle.py`
- Create: `agents/competitor-insight/runtime/tests/test_analytics.py`
- Create: `agents/competitor-insight/runtime/tests/test_evidence_bundle.py`

**Interfaces:**

- Consumes: `read_account_workbook(path)` 返回的标准作品列表。
- Produces:
  - `rank_works(works: list[dict[str, object]], availability: dict[str, bool]) -> dict[str, dict[str, object]]`
  - `calculate_metrics(works: list[dict[str, object]], rankings: dict[str, dict[str, object]]) -> dict[str, int | float | None]`
  - `build_evidence_bundle(parsed: dict[str, object], source: dict[str, str]) -> EvidenceBundle`
  - `write_evidence_bundle(bundle: EvidenceBundle, output_dir: Path) -> Path`

- [ ] **Step 1: 写排行榜失败测试**

覆盖：

```python
rankings = rank_works(sample_works, availability)
self.assertEqual(rankings["overall"]["rows"][:3], [2, 0, 1])
self.assertEqual(len(rankings["startup"]["rows"]), 5)
self.assertNotIn(missing_date_row, rankings["startup"]["rows"])
self.assertEqual(
    rankings["collect"]["rows"][:2],
    [collect_leader, collect_runner_up],
)
```

分别构造 8、20、21、40 条作品，验证不足 20 取最早 5，20 条取最早 5，21 条取最早 6，40 条取最早 10。
另行断言 `rankings["collect"]["rows"]`、`rankings["share"]["rows"]` 和 `rankings["comment"]["rows"]` 分别对应高收藏 Top 5、高分享 Top 5 和高评论 Top 5；对应字段整体缺失时，`status` 为 `unavailable` 且 `rows` 为空数组。

- [ ] **Step 2: 写汇总指标和证据稳定性失败测试**

```python
bundle_a = build_evidence_bundle(parsed, {"kind": "upload", "name": "sample.xlsx"})
bundle_b = build_evidence_bundle(parsed, {"kind": "upload", "name": "sample.xlsx"})
self.assertEqual(
    [item["evidenceId"] for item in bundle_a["items"]],
    [item["evidenceId"] for item in bundle_b["items"]],
)
self.assertEqual(bundle_a["items"][0]["evidenceId"], "DY-E0001")
self.assertEqual(bundle_a["metrics"]["top10InteractionShare"], 1.0)
```

还要验证分母为 0 时占比为 `None`，不是 `0` 或无穷值。

- [ ] **Step 3: 运行测试确认失败**

```bash
agents/competitor-insight/.venv/bin/python -m unittest \
  agents/competitor-insight/runtime/tests/test_analytics.py \
  agents/competitor-insight/runtime/tests/test_evidence_bundle.py -v
```

Expected: FAIL，模块尚不存在。

- [ ] **Step 4: 实现排名和指标**

每条标准作品先增加：

```python
work["totalInteractions"] = (
    work["likes"] + work["comments"] + work["collects"] + work["shares"]
)
```

并列键固定为：

```python
(-target_metric, -published_timestamp_or_zero, source_row)
```

起号期先按 `(published_timestamp, source_row)` 取样，再优先选择 `totalInteractions > averageTotalInteractions * 2`。

- [ ] **Step 5: 实现证据包**

证据包 `evidenceId` 使用内容摘要，确保相同输入得到相同 ID：

```python
digest = hashlib.sha256(
    json.dumps(canonical_input, ensure_ascii=False, sort_keys=True).encode("utf-8")
).hexdigest()[:16]
```

作品证据编号严格按 Excel 原始行号升序生成 `DY-E0001`、`DY-E0002`。

- [ ] **Step 6: 运行测试确认通过**

```bash
agents/competitor-insight/.venv/bin/python -m unittest \
  agents/competitor-insight/runtime/tests/test_analytics.py \
  agents/competitor-insight/runtime/tests/test_evidence_bundle.py -v
```

Expected: PASS。

- [ ] **Step 7: 检测范围并提交**

```bash
node .gitnexus/run.cjs detect-changes --scope all
git add agents/competitor-insight/runtime/analytics.py agents/competitor-insight/runtime/evidence_bundle.py agents/competitor-insight/runtime/tests/test_analytics.py agents/competitor-insight/runtime/tests/test_evidence_bundle.py
git commit -m "feat: build deterministic competitor evidence bundles"
```

---

### Task 4: 实现结构化章节校验和确定性 Markdown 渲染

**Files:**

- Create: `agents/competitor-insight/runtime/section_validator.py`
- Create: `agents/competitor-insight/runtime/report_renderer.py`
- Create: `agents/competitor-insight/runtime/tests/test_section_validator.py`
- Create: `agents/competitor-insight/runtime/tests/test_report_renderer.py`

**Interfaces:**

- Consumes: `EvidenceBundle` 和三批模型 JSON。
- Produces:
  - `validate_section_batch(batch: object, bundle: EvidenceBundle) -> dict[str, object]`
  - `render_evidence_reference(evidence_id: str, bundle: EvidenceBundle) -> str`
  - `assemble_report(bundle: EvidenceBundle, batches: list[dict[str, object]]) -> str`
  - `validate_final_report(markdown: str, bundle: EvidenceBundle) -> list[str]`

- [ ] **Step 1: 写章节校验失败测试**

覆盖：

```python
with self.assertRaisesRegex(ValueError, "unknown_evidence_id"):
    validate_section_batch(
        {"batchId": "strategy", "claims": [{
            "statement": "测试判断",
            "strength": "direct",
            "evidenceIds": ["DY-E9999"],
        }]},
        bundle,
    )

with self.assertRaisesRegex(ValueError, "weak_claim_requires_label"):
    validate_section_batch(batch_without_weak_label, bundle)
```

第三批还必须拒绝：

- 少于 5 个 `topicDirections`
- 少于 3 个 `filmingTemplates`
- `executionDays` 不是 1–7 的完整集合
- 建议未引用 Top 10 或起号期 Top 5

- [ ] **Step 2: 写渲染失败测试**

```python
markdown = assemble_report(bundle, valid_batches)
self.assertIn("# 抖音账号分析报告 - @测试账号", markdown)
self.assertIn("| 排名 | 标题 | 点赞 | 评论 | 收藏 | 分享 | 综合互动量 |", markdown)
self.assertIn("DY-E0001", markdown)
self.assertIn("点赞：12,000", markdown)
self.assertNotIn("999,999", markdown)
```

构造模型 JSON 内的伪造数字 `999999`，最终 Markdown 不得出现该数字。

- [ ] **Step 3: 运行测试确认失败**

```bash
agents/competitor-insight/.venv/bin/python -m unittest \
  agents/competitor-insight/runtime/tests/test_section_validator.py \
  agents/competitor-insight/runtime/tests/test_report_renderer.py -v
```

Expected: FAIL，校验器和渲染器尚不存在。

- [ ] **Step 4: 实现章节校验**

允许模型提供文字字段，但所有证据数字必须由 `bundle` 注入。`statement` 中匹配到未绑定的数字时，将其作为 `untrusted_numeric_claim` 拒绝；只允许固定结构词 `3 秒`、`5 个`、`7 天`、`2-3 条` 和四位年份。点赞、评论、收藏、分享、综合互动量、均值、占比和排名数字只能由渲染器从证据包注入。

推断等级规则：

```python
STRENGTH_LABELS = {
    "direct": "",
    "weak": "基于标题和互动数据的弱判断",
    "hypothesis": "待验证假设",
}
```

- [ ] **Step 5: 实现固定 Markdown 渲染**

固定表格直接遍历 `rankings` 和 `items`，不得读取模型返回的排名或数字。最终章节顺序与设计文档第 11 节完全一致。

同名输出文件使用：

```text
[安全昵称]_抖音账号分析报告_YYYYMMDD_HHMMSS.md
```

- [ ] **Step 6: 运行测试确认通过**

```bash
agents/competitor-insight/.venv/bin/python -m unittest \
  agents/competitor-insight/runtime/tests/test_section_validator.py \
  agents/competitor-insight/runtime/tests/test_report_renderer.py -v
```

Expected: PASS。

- [ ] **Step 7: 检测范围并提交**

```bash
node .gitnexus/run.cjs detect-changes --scope all
git add agents/competitor-insight/runtime/section_validator.py agents/competitor-insight/runtime/report_renderer.py agents/competitor-insight/runtime/tests/test_section_validator.py agents/competitor-insight/runtime/tests/test_report_renderer.py
git commit -m "feat: validate and render evidence-based reports"
```

---

### Task 5: 建立受控本地报告服务

**Files:**

- Create: `agents/competitor-insight/runtime/service.py`
- Create: `agents/competitor-insight/runtime/bridge_server.py`
- Create: `agents/competitor-insight/runtime/tests/test_service.py`
- Create: `agents/competitor-insight/runtime/tests/test_bridge_server.py`

**Interfaces:**

- Consumes: Tasks 2–4 的读取、证据、校验和渲染函数。
- Produces:
  - `analyze_path(path_text: str) -> dict[str, object]`
  - `analyze_upload(filename: str, content: bytes) -> dict[str, object]`
  - `validate_batch(evidence_id: str, batch: object) -> dict[str, object]`
  - `assemble(evidence_id: str, batches: list[object]) -> ReportArtifact`
  - HTTP: `/health`, `/analyze-path`, `/analyze-upload`, `/validate-section`, `/assemble-report`

- [ ] **Step 1: 写服务路径与上传失败测试**

测试：

```python
with self.assertRaisesRegex(ValueError, "path_outside_douyin_output"):
    service.analyze_path("/Users/lvyakun/Desktop/private.xlsx")

with self.assertRaisesRegex(ValueError, "invalid_xlsx_signature"):
    service.analyze_upload("fake.xlsx", b"not-a-zip")

with self.assertRaisesRegex(ValueError, "invalid_extension"):
    service.analyze_upload("fake.xls", valid_xlsx_bytes)
```

创建受控目录内符号链接指向外部文件，必须返回 `symlink_not_allowed`。

- [ ] **Step 2: 写 HTTP 安全失败测试**

启动 `ThreadingHTTPServer(("127.0.0.1", 0), BridgeHandler)`，验证：

- `/health` 返回 200
- 恶意 Origin 返回 403
- 请求体超过 50 MB 返回 413，测试中通过较小的可注入上限模拟
- 非 JSON 请求返回 400
- 错误响应不含本机堆栈和文件正文

- [ ] **Step 3: 运行测试确认失败**

```bash
agents/competitor-insight/.venv/bin/python -m unittest \
  agents/competitor-insight/runtime/tests/test_service.py \
  agents/competitor-insight/runtime/tests/test_bridge_server.py -v
```

Expected: FAIL，服务尚不存在。

- [ ] **Step 4: 实现受控文件服务**

输出根目录固定解析为：

```python
PROJECT_ROOT / "outputs" / "competitor-insight" / "reports"
```

上传副本放入 `TemporaryDirectory(dir=reports_root / ".tmp")`，`build_evidence_bundle` 和 `write_evidence_bundle` 完成后退出上下文自动删除。

证据包按 `evidenceId` 存到 `reports/evidence/`，服务后续从该目录读取，禁止客户端传任意证据路径。

- [ ] **Step 5: 实现 HTTP 处理器**

统一成功形状：

```json
{
  "ok": true,
  "stage": "evidence_ready",
  "evidenceId": "0123456789abcdef",
  "account": {"nickname": "测试账号"},
  "completeness": {},
  "batchInputs": {}
}
```

`/assemble-report` 成功形状固定为：

```json
{
  "ok": true,
  "stage": "report_ready",
  "filename": "测试账号_抖音账号分析报告_20260731_120000.md",
  "reportPath": "/受控目录/测试账号_抖音账号分析报告_20260731_120000.md",
  "markdown": "# 抖音账号分析报告 - @测试账号",
  "validationErrors": []
}
```

报告桥响应正文上限固定为 2 MB；超限时保留本地文件但不把全文返回浏览器，并返回 `REPORT_TOO_LARGE_FOR_PREVIEW`。

统一错误只返回稳定代码和中文消息：

```json
{"ok": false, "error": "INVALID_WORKBOOK", "message": "Excel 中没有可用的作品数据。"}
```

- [ ] **Step 6: 运行服务测试和手工安全检查**

```bash
agents/competitor-insight/.venv/bin/python -m unittest \
  agents/competitor-insight/runtime/tests/test_service.py \
  agents/competitor-insight/runtime/tests/test_bridge_server.py -v

agents/competitor-insight/.venv/bin/python \
  agents/competitor-insight/runtime/bridge_server.py
```

另一个终端验证：

```bash
curl -i http://127.0.0.1:8768/health
curl -i -X OPTIONS http://127.0.0.1:8768/analyze-upload \
  -H 'Origin: https://evil.example'
```

Expected: 健康检查 200，恶意来源 403。

- [ ] **Step 7: 检测范围并提交**

```bash
node .gitnexus/run.cjs detect-changes --scope all
git add agents/competitor-insight/runtime/service.py agents/competitor-insight/runtime/bridge_server.py agents/competitor-insight/runtime/tests/test_service.py agents/competitor-insight/runtime/tests/test_bridge_server.py
git commit -m "feat: add local competitor report service"
```

---

### Task 6: 补齐 douyin-scraper 精确 Excel 输出契约

**Files:**

- Modify: `/Users/lvyakun/.codex/skills/douyin-scraper/main.py`
- Modify: `/Users/lvyakun/.codex/skills/douyin-scraper/bridge_server.py`
- Modify: `/Users/lvyakun/.codex/skills/douyin-scraper/SKILL.md`
- Create: `/Users/lvyakun/.codex/skills/douyin-scraper/tests/test_bridge_contract.py`

**Interfaces:**

- Consumes: `douyin-scraper` 账号模式输出。
- Produces:
  - CLI 成功 JSON：`status`, `input_type`, `excel_path`, `data`
  - 桥成功 JSON：`ok`, `platform`, `skillId`, `inputType`, `excelPath`, `outputDir`

- [ ] **Step 1: 写桥契约失败测试**

把桥响应组装提取为纯函数：

```python
with tempfile.TemporaryDirectory() as temp_dir:
    excel_path = Path(temp_dir) / "account.xlsx"
    excel_path.write_bytes(b"test-contract-file")
    payload = build_success_payload({
        "status": "success",
        "input_type": "账号链接/账号标识",
        "excel_path": str(excel_path),
    })
    self.assertEqual(payload["excelPath"], str(excel_path.resolve()))
    self.assertEqual(payload["inputType"], "账号链接/账号标识")
```

并断言缺少 `excel_path` 或 `status != success` 时抛出 `invalid_scraper_result`。

- [ ] **Step 2: 运行测试确认失败**

```bash
/Users/lvyakun/.codex/skills/douyin-scraper/.venv/bin/python \
  -m unittest /Users/lvyakun/.codex/skills/douyin-scraper/tests/test_bridge_contract.py -v
```

Expected: FAIL，`build_success_payload` 尚不存在。

- [ ] **Step 3: 调整账号模式输出顺序**

在 `main.py` 账号分支：

1. 先确定 `output_path`
2. 调用 `generate_excel(profile, videos, output_path)`
3. 将绝对路径写入：

```python
result["excel_path"] = str(Path(output_path).resolve())
```

4. 再打印 JSON 或写入 `--json` 文件

单作品继续返回 `input_type == "作品链接"`，不进入账号报告。

- [ ] **Step 4: 提升桥响应字段**

`build_success_payload` 必须验证 Excel 是普通 `.xlsx` 文件，然后返回：

```python
{
    "ok": True,
    "platform": "douyin",
    "skillId": "douyin-scraper",
    "inputType": parsed_result["input_type"],
    "excelPath": parsed_result["excel_path"],
    "outputDir": str(OUTPUT_DIR),
}
```

- [ ] **Step 5: 运行无抓取测试和语法检查**

```bash
/Users/lvyakun/.codex/skills/douyin-scraper/.venv/bin/python \
  -m unittest /Users/lvyakun/.codex/skills/douyin-scraper/tests/test_bridge_contract.py -v

/Users/lvyakun/.codex/skills/douyin-scraper/.venv/bin/python \
  -m py_compile \
  /Users/lvyakun/.codex/skills/douyin-scraper/main.py \
  /Users/lvyakun/.codex/skills/douyin-scraper/bridge_server.py
```

Expected: PASS；不启动浏览器，不读取 Cookie，不执行真实抓取。

- [ ] **Step 6: 记录外部 Skill 变更**

该 Skill 位于工作区 Git 仓库之外，不提交到本仓库。记录修改文件、校验结果和安装路径到本任务最终进度文档；不得把 Skill 中的 Cookie、state 或运行产物复制进项目。

---

### Task 7: 建立竞品报告专用模型运行时

**Files:**

- Create: `app/lib/competitor-report-runtime.ts`
- Create: `app/api/agents/competitor-insight/route.ts`
- Create: `tests/competitor-report-runtime.test.mjs`
- Create: `tests/competitor-report-route.test.mjs`

**Interfaces:**

- Consumes:
  - `ChatModel`
  - `GlobalTextConfig`
  - 证据桥返回的三批 `batchInputs`
- Produces:
  - `buildCompetitorBatchPrompt(batchId, input) -> ChatTurn[]`
  - `parseCompetitorBatchResponse(text) -> Record<string, unknown>`
  - `generateCompetitorBatch(config, input, options) -> Promise<Record<string, unknown>>`
  - API `POST /api/agents/competitor-insight`

- [ ] **Step 1: 写提示和结构化响应失败测试**

```js
const turns = buildCompetitorBatchPrompt("strategy", fixtureInput);
assert.match(turns[0].content, /不得重新计算或修改排名/);
assert.match(turns[1].content, /DY-E0001/);
assert.doesNotMatch(turns[1].content, /api[_-]?key/i);

assert.deepEqual(
  parseCompetitorBatchResponse('```json\\n{"batchId":"strategy","claims":[]}\\n```'),
  { batchId: "strategy", claims: [] },
);
```

无 JSON、数组根节点、超长响应和未知 `batchId` 必须安全失败。

- [ ] **Step 2: 写路由安全失败测试**

覆盖：

- 非 POST
- 超过 128 KB 的请求
- 非 HTTPS 和私网 URL
- 重定向
- 401、429、超时和畸形 JSON
- 错误中不出现 API Key、上游响应体或 endpoint
- 调用方取消会中止上游请求

- [ ] **Step 3: 运行测试确认失败**

```bash
npx tsx --test tests/competitor-report-runtime.test.mjs tests/competitor-report-route.test.mjs
```

Expected: FAIL，运行时和路由尚不存在。

- [ ] **Step 4: 实现三批提示和客户端直连**

固定批次：

```ts
export type CompetitorBatchId = "strategy" | "performance" | "execution";
```

限制：

- 单批输入最多 80,000 字符
- 总请求体最多 128 KB
- 单批模型输出最多 40,000 字符
- 超时 180 秒
- `max_tokens` 固定 6,000

APINebula/现有受控浏览器直连继续使用精确主机白名单和 `redirect: "error"`。服务端代理只允许项目现有审核过的 `https://api.openai.com` 默认端口；自定义地址不得通过服务端携带凭据。

- [ ] **Step 5: 实现服务端代理路由**

请求形状：

```ts
type CompetitorReportRequest = {
  config: { baseUrl: string; apiKey: string; model: string };
  batchId: CompetitorBatchId;
  input: Record<string, unknown>;
};
```

成功只返回：

```json
{"ok": true, "batch": {}}
```

失败使用安全错误码，不反射用户输入、证据正文、凭据或上游响应体。

- [ ] **Step 6: 运行测试和类型检查**

```bash
npx tsx --test tests/competitor-report-runtime.test.mjs tests/competitor-report-route.test.mjs
npm run typecheck
```

Expected: PASS。

- [ ] **Step 7: 检测范围并提交**

```bash
node .gitnexus/run.cjs detect-changes --scope all
git add app/lib/competitor-report-runtime.ts app/api/agents/competitor-insight/route.ts tests/competitor-report-runtime.test.mjs tests/competitor-report-route.test.mjs
git commit -m "feat: add safe competitor report model runtime"
```

---

### Task 8: 接入双入口界面和分阶段报告工作流

**Files:**

- Create: `app/lib/competitor-report-client.ts`
- Create: `app/components/CompetitorReportRunner.tsx`
- Modify: `app/lib/competitor-platform-router.mjs`
- Modify: `app/lib/competitor-platform-router.d.mts`
- Modify: `app/components/CompetitorInsightPanel.tsx`
- Modify: `app/globals.css`
- Modify: `tests/competitor-platform-router.test.mjs`
- Modify: `tests/workbench-ui.test.tsx`

**Interfaces:**

- Consumes:
  - 抖音桥 `excelPath` 与 `inputType`
  - 本地报告桥 API
  - `useModelRegistry()` 的 Agent 模型选择和凭据修订
  - `generateCompetitorBatch()`
- Produces:
  - `CompetitorReportRunner`
  - `analyzeReportPath`, `analyzeReportUpload`, `validateReportBatch`, `assembleReport`
  - 五阶段 UI 状态和报告结果

- [ ] **Step 1: 修改前执行 GitNexus 影响分析**

```bash
node .gitnexus/run.cjs impact CompetitorInsightPanel \
  --direction upstream \
  --file app/components/CompetitorInsightPanel.tsx

node .gitnexus/run.cjs impact detectCompetitorPlatform \
  --direction upstream \
  --file app/lib/competitor-platform-router.mjs
```

若结果为 HIGH 或 CRITICAL，先向用户报告直接调用者、受影响流程和控制措施，再继续。

- [ ] **Step 2: 写路由和双入口失败测试**

路由断言：

```js
assert.equal(
  detectCompetitorPlatform("https://v.douyin.com/test/").reportMode,
  "douyin-account",
);
assert.equal(
  detectCompetitorPlatform("https://www.xiaohongshu.com/explore/test").reportMode,
  "none",
);
```

界面断言：

- 显示“抓取并分析”和“分析已有 Excel”
- 选择非 `.xlsx` 时不发送请求
- 抓取返回账号 `excelPath` 后自动调用 `/analyze-path`
- 抓取返回作品链接时只显示单作品抓取完成
- 上传成功后依次调用三批模型、三次章节校验和一次组装
- 未配置 Agent 模型时停在“证据包已生成”
- 停止时中止模型请求并保留证据包
- 失败批次重试不重新上传或抓取

- [ ] **Step 3: 运行目标测试确认失败**

```bash
npx tsx --test tests/competitor-platform-router.test.mjs
npx tsx --test --test-name-pattern="竞品洞察.*报告|已有 Excel|抓取并分析" tests/workbench-ui.test.tsx
```

Expected: FAIL，报告模式和双入口尚不存在。

- [ ] **Step 4: 实现报告桥客户端**

导出：

```ts
export async function analyzeReportPath(
  excelPath: string,
  signal: AbortSignal,
): Promise<EvidenceReadyResponse>;

export async function analyzeReportUpload(
  file: File,
  signal: AbortSignal,
): Promise<EvidenceReadyResponse>;

export async function validateReportBatch(
  evidenceId: string,
  batch: unknown,
  signal: AbortSignal,
): Promise<ValidatedBatchResponse>;

export async function assembleReport(
  evidenceId: string,
  batches: unknown[],
  signal: AbortSignal,
): Promise<ReportReadyResponse>;
```

上传使用原始文件字节和编码后的 `X-Filename`；客户端拒绝超过 50 MB。

- [ ] **Step 5: 实现 Runner 状态机**

状态：

```ts
type ReportStage =
  | "idle"
  | "reading"
  | "calculating"
  | "evidence-ready"
  | "generating"
  | "validating"
  | "saving"
  | "completed"
  | "failed"
  | "stopped";
```

每次运行绑定：

- request token
- `AbortController`
- Agent model ID
- credential revision
- evidence ID
- 已完成批次

任何一项变化都丢弃迟到响应。

模型选择必须按以下顺序解析：

```ts
const modelId = getAgentSelectedModelId("competitor-insight");
const model = connectedModels.find((item) => item.id === modelId) ?? null;
const credential = model ? getCredential(model.id) : null;
const credentialRevision = model
  ? getCredentialRevision(model.id)
  : "";
```

模型、凭据或连接状态任一缺失时，不发起第四阶段请求。

- [ ] **Step 6: 修改竞品面板和样式**

`CompetitorInsightPanel`：

- 抖音账号抓取成功将 `excelPath` 传给 Runner。
- 小红书保持现有抓取完成提示。
- 抖音单作品不进入账号报告。
- 现有平台卡片补充“账号 Excel → Markdown 证据报告”能力说明。

Runner 提供文件选择、阶段条、完整性摘要、失败章节重试、停止、Markdown 预览、下载和复制绝对路径。预览和下载必须使用 `/assemble-report` 同一次响应中的 `markdown`，不得分别重新生成。

- [ ] **Step 7: 运行目标测试、类型检查和 Lint**

```bash
npx tsx --test tests/competitor-platform-router.test.mjs
npx tsx --test --test-name-pattern="竞品洞察.*报告|已有 Excel|抓取并分析" tests/workbench-ui.test.tsx
npm run typecheck
npm run lint
```

Expected: PASS。

- [ ] **Step 8: 检测范围并提交**

```bash
node .gitnexus/run.cjs detect-changes --scope all
git add app/lib/competitor-report-client.ts app/components/CompetitorReportRunner.tsx app/lib/competitor-platform-router.mjs app/lib/competitor-platform-router.d.mts app/components/CompetitorInsightPanel.tsx app/globals.css tests/competitor-platform-router.test.mjs tests/workbench-ui.test.tsx
git commit -m "feat: add competitor Excel report workflow"
```

---

### Task 9: 完成全链路验收、进度同步和交付

**Files:**

- Modify: `docs/project-progress/00-项目进度总览.md`
- Modify: `docs/project-progress/2026-07-31-项目进度更新.md`
- Sync: `/Users/lvyakun/Desktop/吕亚坤笔记库/codex 仓库/Codex产出/AI综合工作台/00-项目进度总览.md`
- Sync: `/Users/lvyakun/Desktop/吕亚坤笔记库/codex 仓库/Codex产出/AI综合工作台/2026-07-31-项目进度更新.md`

**Interfaces:**

- Consumes: Tasks 1–8 的全部可执行能力。
- Produces: 已验证本地功能、准确进度记录和最终交付说明。

- [ ] **Step 1: 运行全部 Python 测试**

```bash
agents/competitor-insight/.venv/bin/python -m unittest discover \
  -s agents/competitor-insight/runtime/tests \
  -p 'test_*.py' \
  -v
```

Expected: 全部通过。

- [ ] **Step 2: 运行全部前端工程验证**

```bash
npm run typecheck
npm run lint
npm test
```

Expected: 构建、类型检查、Lint 和全部 Node/React 测试通过。

- [ ] **Step 3: 执行无真实平台数据的端到端夹具验收**

使用测试生成的脱敏 Excel：

1. `/analyze-upload` 返回证据包。
2. 三批模型请求使用 mock fetch。
3. 三批章节通过校验。
4. `/assemble-report` 保存 Markdown。
5. 回读 Markdown，验证固定章节、Top 10、起号期 Top 5、5 个选题方向、3 个拍法模板和 7 天清单。
6. 验证原始夹具哈希未变化。

不得使用真实 Cookie、真实竞品账号或真实 API Key。

- [ ] **Step 4: 验证两座抓取桥和报告桥健康状态**

```bash
curl -sS http://127.0.0.1:8765/health
curl -sS http://127.0.0.1:8766/health
curl -sS http://127.0.0.1:8768/health
```

并验证恶意 Origin 对三个桥均返回 403。

- [ ] **Step 5: 更新项目进度和 Obsidian**

明确区分：

- 已完成：证据计算、双入口、模型分批生成、报告校验和本地保存。
- 进行中：真实抖音账号首次业务验收。
- 尚未完成：小红书专属分析报告、数据库持久化和线上调用本地桥。

更新测试数量、桥端口、输出目录、风险和线上未部署状态；不得写入真实账号数据、Cookie、Token 或 API Key。

- [ ] **Step 6: 同步并回读比较**

```bash
cp docs/project-progress/00-项目进度总览.md \
  '/Users/lvyakun/Desktop/吕亚坤笔记库/codex 仓库/Codex产出/AI综合工作台/00-项目进度总览.md'

cp docs/project-progress/2026-07-31-项目进度更新.md \
  '/Users/lvyakun/Desktop/吕亚坤笔记库/codex 仓库/Codex产出/AI综合工作台/2026-07-31-项目进度更新.md'

cmp -s docs/project-progress/00-项目进度总览.md \
  '/Users/lvyakun/Desktop/吕亚坤笔记库/codex 仓库/Codex产出/AI综合工作台/00-项目进度总览.md'
```

Expected: `cmp` 退出码为 0。

- [ ] **Step 7: 最终 GitNexus 检测**

```bash
node .gitnexus/run.cjs analyze
node .gitnexus/run.cjs detect-changes --scope all
```

确认仅影响竞品洞察、模型运行时和成果展示预期流程；HIGH 或 CRITICAL 必须在交付说明中列出直接调用者、已执行测试和剩余风险。

- [ ] **Step 8: 提交进度文档**

```bash
git add docs/project-progress/00-项目进度总览.md docs/project-progress/2026-07-31-项目进度更新.md
git commit -m "docs: record competitor report milestone"
```

- [ ] **Step 9: 最终工作树检查**

```bash
git status --short
git log --oneline -8
```

确认没有暂存 `.claude/`、`CLAUDE.md`、`output/`、真实 Excel、证据包、报告产物、Cookie、state 或本机缓存。除非用户明确要求，不推送、不部署。
