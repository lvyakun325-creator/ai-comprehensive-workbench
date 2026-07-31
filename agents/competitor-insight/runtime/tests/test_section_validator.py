from copy import deepcopy
from pathlib import Path
import sys
import unittest


RUNTIME_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME_DIR))

from section_validator import validate_section_batch


def evidence_bundle() -> dict[str, object]:
    return {
        "evidenceVersion": "1.0",
        "evidenceId": "fixture-bundle",
        "account": {"nickname": "测试账号", "followers": 3210},
        "completeness": {
            "fieldMap": {},
            "missingFields": [],
            "warnings": [],
            "availability": {"comments": True, "collects": True, "shares": True},
        },
        "metrics": {
            "workCount": 2,
            "averageLikes": 6500.0,
            "averageComments": 170.0,
            "averageCollects": 450.0,
            "averageShares": 115.0,
            "averageInteractions": 7235.0,
            "maxInteractions": 13390,
            "aboveAverageInteractionCount": 1,
            "top10InteractionShare": 1.0,
            "maxToAverageMultiple": 1.85,
        },
        "rankings": {
            "overall": {"status": "available", "rows": [12, 18]},
            "startup": {"status": "available", "rows": [18], "sampleRows": [18]},
            "collect": {"status": "available", "rows": [12, 18]},
            "share": {"status": "available", "rows": [12, 18]},
            "comment": {"status": "available", "rows": [12, 18]},
        },
        "items": [
            {
                "evidenceId": "DY-E0001",
                "sourceRow": 12,
                "title": "作品一",
                "likes": 12000,
                "comments": 320,
                "collects": 860,
                "shares": 210,
                "totalInteractions": 13390,
                "publishedAt": "2026-07-01 10:00:00",
                "url": "https://example.com/1",
                "ranks": {"overall": 1, "startup": None, "collect": 1, "share": 1, "comment": 1},
            },
            {
                "evidenceId": "DY-E0002",
                "sourceRow": 18,
                "title": "作品二",
                "likes": 1000,
                "comments": 20,
                "collects": 40,
                "shares": 20,
                "totalInteractions": 1080,
                "publishedAt": "2026-07-02 10:00:00",
                "url": "https://example.com/2",
                "ranks": {"overall": 2, "startup": 1, "collect": 2, "share": 2, "comment": 2},
            },
        ],
    }


def execution_batch() -> dict[str, object]:
    labels = ["一", "二", "三", "四", "五"]
    topics = [
        {
            "title": f"方向{labels[index]}",
            "angle": "从标题结构切入",
            "evidenceIds": ["DY-E0001"],
            "complianceNotes": ["不承诺疗效"],
        }
        for index in range(5)
    ]
    template_labels = ["一", "二", "三"]
    templates = [
        {
            "name": f"模板{template_labels[index]}",
            "hook": "用生活场景自然开场",
            "structure": ["提出日常问题", "给出管理提醒"],
            "evidenceIds": ["DY-E0001"],
            "complianceNotes": ["不替代医生建议"],
        }
        for index in range(3)
    ]
    days = [
        {
            "day": day,
            "action": "整理素材并完成发布复盘",
            "evidenceIds": ["DY-E0001"],
            "complianceNotes": ["避免夸大宣传"],
        }
        for day in range(1, 8)
    ]
    return {
        "batchId": "execution",
        "claims": [],
        "topicDirections": topics,
        "filmingTemplates": templates,
        "conversionItems": [
            {
                "action": "提供健康档案和用药提醒服务",
                "evidenceIds": ["DY-E0001"],
                "complianceNotes": ["不替代诊疗"],
            }
        ],
        "executionDays": days,
    }


