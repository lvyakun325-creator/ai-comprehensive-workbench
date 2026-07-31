from copy import deepcopy
from pathlib import Path
import sys
import unittest


RUNTIME_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME_DIR))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from report_renderer import assemble_report, render_evidence_reference, validate_final_report
from test_section_validator import evidence_bundle, execution_batch


def valid_batches() -> list[dict[str, object]]:
    strategy = {
        "batchId": "strategy",
        "claims": [
            {
                "section": "strategy",
                "statement": "<script>标题结构呈现生活化表达\n# 非法章节",
                "strength": "weak",
                "evidenceIds": ["DY-E0001"],
                "rationale": "仅依据标题与互动结构",
                "verificationPlan": "结合画面与评论进一步核验",
            },
            {
                "section": "business",
                "statement": "业务判断",
                "strength": "direct",
                "evidenceIds": ["DY-E0001"],
                "rationale": "由证据包字段直接支持",
            },
            {
                "section": "content",
                "statement": "内容判断",
                "strength": "hypothesis",
                "evidenceIds": ["DY-E0001"],
                "rationale": "由证据包字段直接支持",
                "verificationPlan": "结合画面进一步核验",
            },
        ],
        "topicDirections": [],
        "filmingTemplates": [],
        "conversionItems": [],
        "executionDays": [],
    }
    performance = {
        "batchId": "performance",
        "claims": [
            {
                "section": "traffic",
                "statement": "互动结构值得继续观察",
                "strength": "direct",
                "evidenceIds": ["DY-E0002"],
                "rationale": "由证据包字段直接支持",
            },
            {
                "section": "data",
                "statement": "账号数据需持续复盘",
                "strength": "direct",
                "evidenceIds": ["DY-E0002"],
                "rationale": "由证据包字段直接支持",
            },
        ],
        "topicDirections": [],
        "filmingTemplates": [],
        "conversionItems": [],
        "executionDays": [],
    }
    return [strategy, performance, execution_batch()]


