from pathlib import Path
import sys
import unittest


RUNTIME_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME_DIR))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from report_renderer import assemble_report, render_evidence_reference, validate_final_report
from test_section_validator import evidence_bundle, recommendation_batch


def valid_batches() -> list[dict[str, object]]:
    strategy = {
        "batchId": "strategy",
        "claims": [
            {
                "statement": "<script>标题结构呈现生活化表达\n# 非法章节",
                "strength": "weak",
                "evidenceIds": ["DY-E0001"],
                "rationale": "仅依据标题与互动结构",
                "verificationPlan": "结合画面与评论进一步核验",
            }
        ],
        "topicDirections": [],
        "filmingTemplates": [],
        "conversionItems": [],
        "executionDays": [],
    }
    traffic = {
        "batchId": "traffic",
        "claims": [
            {
                "statement": "互动结构值得继续观察",
                "strength": "direct",
                "evidenceIds": ["DY-E0002"],
                "rationale": "由证据包字段直接支持",
            }
        ],
        "topicDirections": [],
        "filmingTemplates": [],
        "conversionItems": [],
        "executionDays": [],
    }
    return [strategy, traffic, recommendation_batch()]


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

    def test_renders_a_reference_only_from_the_bundle(self) -> None:
        reference = render_evidence_reference("DY-E0001", evidence_bundle())

        self.assertIn("DY-E0001", reference)
        self.assertIn("作品一", reference)
        self.assertIn("综合互动量：13,390", reference)
        self.assertIn("综合排名：1", reference)
        self.assertNotIn("999,999", reference)

    def test_final_validation_detects_missing_structure_unknown_evidence_and_number_leaks(self) -> None:
        bundle = evidence_bundle()
        markdown = assemble_report(bundle, valid_batches())

        self.assertEqual(validate_final_report(markdown, bundle), [])
        missing = markdown.replace("## 数据层：关键指标与账号健康度分析", "")
        self.assertIn("missing_section:数据层：关键指标与账号健康度分析", validate_final_report(missing, bundle))
        unknown = markdown + "\n引用 DY-E9999\n"
        self.assertIn("unknown_evidence_id:DY-E9999", validate_final_report(unknown, bundle))
        forged = markdown + "\n伪造互动：999,999\n"
        self.assertIn("untrusted_numeric_claim:999,999", validate_final_report(forged, bundle))

    def test_final_validation_detects_medical_compliance_leaks(self) -> None:
        bundle = evidence_bundle()
        markdown = assemble_report(bundle, valid_batches())

        unsafe = markdown + "\n该方法保证有效并可以停药。\n"

        errors = validate_final_report(unsafe, bundle)
        self.assertIn("medical_compliance_violation:保证有效", errors)
        self.assertIn("medical_compliance_violation:停药", errors)


if __name__ == "__main__":
    unittest.main()
