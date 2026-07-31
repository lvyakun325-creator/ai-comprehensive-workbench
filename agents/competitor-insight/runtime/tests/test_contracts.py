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

    def valid_section_batch(self):
        evidence_ids = ["DY-E0001"]
        compliance_notes = ["不作疗效承诺"]
        return {
            "batchId": "content-plan",
            "claims": [],
            "topicDirections": [
                {
                    "title": f"选题 {index}",
                    "angle": "生活方式提醒",
                    "evidenceIds": evidence_ids,
                    "complianceNotes": compliance_notes,
                }
                for index in range(1, 6)
            ],
            "filmingTemplates": [
                {
                    "name": f"拍法 {index}",
                    "hook": "先讲观察",
                    "structure": ["证据", "建议"],
                    "evidenceIds": evidence_ids,
                    "complianceNotes": compliance_notes,
                }
                for index in range(1, 4)
            ],
            "conversionItems": [],
            "executionDays": [
                {
                    "day": index,
                    "action": f"执行动作 {index}",
                    "evidenceIds": evidence_ids,
                    "complianceNotes": compliance_notes,
                }
                for index in range(1, 8)
            ],
        }

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

        self.assertEqual(list(validator.iter_errors(self.valid_section_batch())), [])

    def test_section_batch_schema_rejects_incomplete_fixed_deliverables(self):
        validator = Draft202012Validator(self.load_section_batch_schema())
        cases = {
            "four_topic_directions": lambda batch: batch["topicDirections"].pop(),
            "two_filming_templates": lambda batch: batch["filmingTemplates"].pop(),
            "duplicate_execution_day": lambda batch: batch["executionDays"].__setitem__(
                6, {**batch["executionDays"][6], "day": 6}
            ),
        }

        for name, mutate in cases.items():
            with self.subTest(name=name):
                batch = self.valid_section_batch()
                mutate(batch)
                self.assertNotEqual(list(validator.iter_errors(batch)), [])


if __name__ == "__main__":
    unittest.main()
