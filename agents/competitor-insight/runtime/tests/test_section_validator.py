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


def recommendation_batch() -> dict[str, object]:
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
        "batchId": "recommendations",
        "claims": [
            {
                "statement": "该内容角度可作为待验证方向",
                "strength": "hypothesis",
                "evidenceIds": ["DY-E0001"],
                "rationale": "标题呈现了可复用的生活场景",
                "verificationPlan": "先小范围测试并复盘",
            }
        ],
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


class SectionValidatorTests(unittest.TestCase):
    def test_rejects_unknown_evidence_id(self) -> None:
        batch = {
            "batchId": "strategy",
            "claims": [
                {
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
                batch = recommendation_batch()
                mutate(batch)
                with self.assertRaisesRegex(ValueError, error):
                    validate_section_batch(batch, evidence_bundle())

    def test_requires_each_recommendation_to_reference_top_or_startup_evidence(self) -> None:
        batch = recommendation_batch()
        batch["topicDirections"][0]["evidenceIds"] = ["DY-E0002"]
        bundle = evidence_bundle()
        bundle["rankings"]["overall"]["rows"] = [12]
        bundle["rankings"]["startup"]["rows"] = []

        with self.assertRaisesRegex(ValueError, "recommendation_requires_ranked_evidence"):
            validate_section_batch(batch, bundle)

    def test_rejects_untrusted_numbers_but_allows_fixed_structure_numbers_and_years(self) -> None:
        batch = recommendation_batch()
        batch["claims"][0]["statement"] = "2026年先测2-3条，开场控制在3秒，连续7天准备5个方向"
        validate_section_batch(batch, evidence_bundle())

        batch["claims"][0]["statement"] = "该作品获得999999次互动"
        with self.assertRaisesRegex(ValueError, "untrusted_numeric_claim"):
            validate_section_batch(batch, evidence_bundle())

    def test_rejects_medical_marketing_claims(self) -> None:
        batch = recommendation_batch()
        batch["claims"][0]["statement"] = "该方法保证有效并可以停药"

        with self.assertRaisesRegex(ValueError, "medical_compliance_violation"):
            validate_section_batch(batch, evidence_bundle())

    def test_returns_a_detached_normalized_batch(self) -> None:
        batch = recommendation_batch()
        original = deepcopy(batch)

        normalized = validate_section_batch(batch, evidence_bundle())

        self.assertEqual(batch, original)
        self.assertEqual(normalized["batchId"], "recommendations")
        self.assertIsNot(normalized, batch)


if __name__ == "__main__":
    unittest.main()