class ReportRendererTests(unittest.TestCase):
    def test_renders_bundle_rankings_and_evidence_numbers_in_fixed_section_order(self) -> None:
        bundle = evidence_bundle()

        markdown = assemble_report(bundle, valid_batches())

        headings = [
            "# 抖音账号分析报告 - @测试账号",
            "## 账号概览",
            "## 战略层：账号定位与人设分析",
            "## 业务层：转化路径与商业价值分析",
            "## 内容层：选题策略与爆款内容分析",
            "## Top 10 高表现作品",
            "## 起号期 Top 5",
            "## 高收藏、高分享、高评论作品",
            "## 流量层：传播与互动表现分析",
            "## 数据层：关键指标与账号健康度分析",
            "## 对标建议：拍什么、怎么拍、怎么承接",
            "## 7 天对标执行清单",
        ]
        positions = [markdown.index(heading) for heading in headings]
        self.assertEqual(positions, sorted(positions))
        self.assertIn("| 排名 | 标题 | 点赞 | 评论 | 收藏 | 分享 | 综合互动量 |", markdown)
        self.assertIn("DY-E0001", markdown)
        self.assertIn("点赞：12,000", markdown)
        self.assertIn("基于标题和互动数据的弱判断", markdown)
        self.assertIn("待验证假设", markdown)
        self.assertNotIn("999,999", markdown)

    def test_escapes_model_text_so_it_cannot_inject_html_or_markdown_structure(self) -> None:
        markdown = assemble_report(evidence_bundle(), valid_batches())

        self.assertNotIn("<script>", markdown)
        self.assertNotIn("\n# 非法章节", markdown)
        self.assertIn("&lt;script&gt;", markdown)

    def test_rejects_forged_model_numbers_before_rendering(self) -> None:
        batches = valid_batches()
        batches[0]["claims"][0]["statement"] = "该作品有999999次互动"

        with self.assertRaisesRegex(ValueError, "untrusted_numeric_claim"):
            assemble_report(evidence_bundle(), batches)

    def test_routes_claims_by_section_and_rejects_duplicate_missing_or_extra_batches(self) -> None:
        batches = valid_batches()
        batches[0]["claims"].reverse()
        markdown = assemble_report(evidence_bundle(), batches)

        strategy_body = markdown.split("## 战略层：账号定位与人设分析", 1)[1].split("## 业务层", 1)[0]
        business_body = markdown.split("## 业务层：转化路径与商业价值分析", 1)[1].split("## 内容层", 1)[0]
        self.assertIn("标题结构呈现生活化表达", strategy_body)
        self.assertNotIn("业务判断", strategy_body)
        self.assertIn("业务判断", business_body)

        cases = (
            ([batches[0], batches[1], batches[1]], "duplicate_batch_id:performance"),
            ([batches[0], batches[2]], "missing_batch_id:performance"),
            ([*batches, {**batches[0], "batchId": "unknown"}], "invalid_batch_id"),
        )
        for invalid, error in cases:
            with self.subTest(error=error):
                with self.assertRaisesRegex(ValueError, error):
                    assemble_report(evidence_bundle(), invalid)

    def test_renders_a_reference_only_from_the_bundle(self) -> None:
        reference = render_evidence_reference("DY-E0001", evidence_bundle())

        self.assertIn("DY-E0001", reference)
        self.assertIn("作品一", reference)
        self.assertIn("综合互动量：13,390", reference)
        self.assertIn("综合排名：1", reference)
        self.assertNotIn("999,999", reference)

    def test_final_validation_detects_missing_structure_unknown_evidence_and_number_leaks(self) -> None:
        bundle = evidence_bundle()
        batches = valid_batches()
        markdown = assemble_report(bundle, batches)

        with self.assertRaises(TypeError):
            validate_final_report(markdown, bundle)
        self.assertEqual(validate_final_report(markdown, bundle, batches), [])
        missing = markdown.replace("## 数据层：关键指标与账号健康度分析", "")
        self.assertIn(
            "missing_section:数据层：关键指标与账号健康度分析",
            validate_final_report(missing, bundle, batches),
        )
        unknown = markdown + "\n  - 证据 `DY-E9999`：伪造引用\n"
        self.assertIn(
            "unknown_evidence_id:DY-E9999",
            validate_final_report(unknown, bundle, batches),
        )
        forged = markdown + "\n伪造互动：999,999\n"
        self.assertIn(
            "untrusted_numeric_claim:999,999",
            validate_final_report(forged, bundle, batches),
        )
        borrowed = markdown + "\n挪用合法证据数字：1,000\n"
        self.assertIn(
            "untrusted_numeric_claim:1,000",
            validate_final_report(borrowed, bundle, batches),
        )
        numbered_forgery = markdown + "\n999999.伪造互动\n"
        self.assertIn(
            "untrusted_numeric_claim:999999",
            validate_final_report(numbered_forgery, bundle, batches),
        )

    def test_final_validation_compares_deterministic_blocks_and_each_evidence_reference(self) -> None:
        bundle = evidence_bundle()
        batches = valid_batches()
        markdown = assemble_report(bundle, batches)

        swapped_overview = markdown.replace("粉丝数：3,210", "粉丝数：3,200", 1)
        self.assertIn(
            "deterministic_block_mismatch:账号概览",
            validate_final_report(swapped_overview, bundle, batches),
        )

        top_row = "| 1 | 作品一 | 12,000 | 320 | 860 | 210 | 13,390 |"
        swapped_table = markdown.replace(
            top_row,
            "| 1 | 作品一 | 1,000 | 320 | 860 | 210 | 13,390 |",
            1,
        )
        self.assertIn(
            "deterministic_block_mismatch:Top 10 高表现作品",
            validate_final_report(swapped_table, bundle, batches),
        )

        swapped_reference = markdown.replace("点赞：12,000", "点赞：1,000", 1)
        self.assertIn(
            "evidence_reference_mismatch:DY-E0001",
            validate_final_report(swapped_reference, bundle, batches),
        )

    def test_final_validation_binds_complete_evidence_sequence_to_batches(self) -> None:
        bundle = evidence_bundle()
        batches = valid_batches()
        markdown = assemble_report(bundle, batches)
        evidence_prefix = "  - 证据 `"
        lines = markdown.splitlines()
        evidence_indexes = [
            index for index, line in enumerate(lines) if line.startswith(evidence_prefix)
        ]

        deleted = "\n".join(
            line for line in lines if not line.startswith(evidence_prefix)
        ) + "\n"
        self.assertIn(
            "evidence_reference_sequence_mismatch",
            validate_final_report(deleted, bundle, batches),
        )

        copied_lines = list(lines)
        copied_reference = f"  - {render_evidence_reference('DY-E0001', bundle)}"
        for index in evidence_indexes:
            copied_lines[index] = copied_reference
        self.assertIn(
            "evidence_reference_sequence_mismatch",
            validate_final_report("\n".join(copied_lines) + "\n", bundle, batches),
        )

        reordered_lines = list(lines)
        first_e2 = next(
            index for index in evidence_indexes if "DY-E0002" in lines[index]
        )
        first_e1 = next(
            index for index in evidence_indexes if "DY-E0001" in lines[index]
        )
        reordered_lines[first_e1], reordered_lines[first_e2] = (
            reordered_lines[first_e2],
            reordered_lines[first_e1],
        )
        self.assertIn(
            "evidence_reference_sequence_mismatch",
            validate_final_report("\n".join(reordered_lines) + "\n", bundle, batches),
        )

        missing_one = list(lines)
        missing_one.pop(evidence_indexes[0])
        self.assertIn(
            "evidence_reference_sequence_mismatch",
            validate_final_report("\n".join(missing_one) + "\n", bundle, batches),
        )

    def test_final_validation_requires_exact_reassembly_from_same_batches(self) -> None:
        bundle = evidence_bundle()
        batches = valid_batches()
        markdown = assemble_report(bundle, batches)
        self.assertEqual(validate_final_report(markdown, bundle, batches), [])

        lines = markdown.splitlines()
        references = [
            line for line in lines if line.startswith("  - 证据 `")
        ]
        moved_to_end = "\n".join(
            [
                *(
                    line
                    for line in lines
                    if not line.startswith("  - 证据 `")
                ),
                *references,
            ]
        ) + "\n"
        self.assertIn(
            "report_content_mismatch",
            validate_final_report(moved_to_end, bundle, batches),
        )

        changed_batches = deepcopy(batches)
        changed_batches[0]["claims"][0]["statement"] = "另一条合法战略判断"
        self.assertIn(
            "report_content_mismatch",
            validate_final_report(markdown, bundle, changed_batches),
        )

        changed_body = markdown.replace("业务判断", "业务判断已被改写", 1)
        self.assertIn(
            "report_content_mismatch",
            validate_final_report(changed_body, bundle, batches),
        )

    def test_evidence_scan_ignores_id_like_text_outside_formal_reference_prefix(self) -> None:
        bundle = evidence_bundle()
        bundle["account"]["nickname"] = "测试 DY-E9999"
        bundle["items"][0]["title"] = "标题含 DY-E9998"
        batches = valid_batches()
        markdown = assemble_report(bundle, batches)

        self.assertEqual(validate_final_report(markdown, bundle, batches), [])

    def test_final_validation_handles_unavailable_rankings_from_bundle_status(self) -> None:
        bundle = evidence_bundle()
        for name in ("collect", "share", "comment"):
            bundle["rankings"][name] = {"status": "unavailable", "rows": []}
        batches = valid_batches()
        markdown = assemble_report(bundle, batches)

        self.assertEqual(validate_final_report(markdown, bundle, batches), [])
        self.assertEqual(markdown.count("该指标在源数据中不可用，未生成榜单。"), 3)
        tampered = markdown.replace("该指标在源数据中不可用，未生成榜单。", "无数据。", 1)
        self.assertIn(
            "deterministic_block_mismatch:高收藏、高分享、高评论作品",
            validate_final_report(tampered, bundle, batches),
        )

    def test_final_validation_requires_unique_real_heading_lines(self) -> None:
        bundle = evidence_bundle()
        batches = valid_batches()
        markdown = assemble_report(bundle, batches)
        duplicated = markdown + "\n## 数据层：关键指标与账号健康度分析\n"
        self.assertIn(
            "duplicate_section:数据层：关键指标与账号健康度分析",
            validate_final_report(duplicated, bundle, batches),
        )

        quoted = markdown.replace(
            "## 数据层：关键指标与账号健康度分析",
            "> ## 数据层：关键指标与账号健康度分析",
            1,
        )
        self.assertIn(
            "missing_section:数据层：关键指标与账号健康度分析",
            validate_final_report(quoted, bundle, batches),
        )

        fenced = markdown.replace(
            "## 数据层：关键指标与账号健康度分析",
            "```\n## 数据层：关键指标与账号健康度分析\n```",
            1,
        )
        self.assertIn(
            "missing_section:数据层：关键指标与账号健康度分析",
            validate_final_report(fenced, bundle, batches),
        )

    def test_final_validation_enforces_fixed_third_level_structure(self) -> None:
        bundle = evidence_bundle()
        batches = valid_batches()
        markdown = assemble_report(bundle, batches)

        cases = (
            (
                markdown.replace("### 选题方向", "", 1),
                "missing_subsection:选题方向",
            ),
            (
                markdown.replace("### 选题方向", "### 选题改名", 1),
                "missing_subsection:选题方向",
            ),
            (
                markdown.replace("### 拍法模板", "### 选题方向\n### 拍法模板", 1),
                "duplicate_subsection:选题方向",
            ),
            (
                markdown.replace("### 选题方向", "### 临时", 1).replace(
                    "### 拍法模板",
                    "### 选题方向",
                    1,
                ).replace("### 临时", "### 拍法模板", 1),
                "subsection_out_of_order:对标建议",
            ),
            (
                markdown.replace("### 第 1 天", "", 1),
                "missing_execution_day:1",
            ),
            (
                markdown.replace("### 第 1 天", "### 第一天", 1),
                "missing_execution_day:1",
            ),
            (
                markdown.replace("### 第 2 天", "### 第 1 天\n### 第 2 天", 1),
                "duplicate_execution_day:1",
            ),
            (
                markdown.replace("### 第 1 天", "### 临时天", 1).replace(
                    "### 第 2 天",
                    "### 第 1 天",
                    1,
                ).replace("### 临时天", "### 第 2 天", 1),
                "execution_days_out_of_order",
            ),
            (
                "### 第 1 天\n" + markdown,
                "execution_day_outside_section:1",
            ),
        )
        for tampered, error in cases:
            with self.subTest(error=error):
                self.assertIn(
                    error,
                    validate_final_report(tampered, bundle, batches),
                )

    def test_final_validation_detects_medical_compliance_leaks(self) -> None:
        bundle = evidence_bundle()
        batches = valid_batches()
        markdown = assemble_report(bundle, batches)

        unsafe = markdown + "\n该方法保证有效并可以停药。\n"

        errors = validate_final_report(unsafe, bundle, batches)
        self.assertIn("medical_compliance_violation:保证有效", errors)
        self.assertIn("medical_compliance_violation:停药", errors)

        for chinese_claim in (
            "该账号已有九十九万互动",
            "九千九百次互动",
            "九千九百个点赞",
        ):
            with self.subTest(chinese_claim=chinese_claim):
                chinese_number = markdown + f"\n{chinese_claim}。\n"
                self.assertIn(
                    "untrusted_numeric_claim",
                    " ".join(
                        validate_final_report(
                            chinese_number,
                            bundle,
                            batches,
                        )
                    ),
                )

        for safe_warning in (
            "不要宣称保证有效",
            "不得使用‘保证有效’",
            "不建议停药",
            "不要 宣称“保证有效”",
            "不得使用 “保证有效”",
            "不得使用：“保证有效”",
        ):
            with self.subTest(safe_warning=safe_warning):
                safe_markdown = markdown + f"\n{safe_warning}\n"
                self.assertNotIn(
                    "medical_compliance_violation",
                    " ".join(validate_final_report(safe_markdown, bundle, batches)),
                )

        for unsafe_warning in (
            "不得不保证有效",
            "不能不保证有效",
            "并非不能保证有效",
            "不得不说这个方法保证有效",
            "并非不应宣称保证有效",
            "不是不能保证有效",
            "不等于不得使用保证有效",
            "并非不建议停药",
        ):
            with self.subTest(unsafe_warning=unsafe_warning):
                unsafe_markdown = markdown + f"\n{unsafe_warning}\n"
                self.assertIn(
                    "medical_compliance_violation",
                    " ".join(
                        validate_final_report(
                            unsafe_markdown,
                            bundle,
                            batches,
                        )
                    ),
                )


if __name__ == "__main__":
    unittest.main()