def strategy_batch() -> dict[str, object]:
    return {
        "batchId": "strategy",
        "claims": [
            {
                "section": "strategy",
                "statement": "标题结构呈现生活化表达",
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


class SectionValidatorTests(unittest.TestCase):
    def test_rejects_unknown_evidence_id(self) -> None:
        batch = {
            "batchId": "strategy",
            "claims": [
                {
                    "section": "strategy",
                    "statement": "测试判断",
                    "strength": "direct",
                    "evidenceIds": ["DY-E9999"],
                    "rationale": "直接来自作品标题",
                }
            ],
            "topicDirections": [],
            "filmingTemplates": [],
            "conversionItems": [],
            "executionDays": [],
        }

        with self.assertRaisesRegex(ValueError, "unknown_evidence_id"):
            validate_section_batch(batch, evidence_bundle())

    def test_requires_explanation_and_verification_for_weak_or_hypothesis_claims(self) -> None:
        for strength, error in (
            ("weak", "weak_claim_requires_label"),
            ("hypothesis", "hypothesis_claim_requires_label"),
        ):
            with self.subTest(strength=strength):
                batch = {
                    "batchId": "strategy",
                    "claims": [
                        {
                            "section": "strategy",
                            "statement": "这是有限证据下的判断",
                            "strength": strength,
                            "evidenceIds": ["DY-E0001"],
                            "rationale": "仅依据标题与互动结构",
                        }
                    ],
                    "topicDirections": [],
                    "filmingTemplates": [],
                    "conversionItems": [],
                    "executionDays": [],
                }
                with self.assertRaisesRegex(ValueError, error):
                    validate_section_batch(batch, evidence_bundle())

    def test_rejects_incomplete_fixed_recommendation_outputs(self) -> None:
        mutations = (
            ("topicDirections", lambda batch: batch["topicDirections"].pop(), "topic_directions_must_equal_5"),
            ("filmingTemplates", lambda batch: batch["filmingTemplates"].pop(), "filming_templates_must_equal_3"),
            ("executionDays", lambda batch: batch["executionDays"].pop(), "execution_days_must_cover_1_to_7"),
        )
        for name, mutate, error in mutations:
            with self.subTest(name=name):
                batch = execution_batch()
                mutate(batch)
                with self.assertRaisesRegex(ValueError, error):
                    validate_section_batch(batch, evidence_bundle())

    def test_requires_each_recommendation_to_reference_top_or_startup_evidence(self) -> None:
        batch = execution_batch()
        batch["topicDirections"][0]["evidenceIds"] = ["DY-E0002"]
        bundle = evidence_bundle()
        bundle["rankings"]["overall"]["rows"] = [12]
        bundle["rankings"]["startup"]["rows"] = []

        with self.assertRaisesRegex(ValueError, "recommendation_requires_ranked_evidence"):
            validate_section_batch(batch, bundle)

    def test_rejects_untrusted_numbers_but_allows_fixed_structure_numbers_and_years(self) -> None:
        batch = strategy_batch()
        batch["claims"][0]["statement"] = "2026年先测2-3条，开场控制在3秒，连续7天准备5个方向"
        validate_section_batch(batch, evidence_bundle())

        batch["claims"][0]["statement"] = "该作品获得999999次互动"
        with self.assertRaisesRegex(ValueError, "untrusted_numeric_claim"):
            validate_section_batch(batch, evidence_bundle())

        batch["claims"][0]["statement"] = "该作品获得2026次互动"
        with self.assertRaisesRegex(ValueError, "untrusted_numeric_claim"):
            validate_section_batch(batch, evidence_bundle())

    def test_rejects_medical_marketing_claims(self) -> None:
        batch = strategy_batch()
        batch["claims"][0]["statement"] = "该方法保证有效并可以停药"

        with self.assertRaisesRegex(ValueError, "medical_compliance_violation"):
            validate_section_batch(batch, evidence_bundle())

    def test_returns_a_detached_normalized_batch(self) -> None:
        batch = execution_batch()
        original = deepcopy(batch)

        normalized = validate_section_batch(batch, evidence_bundle())

        self.assertEqual(batch, original)
        self.assertEqual(normalized["batchId"], "execution")
        self.assertIsNot(normalized, batch)

    def test_enforces_three_batch_contract_and_section_ownership(self) -> None:
        cases = (
            ({**strategy_batch(), "batchId": "traffic"}, "invalid_batch_id"),
            (
                {
                    **strategy_batch(),
                    "topicDirections": execution_batch()["topicDirections"],
                },
                "non_applicable_fields_must_be_empty",
            ),
        )
        for batch, error in cases:
            with self.subTest(error=error):
                with self.assertRaisesRegex(ValueError, error):
                    validate_section_batch(batch, evidence_bundle())

        wrong_section = strategy_batch()
        wrong_section["claims"][0]["section"] = "traffic"
        with self.assertRaisesRegex(ValueError, "claim_section_not_allowed"):
            validate_section_batch(wrong_section, evidence_bundle())

        execution = execution_batch()
        execution["claims"] = strategy_batch()["claims"]
        with self.assertRaisesRegex(ValueError, "execution_claims_must_be_empty"):
            validate_section_batch(execution, evidence_bundle())

    def test_rejects_empty_required_compliance_notes(self) -> None:
        batch = execution_batch()
        batch["topicDirections"][0]["complianceNotes"] = []

        with self.assertRaisesRegex(ValueError, "invalid_compliance_notes"):
            validate_section_batch(batch, evidence_bundle())

        claim_batch = strategy_batch()
        claim_batch["claims"][0]["complianceNotes"] = []
        with self.assertRaisesRegex(ValueError, "invalid_compliance_notes"):
            validate_section_batch(claim_batch, evidence_bundle())

    def test_rejects_chinese_numeric_claims_and_double_negative_medical_claims(self) -> None:
        ordinary = strategy_batch()
        ordinary["claims"][0]["statement"] = "第一批做内容，一次只讲一个问题"
        validate_section_batch(ordinary, evidence_bundle())

        for statement in (
            "点赞九千九百",
            "互动九十九",
            "占比百分之九十",
            "该作品已有九十九万",
        ):
            with self.subTest(statement=statement):
                chinese_number = strategy_batch()
                chinese_number["claims"][0]["statement"] = statement
                with self.assertRaisesRegex(ValueError, "untrusted_numeric_claim"):
                    validate_section_batch(chinese_number, evidence_bundle())

        for statement in (
            "不要宣称保证有效",
            "不得使用‘保证有效’",
            "不建议停药",
        ):
            with self.subTest(safe_statement=statement):
                safe_warning = strategy_batch()
                safe_warning["claims"][0]["statement"] = statement
                validate_section_batch(safe_warning, evidence_bundle())

        for statement in (
            "不得不保证有效",
            "不能不保证有效",
            "并非不能保证有效",
            "不得不说这个方法保证有效",
        ):
            with self.subTest(unsafe_statement=statement):
                double_negative = strategy_batch()
                double_negative["claims"][0]["statement"] = statement
                with self.assertRaisesRegex(
                    ValueError,
                    "medical_compliance_violation:保证有效",
                ):
                    validate_section_batch(double_negative, evidence_bundle())


if __name__ == "__main__":
    unittest.main()
