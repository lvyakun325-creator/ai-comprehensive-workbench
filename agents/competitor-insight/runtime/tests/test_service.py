from concurrent.futures import ThreadPoolExecutor
from datetime import datetime as real_datetime
import io
import json
import os
from pathlib import Path
import re
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
import zipfile

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


def malformed_account_workbook_bytes() -> bytes:
    workbook = Workbook()
    overview = workbook.active
    overview.title = "账号概览"
    overview.append(["昵称"])
    works = workbook.create_sheet("作品数据")
    works.append(["标题", "点赞"])
    works.append(["仍有作品", 1])
    output = io.BytesIO()
    workbook.save(output)
    workbook.close()
    return output.getvalue()


def xlsx_with_compression_bomb() -> bytes:
    source = io.BytesIO(workbook_bytes())
    output = io.BytesIO()
    with zipfile.ZipFile(source) as original, zipfile.ZipFile(
        output,
        "w",
        compression=zipfile.ZIP_DEFLATED,
    ) as modified:
        for member in original.infolist():
            modified.writestr(member, original.read(member.filename))
        modified.writestr("xl/compression-bomb.bin", b"A" * (2 * 1024 * 1024))
    return output.getvalue()


def xlsx_with_member(member_name: str) -> bytes:
    source = io.BytesIO(workbook_bytes())
    output = io.BytesIO()
    with zipfile.ZipFile(source) as original, zipfile.ZipFile(
        output,
        "w",
        compression=zipfile.ZIP_DEFLATED,
    ) as modified:
        for member in original.infolist():
            modified.writestr(member, original.read(member.filename))
        modified.writestr(member_name, b"unexpected")
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

    def test_rejects_a_symlink_in_the_controlled_root_ancestry(self) -> None:
        external_outputs = self.project_root / "external-outputs"
        douyin = external_outputs / "competitor-insight" / "douyin"
        douyin.mkdir(parents=True)
        workbook_path = douyin / "account.xlsx"
        workbook_path.write_bytes(workbook_bytes())
        (self.project_root / "outputs").symlink_to(
            external_outputs,
            target_is_directory=True,
        )

        with self.assertRaisesRegex(ValueError, "symlink_not_allowed"):
            service.analyze_path(str(self.project_root / "outputs" / "competitor-insight" / "douyin" / "account.xlsx"))

    def test_reads_from_opened_snapshot_if_checked_path_is_swapped_for_a_symlink(self) -> None:
        workbook_path = self._douyin_root() / "account.xlsx"
        workbook_path.write_bytes(workbook_bytes("原始账号"))
        external = self.project_root / "outside.xlsx"
        external.write_bytes(workbook_bytes("外部账号"))
        real_reader = service.read_account_workbook
        swapped = False

        def swap_then_read(path: Path) -> dict[str, object]:
            nonlocal swapped
            if not swapped:
                workbook_path.unlink()
                workbook_path.symlink_to(external)
                swapped = True
            return real_reader(path)

        with patch.object(service, "read_account_workbook", side_effect=swap_then_read):
            result = service.analyze_path(str(workbook_path))

        self.assertEqual(result["account"]["nickname"], "原始账号")

    def test_rejects_file_swapped_to_symlink_between_lstat_and_open(self) -> None:
        workbook_path = self._douyin_root() / "account.xlsx"
        workbook_path.write_bytes(workbook_bytes())
        external = self.project_root / "outside.xlsx"
        external.write_bytes(workbook_bytes("外部账号"))
        real_open = os.open
        swapped = False

        def swap_before_open(
            path: str | Path,
            flags: int,
            mode: int = 0o777,
            *,
            dir_fd: int | None = None,
        ) -> int:
            nonlocal swapped
            if path == "account.xlsx" and dir_fd is not None and not swapped:
                workbook_path.unlink()
                workbook_path.symlink_to(external)
                swapped = True
            return real_open(path, flags, mode, dir_fd=dir_fd)

        with patch.object(service.os, "open", side_effect=swap_before_open):
            with self.assertRaisesRegex(ValueError, "symlink_not_allowed"):
                service.analyze_path(str(workbook_path))

    def test_fails_closed_for_ordinary_path_when_nofollow_is_zero(self) -> None:
        workbook_path = self._douyin_root() / "account.xlsx"
        workbook_path.write_bytes(workbook_bytes())

        with patch.object(service.os, "O_NOFOLLOW", 0):
            with self.assertRaisesRegex(ValueError, r"^secure_nofollow_unavailable$"):
                service.analyze_path(str(workbook_path))

    def test_fails_closed_before_path_swap_when_nofollow_is_missing(self) -> None:
        workbook_path = self._douyin_root() / "account.xlsx"
        workbook_path.write_bytes(workbook_bytes())
        external = self.project_root / "outside.xlsx"
        external.write_bytes(workbook_bytes("外部账号"))
        real_open = os.open

        def swap_if_opened(
            path: str | Path,
            flags: int,
            mode: int = 0o777,
            *,
            dir_fd: int | None = None,
        ) -> int:
            if path == "account.xlsx" and dir_fd is not None:
                workbook_path.unlink()
                workbook_path.symlink_to(external)
            return real_open(path, flags, mode, dir_fd=dir_fd)

        nofollow = service.os.O_NOFOLLOW
        delattr(service.os, "O_NOFOLLOW")
        try:
            with patch.object(service.os, "open", side_effect=swap_if_opened):
                with self.assertRaisesRegex(ValueError, r"^secure_nofollow_unavailable$"):
                    service.analyze_path(str(workbook_path))
        finally:
            service.os.O_NOFOLLOW = nofollow

    def test_fails_closed_when_nofollow_value_cannot_be_used(self) -> None:
        workbook_path = self._douyin_root() / "account.xlsx"
        workbook_path.write_bytes(workbook_bytes())

        with patch.object(service.os, "O_NOFOLLOW", 1 << 100):
            with self.assertRaisesRegex(ValueError, r"^secure_nofollow_unavailable$"):
                service.analyze_path(str(workbook_path))

    def test_rejects_invalid_upload_extension_signature_and_excel_size(self) -> None:
        valid = workbook_bytes()

        with self.assertRaisesRegex(ValueError, "invalid_xlsx_signature"):
            service.analyze_upload("fake.xlsx", b"not-a-zip")
        with self.assertRaisesRegex(ValueError, "invalid_extension"):
            service.analyze_upload("fake.xls", valid)
        with patch.object(service, "MAX_EXCEL_BYTES", len(valid) - 1):
            with self.assertRaisesRegex(ValueError, "excel_too_large"):
                service.analyze_upload("large.xlsx", valid)

    def test_rejects_high_expansion_xlsx_before_decompression(self) -> None:
        with self.assertRaisesRegex(ValueError, "xlsx_archive_too_large"):
            service.analyze_upload("bomb.xlsx", xlsx_with_compression_bomb())

    def test_rejects_backslash_parent_drive_and_unc_xlsx_member_paths(self) -> None:
        for member_name in (
            r"..\outside.txt",
            "xl/./hidden.txt",
            r"C:\outside.txt",
            r"\\server\share.txt",
        ):
            with self.subTest(member_name=member_name):
                with self.assertRaisesRegex(ValueError, "invalid_xlsx_signature"):
                    service.analyze_upload(
                        "unsafe-member.xlsx",
                        xlsx_with_member(member_name),
                    )

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

    def test_evidence_ready_returns_bounded_deterministic_batch_inputs(self) -> None:
        first = service.analyze_upload("sample.xlsx", workbook_bytes())
        second = service.analyze_upload("sample.xlsx", workbook_bytes())

        self.assertEqual(first["batchInputs"], second["batchInputs"])
        self.assertEqual(
            set(first["batchInputs"]),
            {"strategy", "performance", "execution"},
        )
        encoded = json.dumps(first["batchInputs"], ensure_ascii=False)
        self.assertLess(len(encoded.encode("utf-8")), 80_000)
        self.assertNotIn("sample.xlsx", encoded)
        self.assertNotIn("contentBase64", encoded)
        self.assertNotIn("reportPath", encoded)
        for batch_id, batch_input in first["batchInputs"].items():
            with self.subTest(batch_id=batch_id):
                self.assertGreater(len(batch_input["evidence"]), 0)
                self.assertEqual(
                    batch_input["evidence"][0]["evidenceId"],
                    "DY-E0001",
                )
                self.assertNotIn("url", batch_input["evidence"][0])
                self.assertNotIn("sourceRow", batch_input["evidence"][0])

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

    def test_same_second_parallel_reports_use_exclusive_distinct_filenames(self) -> None:
        result = service.analyze_upload("sample.xlsx", workbook_bytes())
        evidence_id = str(result["evidenceId"])
        frozen_datetime = unittest.mock.Mock()
        frozen_datetime.now.return_value = real_datetime(2026, 7, 31, 12, 0, 0)

        with patch.object(service, "datetime", frozen_datetime):
            with ThreadPoolExecutor(max_workers=2) as executor:
                artifacts = list(
                    executor.map(
                        lambda _index: service.assemble(evidence_id, valid_batches()),
                        range(2),
                    )
                )

        paths = [Path(str(artifact["reportPath"])) for artifact in artifacts]
        self.assertEqual(len(set(paths)), 2)
        self.assertTrue(any(path.name.endswith("_20260731_120000.md") for path in paths))
        self.assertTrue(any(path.name.endswith("_20260731_120000_01.md") for path in paths))
        for path, artifact in zip(paths, artifacts):
            self.assertEqual(path.read_text(encoding="utf-8"), artifact["markdown"])

    def test_unknown_workbook_value_error_is_normalized(self) -> None:
        with self.assertRaisesRegex(ValueError, r"^invalid_workbook$"):
            service.analyze_upload(
                "malformed.xlsx",
                malformed_account_workbook_bytes(),
            )


if __name__ == "__main__":
    unittest.main()
