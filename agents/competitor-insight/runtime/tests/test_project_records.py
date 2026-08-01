import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
import zipfile


RUNTIME_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME_DIR))

import project_records


class ProjectRecordTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = TemporaryDirectory()
        self.project_root = Path(self.temporary_directory.name)
        self.original_project_root = project_records.PROJECT_ROOT
        project_records.PROJECT_ROOT = self.project_root
        self.store_path = (
            self.project_root
            / "outputs"
            / "competitor-insight"
            / ".workbench"
            / "project-records.json"
        )

    def tearDown(self) -> None:
        project_records.PROJECT_ROOT = self.original_project_root
        self.temporary_directory.cleanup()

    def task_payload(self, **overrides: object) -> dict[str, object]:
        payload: dict[str, object] = {
            "id": "competitor-20260801-a1",
            "agentId": "competitor-insight",
            "title": "小红书作品抓取",
            "platformId": "xiaohongshu",
            "platformLabel": "小红书",
            "skillId": "xiaohongshu-scraper",
            "sourceUrl": (
                "https://www.xiaohongshu.com/explore/abc"
                "?xsec_token=secret&source=feed"
            ),
            "model": "xiaohongshu-scraper",
        }
        payload.update(overrides)
        return payload

    def create_task(self, **overrides: object) -> dict[str, object]:
        return project_records.create_task(self.task_payload(**overrides))

    def test_create_task_persists_sanitized_public_link(self) -> None:
        task = self.create_task()

        self.assertEqual(
            task["sourceUrl"],
            "https://www.xiaohongshu.com/explore/abc",
        )
        self.assertEqual(task["status"], "waiting")
        self.assertEqual(task["progress"], 10)
        persisted = json.loads(self.store_path.read_text("utf-8"))
        self.assertEqual(persisted["schemaVersion"], 2)
        self.assertEqual(persisted["bundles"], [])
        self.assertNotIn("secret", json.dumps(persisted))
        self.assertEqual(list(self.store_path.parent.glob("*.tmp")), [])

    def test_sanitizer_keeps_public_identity_parameters_only(self) -> None:
        sanitized = project_records.sanitize_source_url(
            "https://www.douyin.com/user/example"
            "?modal_id=12345&share_token=secret&utm_source=chat#fragment"
        )

        self.assertEqual(
            sanitized,
            "https://www.douyin.com/user/example?modal_id=12345",
        )
        for unsafe in (
            "file:///tmp/private",
            "javascript:alert(1)",
            "https://user:password@example.com/path",
        ):
            with self.subTest(unsafe=unsafe):
                with self.assertRaisesRegex(ValueError, "invalid_source_url"):
                    project_records.sanitize_source_url(unsafe)

    def test_updates_progress_and_rejects_invalid_terminal_transition(self) -> None:
        self.create_task()

        running = project_records.update_task(
            "competitor-20260801-a1",
            {
                "status": "running",
                "progress": 60,
                "currentStep": "正在抓取平台数据",
            },
        )
        self.assertEqual(running["progress"], 60)
        self.assertEqual(running["currentStep"], "正在抓取平台数据")

        with self.assertRaisesRegex(ValueError, "invalid_status_transition"):
            project_records.update_task(
                "competitor-20260801-a1",
                {"status": "completed", "progress": 100, "currentStep": "成果已登记"},
            )
        failed = project_records.update_task(
            "competitor-20260801-a1", {"status": "failed"}
        )
        self.assertEqual(failed["status"], "failed")

        with self.assertRaisesRegex(ValueError, "invalid_status_transition"):
            project_records.update_task(
                "competitor-20260801-a1",
                {"status": "running", "progress": 30},
            )

    def test_register_artifacts_classifies_expected_files_and_directories(self) -> None:
        self.create_task()
        output = (
            self.project_root
            / "outputs"
            / "competitor-insight"
            / "xiaohongshu"
            / "run-a"
        )
        images = output / "images"
        images.mkdir(parents=True)
        (output / "result.xlsx").write_bytes(b"xlsx")
        (output / "result.md").write_text("# report", "utf-8")
        (output / "result.json").write_text("{}", "utf-8")
        (output / "ignore.txt").write_text("ignore", "utf-8")
        (images / "01.jpg").write_bytes(b"jpg")

        snapshot = project_records.register_artifacts(
            "competitor-20260801-a1",
            {"outputDir": str(output), "explicitPaths": []},
        )

        artifacts = snapshot["artifacts"]
        self.assertEqual(
            {item["kind"] for item in artifacts},
            {
                "excel",
                "image",
                "markdown",
                "json",
                "image-directory",
                "output-directory",
            },
        )
        self.assertTrue(all(item["exists"] for item in artifacts))
        self.assertNotIn("ignore.txt", {item["name"] for item in artifacts})
        task = snapshot["tasks"][0]
        self.assertEqual(set(task["artifactIds"]), {item["id"] for item in artifacts})

    def test_register_artifacts_merges_a_later_report_path(self) -> None:
        self.create_task(platformId="douyin", platformLabel="抖音")
        scrape_output = (
            self.project_root
            / "outputs"
            / "competitor-insight"
            / "douyin"
            / "run-a"
        )
        scrape_output.mkdir(parents=True)
        workbook = scrape_output / "account.xlsx"
        workbook.write_bytes(b"xlsx")
        project_records.register_artifacts(
            "competitor-20260801-a1",
            {"outputDir": str(scrape_output), "explicitPaths": [str(workbook)]},
        )
        report = (
            self.project_root
            / "outputs"
            / "competitor-insight"
            / "reports"
            / "account.md"
        )
        report.parent.mkdir(parents=True)
        report.write_text("# account", "utf-8")

        snapshot = project_records.register_artifacts(
            "competitor-20260801-a1",
            {"outputDir": str(scrape_output), "explicitPaths": [str(report)]},
        )

        self.assertEqual(
            {item["kind"] for item in snapshot["artifacts"]},
            {"excel", "markdown", "output-directory"},
        )

    def test_register_artifacts_excludes_older_files_from_shared_platform_root(self) -> None:
        self.create_task()
        output = (
            self.project_root
            / "outputs"
            / "competitor-insight"
            / "xiaohongshu"
        )
        output.mkdir(parents=True)
        old_file = output / "old-result.json"
        old_file.write_text("{}", "utf-8")
        os.utime(old_file, (1_700_000_000, 1_700_000_000))
        current_file = output / "current-result.json"
        current_file.write_text("{}", "utf-8")

        snapshot = project_records.register_artifacts(
            "competitor-20260801-a1",
            {"outputDir": str(output), "explicitPaths": []},
        )

        names = {item["name"] for item in snapshot["artifacts"]}
        self.assertIn("current-result.json", names)
        self.assertNotIn("old-result.json", names)

    def test_artifact_registration_rejects_outside_and_symlink_paths(self) -> None:
        self.create_task()
        outside = self.project_root / "private.xlsx"
        outside.write_bytes(b"private")
        with self.assertRaisesRegex(ValueError, "path_not_allowed"):
            project_records.register_artifacts(
                "competitor-20260801-a1",
                {"outputDir": str(outside.parent), "explicitPaths": []},
            )

        allowed = (
            self.project_root
            / "outputs"
            / "competitor-insight"
            / "xiaohongshu"
            / "run-a"
        )
        allowed.mkdir(parents=True)
        linked = allowed / "linked.xlsx"
        linked.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "symlink_not_allowed"):
            project_records.register_artifacts(
                "competitor-20260801-a1",
                {"outputDir": str(allowed), "explicitPaths": [str(linked)]},
            )

    def test_read_records_marks_deleted_files_missing_without_deleting_history(self) -> None:
        self.create_task()
        output = (
            self.project_root
            / "outputs"
            / "competitor-insight"
            / "douyin"
            / "run-a"
        )
        output.mkdir(parents=True)
        workbook = output / "account.xlsx"
        workbook.write_bytes(b"xlsx")
        snapshot = project_records.register_artifacts(
            "competitor-20260801-a1",
            {"outputDir": str(output), "explicitPaths": [str(workbook)]},
        )
        workbook_id = next(
            item["id"] for item in snapshot["artifacts"] if item["kind"] == "excel"
        )
        workbook.unlink()

        refreshed = project_records.read_records("competitor-insight")

        refreshed_workbook = next(
            item for item in refreshed["artifacts"] if item["id"] == workbook_id
        )
        self.assertFalse(refreshed_workbook["exists"])

    def test_reveal_uses_only_persisted_artifact_id_and_argument_array(self) -> None:
        self.create_task()
        output = (
            self.project_root
            / "outputs"
            / "competitor-insight"
            / "xiaohongshu"
            / "run-a"
        )
        output.mkdir(parents=True)
        snapshot = project_records.register_artifacts(
            "competitor-20260801-a1",
            {"outputDir": str(output), "explicitPaths": []},
        )
        artifact_id = next(
            item["id"]
            for item in snapshot["artifacts"]
            if item["kind"] == "output-directory"
        )
        calls: list[tuple[list[str], dict[str, object]]] = []

        result = project_records.reveal_artifact(
            artifact_id,
            runner=lambda argv, **kwargs: calls.append((argv, kwargs)),
        )

        self.assertEqual(result, {"ok": True, "artifactId": artifact_id})
        self.assertEqual(calls[0][0], ["open", "--", str(output.resolve())])
        self.assertFalse(calls[0][1].get("shell", False))
        with self.assertRaisesRegex(ValueError, "artifact_not_found"):
            project_records.reveal_artifact(
                "artifact-0000000000000000",
                runner=lambda *_: None,
            )

    def test_damaged_store_is_preserved_and_never_replaced_with_empty_history(self) -> None:
        self.store_path.parent.mkdir(parents=True)
        self.store_path.write_text("{damaged", "utf-8")

        with self.assertRaisesRegex(ValueError, "record_store_damaged"):
            project_records.read_records("competitor-insight")

        self.assertEqual(self.store_path.read_text("utf-8"), "{damaged")

    def test_malformed_v2_task_is_preserved_and_rejected(self) -> None:
        self.create_task()
        corrupted = json.loads(self.store_path.read_text("utf-8"))
        corrupted["tasks"][0]["status"] = 99
        self.store_path.write_text(json.dumps(corrupted), "utf-8")

        with self.assertRaisesRegex(ValueError, "record_store_damaged"):
            project_records.read_records("competitor-insight")

        self.assertEqual(json.loads(self.store_path.read_text("utf-8"))["tasks"][0]["status"], 99)

    def write_v1_store_with_three_artifacts(self) -> list[Path]:
        output = (
            self.project_root
            / "outputs"
            / "competitor-insight"
            / "xiaohongshu"
            / "competitor-legacy-a1"
        )
        output.mkdir(parents=True)
        report = output / "历史报告.md"
        data = output / "数据.json"
        sheet = output / "数据.xlsx"
        report.write_text("# 历史报告", "utf-8")
        data.write_text('{"items":[]}', "utf-8")
        sheet.write_bytes(b"xlsx")
        task = {
            "id": "competitor-legacy-a1",
            "agentId": "competitor-insight",
            "title": "历史小红书作品",
            "platformId": "xiaohongshu",
            "platformLabel": "小红书",
            "skillId": "xiaohongshu-scraper",
            "sourceUrl": "https://www.xiaohongshu.com/explore/legacy",
            "status": "completed",
            "progress": 100,
            "currentStep": "历史成果已登记",
            "model": "xiaohongshu-scraper",
            "createdAt": "2026-08-01T00:00:00.000Z",
            "updatedAt": "2026-08-01T00:01:00.000Z",
            "completedAt": "2026-08-01T00:01:00.000Z",
            "stoppedAt": None,
            "errorSummary": None,
            "artifactIds": ["artifact-0003f28cb71571c7", "artifact-0007e5196e2ae38e", "artifact-000bd7a625405555"],
        }
        artifacts = [
            {
                "id": f"artifact-{index * 1111111111111111:016x}",
                "agentId": "competitor-insight",
                "taskId": task["id"],
                "kind": kind,
                "name": path.name,
                "filename": path.name,
                "absolutePath": str(path),
                "sizeBytes": path.stat().st_size,
                "createdAt": task["createdAt"],
                "completedAt": task["completedAt"],
                "previewable": kind == "markdown",
                "exists": True,
                "isDirectory": False,
                "markdown": None,
            }
            for index, (path, kind) in enumerate(
                ((report, "markdown"), (data, "json"), (sheet, "excel")), start=1
            )
        ]
        self.store_path.parent.mkdir(parents=True)
        self.store_path.write_text(json.dumps({"schemaVersion": 1, "tasks": [task], "artifacts": artifacts}), "utf-8")
        return [report, data, sheet]

    def bundle_task_directory(self) -> Path:
        return (
            self.project_root
            / "outputs"
            / "competitor-insight"
            / "xiaohongshu"
            / "competitor-20260801-a1"
        )

    def bundle_payload(self, output: Path) -> dict[str, object]:
        report = output / "竞品报告.md"
        data = output / "结构化数据.json"
        workbook = output / "竞品数据.xlsx"
        return {
            "platformId": "xiaohongshu",
            "inputKind": "content",
            "category": "xhs-note",
            "outputDir": str(output),
            "primaryReportPath": str(report),
            "explicitPaths": [str(report), str(data), str(workbook)],
            "subjectName": "公开作品",
            "itemCount": 1,
        }

    def prepare_bundle_task(self) -> Path:
        self.create_task()
        project_records.update_task(
            "competitor-20260801-a1", {"inputKind": "content", "category": "xhs-note"}
        )
        output = self.bundle_task_directory()
        output.mkdir(parents=True)
        (output / "竞品报告.md").write_text("# 竞品报告", "utf-8")
        (output / "结构化数据.json").write_text('{"items":[]}', "utf-8")
        (output / "竞品数据.xlsx").write_bytes(b"xlsx")
        project_records.register_artifacts(
            "competitor-20260801-a1",
            {
                "outputDir": str(output),
                "explicitPaths": [
                    str(output / "竞品报告.md"),
                    str(output / "结构化数据.json"),
                    str(output / "竞品数据.xlsx"),
                ],
            },
        )
        return output

    def test_v1_completed_task_migrates_to_one_legacy_bundle_without_moving_files(self) -> None:
        original_paths = self.write_v1_store_with_three_artifacts()

        snapshot = project_records.read_records("competitor-insight")

        self.assertEqual(len(snapshot["bundles"]), 1)
        legacy = snapshot["bundles"][0]
        self.assertEqual(legacy["status"], "legacy")
        self.assertEqual(legacy["taskId"], "competitor-legacy-a1")
        self.assertEqual(Path(legacy["primaryReportPath"]), original_paths[0].resolve())
        self.assertFalse(Path(legacy["archivePath"]).exists())
        self.assertTrue(all(path.exists() for path in original_paths))
        self.assertEqual(json.loads(self.store_path.read_text("utf-8"))["schemaVersion"], 2)

    def test_task_classification_can_only_resolve_unknown_once(self) -> None:
        self.create_task()

        task = project_records.update_task(
            "competitor-20260801-a1",
            {"inputKind": "account", "category": "xhs-account"},
        )

        self.assertEqual(task["inputKind"], "account")
        self.assertEqual(task["category"], "xhs-account")
        with self.assertRaisesRegex(ValueError, "invalid_task_classification"):
            project_records.update_task(
                "competitor-20260801-a1",
                {"inputKind": "content", "category": "xhs-note"},
            )
        with self.assertRaisesRegex(ValueError, "invalid_task_classification"):
            project_records.update_task(
                "competitor-20260801-a1", {"inputKind": "content"}
            )
        with self.assertRaisesRegex(ValueError, "invalid_task_classification"):
            project_records.update_task(
                "competitor-20260801-a1",
                {"inputKind": "content", "category": "douyin-content"},
            )

    def test_finalize_bundle_is_atomic_idempotent_and_completes_task_after_zip(self) -> None:
        output = self.prepare_bundle_task()
        payload = self.bundle_payload(output)

        snapshot = project_records.finalize_bundle("competitor-20260801-a1", payload)
        repeated = project_records.finalize_bundle("competitor-20260801-a1", payload)

        task = snapshot["tasks"][0]
        bundle = snapshot["bundles"][0]
        self.assertEqual(task["status"], "completed")
        self.assertEqual(task["bundleId"], bundle["id"])
        self.assertEqual(len(snapshot["bundles"]), 1)
        self.assertEqual(repeated["bundles"][0]["id"], bundle["id"])
        self.assertTrue(Path(bundle["manifestPath"]).is_file())
        self.assertTrue(Path(bundle["archivePath"]).is_file())

    def test_zip_excludes_sensitive_symlink_and_unregistered_files(self) -> None:
        output = self.prepare_bundle_task()
        (output / "douyin_state.json").write_text("sentinel-state", "utf-8")
        (output / "COOKIE.txt").write_text("sentinel-cookie", "utf-8")
        (output / "not-registered.txt").write_text("sentinel-stray", "utf-8")
        outside = self.project_root / "private.md"
        outside.write_text("sentinel-private", "utf-8")
        (output / "linked.md").symlink_to(outside)
        snapshot = project_records.finalize_bundle(
            "competitor-20260801-a1", self.bundle_payload(output)
        )
        bundle_id = snapshot["bundles"][0]["id"]

        with zipfile.ZipFile(project_records.bundle_archive(bundle_id)) as archive:
            names = set(archive.namelist())

        self.assertIn("竞品报告.md", names)
        self.assertIn("bundle-manifest.json", names)
        self.assertNotIn("douyin_state.json", names)
        self.assertNotIn("COOKIE.txt", names)
        self.assertNotIn("not-registered.txt", names)
        self.assertNotIn("linked.md", names)
        self.assertFalse(any(name.startswith("/") or ".." in Path(name).parts for name in names))

    def test_legacy_archive_is_delayed_and_missing_files_preserve_history(self) -> None:
        original_paths = self.write_v1_store_with_three_artifacts()
        migrated = project_records.read_records("competitor-insight")
        bundle = migrated["bundles"][0]
        bundle_id = bundle["id"]

        archive = project_records.bundle_archive(bundle_id)
        original_paths[1].unlink()
        refreshed = project_records.read_records("competitor-insight")

        self.assertTrue(archive.is_file())
        self.assertEqual(refreshed["bundles"][0]["status"], "missing")
        self.assertEqual(refreshed["bundles"][0]["id"], bundle_id)

    def test_bundle_reveal_accepts_only_persisted_id_and_root_directory(self) -> None:
        output = self.prepare_bundle_task()
        snapshot = project_records.finalize_bundle(
            "competitor-20260801-a1", self.bundle_payload(output)
        )
        bundle_id = snapshot["bundles"][0]["id"]
        calls: list[tuple[list[str], dict[str, object]]] = []

        result = project_records.reveal_bundle(
            bundle_id, runner=lambda argv, **kwargs: calls.append((argv, kwargs))
        )

        self.assertEqual(result, {"ok": True, "bundleId": bundle_id})
        self.assertEqual(calls[0][0], ["open", "--", str(output.resolve())])
        with self.assertRaisesRegex(ValueError, "invalid_bundle_id"):
            project_records.reveal_bundle(str(output), runner=lambda *_: None)

    def test_finalize_rejects_explicit_unregistered_ordinary_file(self) -> None:
        output = self.prepare_bundle_task()
        unregistered = output / "unregistered-private.txt"
        unregistered.write_text("non-sensitive fixture", "utf-8")
        payload = self.bundle_payload(output)
        payload["explicitPaths"] = [*payload["explicitPaths"], str(unregistered)]

        with self.assertRaisesRegex(ValueError, "artifact_not_authorized"):
            project_records.finalize_bundle("competitor-20260801-a1", payload)

        self.assertEqual(project_records.read_records("competitor-insight")["tasks"][0]["status"], "waiting")

    def test_finalize_rejects_casefolded_workbench_and_sensitive_variants(self) -> None:
        output = self.prepare_bundle_task()
        hidden = output / ".WORKBENCH"
        hidden.mkdir()
        unsafe = hidden / "data.md"
        unsafe.write_text("fixture", "utf-8")
        project_records.register_artifacts(
            "competitor-20260801-a1",
            {"outputDir": str(output), "explicitPaths": [str(unsafe)]},
        )
        payload = self.bundle_payload(output)
        payload["explicitPaths"] = [*payload["explicitPaths"], str(unsafe)]

        with self.assertRaisesRegex(ValueError, "sensitive_path_not_allowed"):
            project_records.finalize_bundle("competitor-20260801-a1", payload)

    def test_finalize_rejects_backslash_archive_member_name(self) -> None:
        output = self.prepare_bundle_task()
        unsafe = output / "..\\archive-slip.md"
        unsafe.write_text("fixture", "utf-8")
        project_records.register_artifacts(
            "competitor-20260801-a1",
            {"outputDir": str(output), "explicitPaths": [str(unsafe)]},
        )
        payload = self.bundle_payload(output)
        payload["explicitPaths"] = [*payload["explicitPaths"], str(unsafe)]

        with self.assertRaisesRegex(ValueError, "invalid_archive_member"):
            project_records.finalize_bundle("competitor-20260801-a1", payload)

    def test_finalize_uses_task_directory_fd_when_parent_is_swapped(self) -> None:
        output = self.prepare_bundle_task()
        nested = output / "nested"
        nested.mkdir()
        report = nested / "竞品报告.md"
        report.write_text("# report", "utf-8")
        project_records.register_artifacts(
            "competitor-20260801-a1",
            {"outputDir": str(output), "explicitPaths": [str(report)]},
        )
        payload = self.bundle_payload(output)
        payload["primaryReportPath"] = str(report)
        payload["explicitPaths"] = [str(report), str(output / "结构化数据.json"), str(output / "竞品数据.xlsx")]
        external = self.project_root / "external"
        external.mkdir()
        (external / "竞品报告.md").write_text("# external", "utf-8")
        original_open = os.open
        swapped = {"done": False}

        def swap_before_leaf(name: object, flags: int, *args: object, **kwargs: object) -> int:
            if name == "竞品报告.md" and kwargs.get("dir_fd") is not None and not swapped["done"]:
                nested.rename(output / "nested-real")
                nested.symlink_to(external, target_is_directory=True)
                swapped["done"] = True
            return original_open(name, flags, *args, **kwargs)

        with patch.object(project_records.os, "open", side_effect=swap_before_leaf):
            snapshot = project_records.finalize_bundle("competitor-20260801-a1", payload)

        self.assertTrue(swapped["done"])
        self.assertEqual(snapshot["tasks"][0]["status"], "completed")

    def test_malformed_v1_is_preserved_without_migration(self) -> None:
        self.write_v1_store_with_three_artifacts()
        damaged = json.loads(self.store_path.read_text("utf-8"))
        damaged["tasks"][0]["artifactIds"] = "not-a-list"
        original = json.dumps(damaged, separators=(",", ":"))
        self.store_path.write_text(original, "utf-8")

        with self.assertRaisesRegex(ValueError, "record_store_damaged"):
            project_records.read_records("competitor-insight")

        self.assertEqual(self.store_path.read_text("utf-8"), original)

    def test_tampered_v2_archive_path_is_rejected_without_opening_external_file(self) -> None:
        output = self.prepare_bundle_task()
        snapshot = project_records.finalize_bundle("competitor-20260801-a1", self.bundle_payload(output))
        external = self.project_root / "external.zip"
        external.write_bytes(b"not an archive")
        corrupted = json.loads(self.store_path.read_text("utf-8"))
        corrupted["bundles"][0]["archivePath"] = str(external)
        self.store_path.write_text(json.dumps(corrupted), "utf-8")

        with self.assertRaisesRegex(ValueError, "record_store_damaged"):
            project_records.bundle_archive(snapshot["bundles"][0]["id"])

    def test_bundle_archive_rejects_manifest_archive_identity_mismatch(self) -> None:
        output = self.prepare_bundle_task()
        snapshot = project_records.finalize_bundle("competitor-20260801-a1", self.bundle_payload(output))
        archive = Path(snapshot["bundles"][0]["archivePath"])
        archive.write_bytes(b"not-a-zip")

        with self.assertRaisesRegex(ValueError, "bundle_missing"):
            project_records.bundle_archive(snapshot["bundles"][0]["id"])

    def test_finalize_cleans_failed_attempt_and_allows_retry(self) -> None:
        output = self.prepare_bundle_task()
        payload = self.bundle_payload(output)

        with patch.object(project_records, "_write_archive_exclusive", side_effect=ValueError("archive_write_failed")):
            with self.assertRaisesRegex(ValueError, "archive_write_failed"):
                project_records.finalize_bundle("competitor-20260801-a1", payload)
        retry = project_records.finalize_bundle("competitor-20260801-a1", payload)

        self.assertEqual(retry["tasks"][0]["status"], "completed")
        self.assertTrue(Path(retry["bundles"][0]["archivePath"]).is_file())

    def test_registered_directory_freezes_its_members_before_late_child_exists(self) -> None:
        output = self.prepare_bundle_task()
        images = output / "images"
        images.mkdir()
        first_image = images / "01.jpg"
        first_image.write_bytes(b"first-image")
        project_records.register_artifacts(
            "competitor-20260801-a1",
            {"outputDir": str(output), "explicitPaths": [str(images)]},
        )
        late_child = images / "late-unregistered.txt"
        late_child.write_text("late fixture", "utf-8")
        payload = self.bundle_payload(output)
        payload["explicitPaths"] = [*payload["explicitPaths"], str(images)]

        snapshot = project_records.finalize_bundle("competitor-20260801-a1", payload)

        with zipfile.ZipFile(snapshot["bundles"][0]["archivePath"]) as archive:
            self.assertIn("images/01.jpg", archive.namelist())
            self.assertNotIn("images/late-unregistered.txt", archive.namelist())

    def test_bundle_archive_rejects_coordinated_manifest_and_zip_replacement(self) -> None:
        output = self.prepare_bundle_task()
        snapshot = project_records.finalize_bundle("competitor-20260801-a1", self.bundle_payload(output))
        bundle = snapshot["bundles"][0]
        replacement = output / "replacement.md"
        replacement.write_text("replacement fixture", "utf-8")
        replacement_bytes = replacement.read_bytes()
        manifest = json.dumps(
            {
                "schemaVersion": 1,
                "primaryReport": "replacement.md",
                "files": [{
                    "path": "replacement.md",
                    "sizeBytes": len(replacement_bytes),
                    "sha256": hashlib.sha256(replacement_bytes).hexdigest(),
                    "kind": "markdown",
                }],
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        stream = BytesIO()
        with zipfile.ZipFile(stream, "w") as archive:
            archive.writestr("replacement.md", replacement_bytes)
            archive.writestr("bundle-manifest.json", manifest)
        Path(bundle["manifestPath"]).write_bytes(manifest)
        Path(bundle["archivePath"]).write_bytes(stream.getvalue())

        calls: list[list[str]] = []
        with self.assertRaisesRegex(ValueError, "bundle_missing"):
            project_records.reveal_bundle(bundle["id"], runner=lambda argv, **_: calls.append(argv))
        self.assertEqual(calls, [])
        with self.assertRaisesRegex(ValueError, "bundle_missing"):
            project_records.bundle_archive(bundle["id"])

        self.assertEqual(project_records.read_records("competitor-insight")["bundles"][0]["status"], "missing")

    def test_create_task_rejects_platforms_outside_closed_schema(self) -> None:
        for platform_id in ("unknown", "", None, "douyin "):
            with self.subTest(platform_id=platform_id):
                with self.assertRaisesRegex(ValueError, "invalid_platform_id"):
                    self.create_task(platformId=platform_id)
        self.assertFalse(self.store_path.exists())

    def test_finalize_removes_published_files_when_store_commit_fails(self) -> None:
        output = self.prepare_bundle_task()
        payload = self.bundle_payload(output)

        with patch.object(project_records, "_atomic_write", side_effect=OSError("store_write_failed")):
            with self.assertRaisesRegex(OSError, "store_write_failed"):
                project_records.finalize_bundle("competitor-20260801-a1", payload)

        self.assertEqual(list(output.glob("bundle-*.manifest.json")), [])
        self.assertEqual(list(output.glob("bundle-*.zip")), [])
        retry = project_records.finalize_bundle("competitor-20260801-a1", payload)
        self.assertEqual(retry["tasks"][0]["status"], "completed")

    def test_finalize_cleans_each_link_interruption_and_allows_retry(self) -> None:
        original_link = os.link
        output = self.prepare_bundle_task()
        for failing_call in (1, 2):
            with self.subTest(failing_call=failing_call):
                calls = {"count": 0}

                def interrupt_link(*args: object, **kwargs: object) -> None:
                    calls["count"] += 1
                    if calls["count"] == failing_call:
                        raise OSError("link_interrupted")
                    original_link(*args, **kwargs)

                with patch.object(project_records.os, "link", side_effect=interrupt_link):
                    with self.assertRaisesRegex(OSError, "link_interrupted"):
                        project_records.finalize_bundle(
                            "competitor-20260801-a1", self.bundle_payload(output)
                        )
                self.assertEqual(list(output.glob("bundle-*.manifest.json")), [])
                self.assertEqual(list(output.glob("bundle-*.zip")), [])
        self.assertEqual(
            project_records.finalize_bundle(
                "competitor-20260801-a1", self.bundle_payload(output)
            )["tasks"][0]["status"],
            "completed",
        )

    def test_directory_registration_skips_sensitive_and_symlink_children(self) -> None:
        output = self.prepare_bundle_task()
        images = output / "images"
        images.mkdir()
        (images / "01.jpg").write_bytes(b"image")
        (images / "COOKIE.jpg").write_bytes(b"unsafe fixture")
        outside = self.project_root / "outside.jpg"
        outside.write_bytes(b"outside fixture")
        (images / "linked.jpg").symlink_to(outside)

        snapshot = project_records.register_artifacts(
            "competitor-20260801-a1",
            {"outputDir": str(output), "explicitPaths": [str(images)]},
        )

        paths = {Path(item["absolutePath"]).name for item in snapshot["artifacts"]}
        self.assertIn("01.jpg", paths)
        self.assertNotIn("COOKIE.jpg", paths)
        self.assertNotIn("linked.jpg", paths)

    def test_ready_bundle_requires_all_store_commitments(self) -> None:
        output = self.prepare_bundle_task()
        project_records.finalize_bundle("competitor-20260801-a1", self.bundle_payload(output))
        corrupted = json.loads(self.store_path.read_text("utf-8"))
        corrupted["bundles"][0]["archiveSha256"] = None
        self.store_path.write_text(json.dumps(corrupted), "utf-8")

        with self.assertRaisesRegex(ValueError, "record_store_damaged"):
            project_records.read_records("competitor-insight")


if __name__ == "__main__":
    unittest.main()
