import json
import sys
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator


RUNTIME_DIR = Path(__file__).resolve().parents[1]
REPORTING_DIR = RUNTIME_DIR.parent / "reporting"
sys.path.insert(0, str(RUNTIME_DIR))

from contracts import validate_contract_shape


class ContractTests(unittest.TestCase):
    def load_section_batch_schema(self):
        with (REPORTING_DIR / "section-batch.schema.json").open(encoding="utf-8") as file:
            return json.load(file)

    def claim(self, section):
        return {
            "section": section,
            "statement": "测试判断",
            "strength": "direct",
            "evidenceIds": ["DY-E0001"],
            "rationale": "由证据字段直接支持",
        }

    def valid_section_batch(self, batch_id="execution"):
        evidence_ids = ["DY-E0001"]
        compliance_notes = ["不作疗效承诺"]
        batch = {
            "batchId": batch_id,
            "claims": [],
            "topicDirections": [],
            "filmingTemplates": [],
            "conversionItems": [],
            "executionDays": [],
        }
        if batch_id == "strategy":
            batch["claims"] = [self.claim("strategy"), self.claim("business"), self.claim("content")]
        elif batch_id == "performance":
            batch["claims"] = [self.claim("traffic"), self.claim("data")]
        elif batch_id == "execution":
            batch["topicDirections"] = [
                {
                    "title": f"选题 {index}",
                    "angle": "生活方式提醒",
                    "evidenceIds": evidence_ids,
                    "complianceNotes": compliance_notes,
                }
                for index in range(1, 6)
            ]
            batch["filmingTemplates"] = [
                {
                    "name": f"拍法 {index}",
                    "hook": "先讲观察",
                    "structure": ["证据", "建议"],
                    "evidenceIds": evidence_ids,
                    "complianceNotes": compliance_notes,
                }
                for index in range(1, 4)
            ]
            batch["executionDays"] = [
                {
                    "day": index,
                    "action": f"执行动作 {index}",
                    "evidenceIds": evidence_ids,
                    "complianceNotes": compliance_notes,
                }
                for index in range(1, 8)
            ]
        return batch

    def test_contract_rejects_missing_required_key(self):
        with self.assertRaisesRegex(ValueError, "missing_keys:evidenceId"):
            validate_contract_shape({"title": "测试作品"}, {"evidenceId", "title"})

    def test_contract_returns_plain_mapping(self):
        result = validate_contract_shape(
            {"evidenceId": "DY-E0001", "title": "测试作品"},
            {"evidenceId", "title"},
        )
        self.assertEqual(result["evidenceId"], "DY-E0001")

    def test_section_batch_schema_requires_closed_root_and_valid_evidence(self):
        schema = self.load_section_batch_schema()

        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(
            schema["$defs"]["claim"]["properties"]["strength"]["enum"],
            ["direct", "weak", "hypothesis"],
        )
        self.assertEqual(
            schema["properties"]["batchId"]["enum"],
            ["strategy", "performance", "execution"],
        )
        self.assertIn("section", schema["$defs"]["claim"]["required"])
        for conditional in schema["$defs"]["claim"]["allOf"]:
            self.assertIn("strength", conditional["if"]["required"])
        self.assertEqual(
            schema["$defs"]["evidenceIds"]["type"],
            "array",
        )
        self.assertEqual(
            schema["$defs"]["evidenceIds"]["minItems"],
            1,
        )
        self.assertEqual(
            schema["$defs"]["evidenceIds"]["items"],
            {"type": "string", "minLength": 1},
        )

    def test_section_batch_schema_accepts_exact_fixed_deliverables(self):
        validator = Draft202012Validator(self.load_section_batch_schema())

        for batch_id in ("strategy", "performance", "execution"):
            with self.subTest(batch_id=batch_id):
                self.assertEqual(
                    list(validator.iter_errors(self.valid_section_batch(batch_id))),
                    [],
                )

    def test_section_batch_schema_rejects_wrong_batch_sections_and_non_applicable_arrays(self):
        validator = Draft202012Validator(self.load_section_batch_schema())
        cases = {
            "unknown_batch": lambda batch: batch.__setitem__("batchId", "content-plan"),
            "strategy_wrong_section": lambda batch: batch["claims"][0].__setitem__("section", "traffic"),
            "strategy_has_topics": lambda batch: batch["topicDirections"].append(
                self.valid_section_batch("execution")["topicDirections"][0]
            ),
            "missing_claim_section": lambda batch: batch["claims"][0].pop("section"),
        }
        for name, mutate in cases.items():
            with self.subTest(name=name):
                batch = self.valid_section_batch("strategy")
                mutate(batch)
                self.assertNotEqual(list(validator.iter_errors(batch)), [])

    def test_section_batch_schema_rejects_incomplete_execution_deliverables(self):
        validator = Draft202012Validator(self.load_section_batch_schema())
        cases = {
            "four_topic_directions": lambda batch: batch["topicDirections"].pop(),
            "two_filming_templates": lambda batch: batch["filmingTemplates"].pop(),
            "duplicate_execution_day": lambda batch: batch["executionDays"].__setitem__(
                6, {**batch["executionDays"][6], "day": 6}
            ),
            "execution_claim": lambda batch: batch["claims"].append(self.claim("strategy")),
            "empty_compliance_notes": lambda batch: batch["topicDirections"][0].__setitem__(
                "complianceNotes", []
            ),
        }

        for name, mutate in cases.items():
            with self.subTest(name=name):
                batch = self.valid_section_batch("execution")
                mutate(batch)
                self.assertNotEqual(list(validator.iter_errors(batch)), [])


if __name__ == "__main__":
    unittest.main()
