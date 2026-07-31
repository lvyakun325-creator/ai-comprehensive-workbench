import json
import sys
import unittest
from pathlib import Path


RUNTIME_DIR = Path(__file__).resolve().parents[1]
REPORTING_DIR = RUNTIME_DIR.parent / "reporting"
sys.path.insert(0, str(RUNTIME_DIR))

from contracts import validate_contract_shape


class ContractTests(unittest.TestCase):
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
        with (REPORTING_DIR / "section-batch.schema.json").open(encoding="utf-8") as file:
            schema = json.load(file)

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


if __name__ == "__main__":
    unittest.main()
