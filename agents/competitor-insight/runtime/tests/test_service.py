import io
import json
from pathlib import Path
import re
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from openpyxl import Workbook


RUNTIME_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME_DIR))

import service


def workbook_bytes(nickname: str = "测试账号") -> bytes:
    workbook = Workbook()
    overview = workbook.active
    overview.title = "账号概览"
    overview.append(["昵称", nickname])
    overview.append(["粉丝数", 100])
    works = workbook.create_sheet("作品数据")
    works.append(["标题", "点赞", "评论", "收藏", "分享", "发布时间", "链接"])
    works.append(["第一条作品", 20, 2, 3, 1, "2026-07-01 10:00:00", "https://example.com/1"])
    output = io.BytesIO()
    workbook.save(output)
    workbook.close()
    return output.getvalue()


def valid_batches(evidence_id: str = "DY-E0001") -> list[dict[str, object]]:
    empty = {
        "claims": [],
        "topicDirections": [],
        "filmingTemplates": [],
        "conversionItems": [],
        "executionDays": [],
    }
    topics = [
        {
            "title": f"方向{label}",
            "angle": "从标题结构切入",
            "evidenceIds": [evidence_id],
            "complianceNotes": ["不承诺疗效"],
        }
        for label in ("一", "二", "三", "四", "五")
    ]
    templates = [
        {
            "name": f"模板{label}",
            "hook": "用生活场景自然开场",
            "structure": ["提出日常问题", "给出管理提醒"],
            "evidenceIds": [evidence_id],
            "complianceNotes": ["不替代医生建议"],
        }
        for label in ("一", "二", "三")
    ]
    days = [
        {
            "day": day,
            "action": "整理素材并完成发布复盘",
            "evidenceIds": [evidence_id],
            "complianceNotes": ["避免夸大宣传"],
        }
        for day in range(1, 8)
    ]
    return [
        {"batchId": "strategy", **empty},
        {"batchId": "performance", **empty},
        {
            "batchId": "execution",
            "claims": [],
            "topicDirections": topics,
            "filmingTemplates": templates,
            "conversionItems": [
                {
                    "action": "提供健康档案和用药提醒服务",
                    "evidenceIds": [evidence_id],
                    "complianceNotes": ["不替代诊疗"],
                }
            ],
            "executionDays": days,
        },
    ]


class ServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = TemporaryDirectory()
        self.project_root = Path(self.temporary_directory.name)
        self.project_patch = patch.object(service, "PROJECT_ROOT", self.project_root)
        self.project_patch.start()

    def tearDown(self) -> None:
        self.project_patch.stop()
        self.temporary_directory.cleanup()

    def _douyin_root(self) -> Path:
        path = self.project_root / "outputs" / "competitor-insight" / "douyin"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def test_rejects_paths_outside_the_controlled_douyin_directory(self) -> None:
        outside = self.project_root / "private.xlsx"
        outside.write_bytes(workbook_bytes())

        with self.assertRaisesRegex(ValueError, "path_outside_douyin_output"):
            service.analyze_path(str(outside))
        with self.assertRaisesRegex(ValueError, "path_outside_douyin_output"):
            service.analyze_path(str(self._douyin_root() / ".." / ".." / "private.xlsx"))

    def test_rejects_a_symlink_before_resolving_its_external_target(self) -> None:
        outside = self.project_root / "private.xlsx"
        outside.write_bytes(workbook_bytes())
        link = self._douyin_root() / "linked.xlsx"
        link.symlink_to(outside)

        with self.assertRaisesRegex(ValueError, "symlink_not_allowed"):
            service.analyze_path(str(link))

    def test_rejects_invalid_upload_extension_signature_and_excel_size(self) -> None:
        valid = workbook_bytes()

        with self.assertRaisesRegex(ValueError, "invalid_xlsx_signature"):
            service.analyze_upload("fake.xlsx", b"not-a-zip")
        with self.assertRaisesRegex(ValueError, "invalid_extension"):
            service.analyze_upload("fake.xls", valid)
        with patch.object(service, "MAX_EXCEL_BYTES", len(valid) - 1):
            with self.assertRaisesRegex(ValueError, "excel_too_large"):
                service.analyze_upload("large.xlsx", valid)

    def test_upload_persists_only_id_named_evidence_and_removes_temporary_copy(self) -> None:
        result = service.analyze_upload("sample.xlsx", workbook_bytes())

        evidence_id = result["evidenceId"]
        evidence_path = (
            self.project_root
            / "outputs"
            / "competitor-insight"
            / "reports"
            / "evidence"
            / f"{evidence_id}.json"
        )
        self.assertRegex(str(evidence_id), r"^[0-9a-f]{16}$")
        self.assertTrue(evidence_path.is_file())
        self.assertEqual(json.loads(evidence_path.read_text(encoding="utf-8"))["evidenceId"], evidence_id)
        temporary_root = evidence_path.parents[1] / ".tmp"
        self.assertEqual(list(temporary_root.iterdir()), [])
        self.assertEqual(result["stage"], "evidence_ready")
        self.assertEqual(result["account"]["nickname"], "测试账号")

    def test_analyze_path_reads_without_modifying_the_original_workbook(self) -> None:
        workbook_path = self._douyin_root() / "account.xlsx"
        before = workbook_bytes()
        workbook_path.write_bytes(before)

        result = service.analyze_path(str(workbook_path))

        self.assertEqual(workbook_path.read_bytes(), before)
        self.assertEqual(result["stage"], "evidence_ready")

    def test_validate_batch_loads_the_controlled_evidence_file_on_every_call(self) -> None:
        result = service.analyze_upload("sample.xlsx", workbook_bytes())
        evidence_id = str(result["evidenceId"])
        batch = valid_batches()[0]

        validated = service.validate_batch(evidence_id, batch)
        self.assertEqual(validated["batch"]["batchId"], "strategy")

        evidence_path = (
            self.project_root
            / "outputs"
            / "competitor-insight"
            / "reports"
            / "evidence"
            / f"{evidence_id}.json"
        )
        evidence_path.write_text("{}\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "invalid_evidence_bundle"):
            service.validate_batch(evidence_id, batch)

    def test_rejects_uncontrolled_evidence_ids_and_filename_mismatches(self) -> None:
        with self.assertRaisesRegex(ValueError, "invalid_evidence_id"):
            service.validate_batch("../outside", valid_batches()[0])

        evidence_root = (
            self.project_root / "outputs" / "competitor-insight" / "reports" / "evidence"
        )
        evidence_root.mkdir(parents=True)
        evidence_root.joinpath("0123456789abcdef.json").write_text(
            json.dumps({"evidenceId": "fedcba9876543210"}),
            encoding="utf-8",
        )
        with self.assertRaisesRegex(ValueError, "invalid_evidence_bundle"):
            service.validate_batch("0123456789abcdef", valid_batches()[0])

    def test_assembles_three_validated_batches_and_writes_a_safe_timestamped_report(self) -> None:
        result = service.analyze_upload("sample.xlsx", workbook_bytes("../../坏/账号"))
        evidence_id = str(result["evidenceId"])

        artifact = service.assemble(evidence_id, valid_batches())

        report_path = Path(str(artifact["reportPath"]))
        reports_root = (
            self.project_root / "outputs" / "competitor-insight" / "reports"
        ).resolve()
        self.assertEqual(report_path.parent, reports_root)
        self.assertTrue(report_path.is_file())
        self.assertNotIn("..", report_path.name)
        self.assertNotIn("/", report_path.name)
        self.assertTrue(
            re.fullmatch(
                r"坏_账号_抖音账号分析报告_\d{8}_\d{6}\.md",
                report_path.name,
            )
        )
        self.assertEqual(artifact["validationErrors"], [])
        self.assertEqual(artifact["stage"], "report_ready")
        self.assertEqual(report_path.read_text(encoding="utf-8"), artifact["markdown"])

    def test_assemble_requires_exactly_one_of_each_batch(self) -> None:
        result = service.analyze_upload("sample.xlsx", workbook_bytes())
        evidence_id = str(result["evidenceId"])
        batches = valid_batches()

        with self.assertRaisesRegex(ValueError, "missing_batch_id:performance"):
            service.assemble(evidence_id, [batches[0], batches[2]])
        with self.assertRaisesRegex(ValueError, "duplicate_batch_id:strategy"):
            service.assemble(evidence_id, [batches[0], batches[0], batches[2]])


if __name__ == "__main__":
    unittest.main()
