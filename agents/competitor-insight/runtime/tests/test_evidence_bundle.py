import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest


RUNTIME_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME_DIR))

from evidence_bundle import build_evidence_bundle, write_evidence_bundle


class EvidenceBundleTests(unittest.TestCase):
    def _parsed(self) -> dict[str, object]:
        return {
            "account": {"nickname": "测试账号", "followers": 100},
            "fieldMap": {"title": "标题", "likes": "点赞"},
            "missingFields": ["shares", "url"],
            "warnings": ["missing_metric:shares:row=9", "missing_metric:url:row=2"],
            "works": [
                {"sourceRow": 9, "title": "第二行", "likes": 7, "comments": 1, "collects": 2, "shares": 0, "publishedAt": "2026-01-02T00:00:00", "url": "https://example.com/9"},
                {"sourceRow": 2, "title": "第一行", "likes": 20, "comments": 2, "collects": 3, "shares": 0, "publishedAt": "2026-01-01T00:00:00", "url": "https://example.com/2"},
            ],
        }

    def test_builds_stable_bundle_and_numbers_items_by_excel_source_row(self) -> None:
        parsed = self._parsed()
        source = {"kind": "upload", "name": "sample.xlsx"}

        bundle_a = build_evidence_bundle(parsed, source)
        bundle_b = build_evidence_bundle(parsed, source)

        self.assertEqual(bundle_a["evidenceId"], bundle_b["evidenceId"])
        self.assertEqual(
            [item["evidenceId"] for item in bundle_a["items"]],
            [item["evidenceId"] for item in bundle_b["items"]],
        )
        self.assertEqual(bundle_a["items"][0]["evidenceId"], "DY-E0001")
        self.assertEqual(bundle_a["items"][0]["sourceRow"], 2)
        self.assertEqual(bundle_a["evidenceVersion"], "2.0")
        self.assertEqual(bundle_a["reportType"], "douyin-account")
        self.assertEqual(bundle_a["subject"]["nickname"], "测试账号")
        self.assertEqual(bundle_a["metrics"]["top10InteractionShare"], 1.0)
        self.assertEqual(bundle_a["items"][0]["ranks"]["overall"], 1)

    def test_writes_canonical_json_without_mutating_input_order(self) -> None:
        bundle = build_evidence_bundle(self._parsed(), {"kind": "upload", "name": "sample.xlsx"})
        with TemporaryDirectory() as directory:
            output_path = write_evidence_bundle(bundle, Path(directory))
            loaded = json.loads(output_path.read_text(encoding="utf-8"))

        self.assertTrue(output_path.name.endswith("_证据包.json"))
        self.assertEqual(loaded, bundle)

    def test_canonicalizes_reordered_input_for_bundle_id_and_json_output(self) -> None:
        parsed_a = self._parsed()
        parsed_b = self._parsed()
        parsed_b["works"].reverse()
        parsed_b["missingFields"].reverse()
        parsed_b["warnings"].reverse()
        source = {"kind": "upload", "name": "sample.xlsx"}

        bundle_a = build_evidence_bundle(parsed_a, source)
        bundle_b = build_evidence_bundle(parsed_b, source)

        self.assertEqual(bundle_a, bundle_b)
        self.assertEqual(bundle_a["evidenceId"], bundle_b["evidenceId"])
        with TemporaryDirectory() as directory:
            output_a = write_evidence_bundle(bundle_a, Path(directory) / "a")
            output_b = write_evidence_bundle(bundle_b, Path(directory) / "b")
            self.assertEqual(output_a.read_text(encoding="utf-8"), output_b.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
