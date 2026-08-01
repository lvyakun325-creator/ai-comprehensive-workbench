import hashlib
from io import BytesIO
import json
import multiprocessing
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import time
import unittest
from unittest.mock import patch
import zipfile


RUNTIME_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME_DIR))

import project_records


def _finalize_in_process(
    project_root: str, task_id: str,
    payload: dict[str, object],
    barrier: object,
    results: object,
) -> None:
    project_records.PROJECT_ROOT = Path(project_root)
    original_atomic_write = project_records._atomic_write

    def delayed_atomic_write(store: dict[str, object]) -> None:
        time.sleep(0.2)
        original_atomic_write(store)

    project_records._atomic_write = delayed_atomic_write
    try:
        barrier.wait(timeout=10)  # type: ignore[union-attr]
        snapshot = project_records.finalize_bundle(task_id, payload)
        results.put(("ok", str(snapshot["bundles"][0]["id"])))  # type: ignore[union-attr]
    except BaseException as error:
        results.put(("error", f"{type(error).__name__}:{error}"))  # type: ignore[union-attr]


def _failed_finalize_in_process(
    project_root: str, task_id: str, payload: dict[str, object], results: object,
) -> None:
    project_records.PROJECT_ROOT = Path(project_root)
    original_atomic_write = project_records._atomic_write

    def failed_atomic_write(store: dict[str, object]) -> None:
        raise OSError("forced_store_failure")

    project_records._atomic_write = failed_atomic_write
    try:
        project_records.finalize_bundle(task_id, payload)
    except BaseException as error:
        results.put(("error", f"{type(error).__name__}:{error}"))  # type: ignore[union-attr]
    else:
        results.put(("ok", "unexpected"))  # type: ignore[union-attr]
    finally:
        project_records._atomic_write = original_atomic_write


def _hold_store_transaction_in_process(
    project_root: str,
    entered: object,
    release: object,
    results: object,
    fail: bool,
) -> None:
    project_records.PROJECT_ROOT = Path(project_root)
    try:
        with project_records._store_transaction():
            entered.set()  # type: ignore[union-attr]
            if not release.wait(timeout=10):  # type: ignore[union-attr]
                raise TimeoutError("holder_release_timeout")
            if fail:
                raise RuntimeError("forced_transaction_failure")
    except BaseException as error:
        results.put(("error", f"{type(error).__name__}:{error}"))  # type: ignore[union-attr]
    else:
        results.put(("ok", "released"))  # type: ignore[union-attr]


def _enter_store_transaction_in_process(
    project_root: str, attempted: object, entered: object, results: object,
) -> None:
    project_records.PROJECT_ROOT = Path(project_root)
    attempted.set()  # type: ignore[union-attr]
    try:
        with project_records._store_transaction():
            entered.set()  # type: ignore[union-attr]
    except BaseException as error:
        results.put(("error", f"{type(error).__name__}:{error}"))  # type: ignore[union-attr]
    else:
        results.put(("ok", "entered"))  # type: ignore[union-attr]


def _paused_finalize_in_process(
    project_root: str,
    task_id: str,
    payload: dict[str, object],
    entered: object,
    release: object,
    results: object,
) -> None:
    project_records.PROJECT_ROOT = Path(project_root)
    original_bundle_request = project_records._bundle_request

    def paused_bundle_request(*args: object, **kwargs: object) -> dict[str, object]:
        entered.set()  # type: ignore[union-attr]
        if not release.wait(timeout=10):  # type: ignore[union-attr]
            raise TimeoutError("finalize_release_timeout")
        return original_bundle_request(*args, **kwargs)

    project_records._bundle_request = paused_bundle_request
    try:
        snapshot = project_records.finalize_bundle(task_id, payload)
        bundle = next(item for item in snapshot["bundles"] if item["taskId"] == task_id)
        results.put(("ok", str(bundle["id"])))  # type: ignore[union-attr]
    except BaseException as error:
        results.put(("error", f"{type(error).__name__}:{error}"))  # type: ignore[union-attr]
    finally:
        project_records._bundle_request = original_bundle_request


def _signaled_finalize_in_process(
    project_root: str,
    task_id: str,
    payload: dict[str, object],
    attempted: object,
    completed: object,
    results: object,
) -> None:
    project_records.PROJECT_ROOT = Path(project_root)
    attempted.set()  # type: ignore[union-attr]
    try:
        snapshot = project_records.finalize_bundle(task_id, payload)
        bundle = next(item for item in snapshot["bundles"] if item["taskId"] == task_id)
        results.put(("ok", str(bundle["id"])))  # type: ignore[union-attr]
    except BaseException as error:
        results.put(("error", f"{type(error).__name__}:{error}"))  # type: ignore[union-attr]
    finally:
        completed.set()  # type: ignore[union-attr]


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

    def bundle_task_directory(self, task_id: str = "competitor-20260801-a1") -> Path:
        return (
            self.project_root
            / "outputs"
            / "competitor-insight"
            / "xiaohongshu"
            / task_id
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

    def prepare_bundle_task(self, task_id: str = "competitor-20260801-a1") -> Path:
        self.create_task(id=task_id)
        project_records.update_task(
            task_id, {"inputKind": "content", "category": "xhs-note"}
        )
        output = self.bundle_task_directory(task_id)
        output.mkdir(parents=True)
        (output / "竞品报告.md").write_text("# 竞品报告", "utf-8")
        (output / "结构化数据.json").write_text('{"items":[]}', "utf-8")
        (output / "竞品数据.xlsx").write_bytes(b"xlsx")
        project_records.register_artifacts(
            task_id,
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

    def test_two_process_finalizers_commit_one_bundle_and_one_archive_pair(self) -> None:
        output = self.prepare_bundle_task()
        context = multiprocessing.get_context("fork")
        barrier = context.Barrier(2)
        results = context.Queue()
        payload = self.bundle_payload(output)
        workers = [
            context.Process(
                target=_finalize_in_process,
                args=(str(self.project_root), "competitor-20260801-a1", payload, barrier, results),
            )
            for _ in range(2)
        ]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(timeout=15)
            self.assertEqual(worker.exitcode, 0)
        outcomes = [results.get(timeout=2) for _ in workers]

        self.assertEqual({status for status, _ in outcomes}, {"ok"})
        self.assertEqual(len({bundle_id for _, bundle_id in outcomes}), 1)
        persisted = project_records.read_records("competitor-insight")
        self.assertEqual(len(persisted["bundles"]), 1)
        self.assertEqual(len(list(output.glob("bundle-*.manifest.json"))), 1)
        self.assertEqual(len(list(output.glob("bundle-*.zip"))), 1)
        self.assertEqual(list(output.glob(".bundle-*")), [])

    def test_two_process_different_tasks_preserve_both_store_updates(self) -> None:
        first = self.prepare_bundle_task()
        second_id = "competitor-20260801-b2"
        second = self.prepare_bundle_task(second_id)
        context = multiprocessing.get_context("fork")
        barrier = context.Barrier(2)
        results = context.Queue()
        workers = [
            context.Process(
                target=_finalize_in_process,
                args=(str(self.project_root), task_id, self.bundle_payload(output), barrier, results),
            )
            for task_id, output in (("competitor-20260801-a1", first), (second_id, second))
        ]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(timeout=15)
            self.assertEqual(worker.exitcode, 0)

        outcomes = [results.get(timeout=2) for _ in workers]
        self.assertEqual({status for status, _ in outcomes}, {"ok"})
        persisted = project_records.read_records("competitor-insight")
        self.assertEqual(len(persisted["bundles"]), 2)
        self.assertEqual({task["status"] for task in persisted["tasks"]}, {"completed"})

    def test_process_lock_releases_after_failed_finalization(self) -> None:
        output = self.prepare_bundle_task()
        context = multiprocessing.get_context("fork")
        failures = context.Queue()
        failed = context.Process(
            target=_failed_finalize_in_process,
            args=(str(self.project_root), "competitor-20260801-a1", self.bundle_payload(output), failures),
        )
        failed.start()
        failed.join(timeout=15)
        self.assertEqual(failed.exitcode, 0)
        self.assertEqual(failures.get(timeout=2)[0], "error")
        self.assertEqual(list(output.glob("bundle-*.zip")), [])

        completed = context.Queue()
        recovered = context.Process(
            target=_finalize_in_process,
            args=(str(self.project_root), "competitor-20260801-a1", self.bundle_payload(output), context.Barrier(1), completed),
        )
        recovered.start()
        recovered.join(timeout=15)
        self.assertEqual(recovered.exitcode, 0)
        self.assertEqual(completed.get(timeout=2)[0], "ok")
        self.assertEqual(len(list(output.glob("bundle-*.zip"))), 1)

    def test_store_lock_rejects_a_symlink(self) -> None:
        self.create_task()
        lock_path = self.store_path.with_name(".project-records.lock")
        lock_path.unlink()
        outside = self.project_root / "outside-lock"
        outside.write_text("fixture", "utf-8")
        lock_path.symlink_to(outside)

        with self.assertRaisesRegex(ValueError, "record_lock_unavailable"):
            project_records.update_task("competitor-20260801-a1", {"progress": 20})

        self.assertEqual(outside.read_text("utf-8"), "fixture")

    def test_kernel_mutex_platform_failure_is_stably_fail_closed(self) -> None:
        self.create_task()
        original_store = self.store_path.read_bytes()

        with patch.object(
            project_records, "_store_mutex_port", side_effect=OSError("unavailable")
        ):
            try:
                project_records.update_task(
                    "competitor-20260801-a1", {"progress": 20}
                )
            except Exception as error:
                failure = error
            else:
                self.fail("kernel mutex failure must not fall back to flock")

        self.assertIsInstance(failure, ValueError)
        self.assertEqual(str(failure), "record_store_locked")
        self.assertEqual(self.store_path.read_bytes(), original_store)

    def test_replaced_lock_inode_cannot_bypass_failed_transaction_mutex(self) -> None:
        self.create_task()
        context = multiprocessing.get_context("fork")
        holder_entered = context.Event()
        holder_release = context.Event()
        holder_results = context.Queue()
        holder = context.Process(
            target=_hold_store_transaction_in_process,
            args=(
                str(self.project_root), holder_entered, holder_release,
                holder_results, True,
            ),
        )
        holder.start()
        self.assertTrue(holder_entered.wait(timeout=5))

        lock_path = self.store_path.with_name(".project-records.lock")
        original_inode = lock_path.stat().st_ino
        replacement = lock_path.with_name(".project-records.replacement")
        replacement.write_text("replacement", "utf-8")
        os.replace(replacement, lock_path)
        self.assertNotEqual(lock_path.stat().st_ino, original_inode)
        self.assertTrue(lock_path.is_file())

        attempted = context.Event()
        contender_entered = context.Event()
        contender_results = context.Queue()
        contender = context.Process(
            target=_enter_store_transaction_in_process,
            args=(str(self.project_root), attempted, contender_entered, contender_results),
        )
        contender.start()
        self.assertTrue(attempted.wait(timeout=5))
        entered_before_release = contender_entered.wait(timeout=0.75)
        holder_release.set()
        holder.join(timeout=15)
        contender.join(timeout=15)

        self.assertFalse(entered_before_release)
        self.assertEqual(holder.exitcode, 0)
        self.assertEqual(contender.exitcode, 0)
        self.assertEqual(holder_results.get(timeout=2)[0], "error")
        self.assertEqual(contender_results.get(timeout=2), ("ok", "entered"))

    def test_replaced_lock_inode_keeps_same_task_finalization_idempotent(self) -> None:
        output = self.prepare_bundle_task()
        payload = self.bundle_payload(output)
        context = multiprocessing.get_context("fork")
        holder_entered = context.Event()
        holder_release = context.Event()
        holder_results = context.Queue()
        holder = context.Process(
            target=_paused_finalize_in_process,
            args=(
                str(self.project_root), "competitor-20260801-a1", payload,
                holder_entered, holder_release, holder_results,
            ),
        )
        holder.start()
        self.assertTrue(holder_entered.wait(timeout=5))

        lock_path = self.store_path.with_name(".project-records.lock")
        replacement = lock_path.with_name(".project-records.replacement")
        replacement.write_text("replacement", "utf-8")
        os.replace(replacement, lock_path)

        attempted = context.Event()
        completed = context.Event()
        contender_results = context.Queue()
        contender = context.Process(
            target=_signaled_finalize_in_process,
            args=(
                str(self.project_root), "competitor-20260801-a1", payload,
                attempted, completed, contender_results,
            ),
        )
        contender.start()
        self.assertTrue(attempted.wait(timeout=5))
        completed_before_release = completed.wait(timeout=0.75)
        holder_release.set()
        holder.join(timeout=15)
        contender.join(timeout=15)

        self.assertFalse(completed_before_release)
        self.assertEqual(holder.exitcode, 0)
        self.assertEqual(contender.exitcode, 0)
        outcomes = [holder_results.get(timeout=2), contender_results.get(timeout=2)]
        self.assertEqual({status for status, _ in outcomes}, {"ok"})
        self.assertEqual(len({bundle_id for _, bundle_id in outcomes}), 1)
        persisted = project_records.read_records("competitor-insight")
        self.assertEqual(len(persisted["bundles"]), 1)
        self.assertEqual(len(list(output.glob("bundle-*.manifest.json"))), 1)
        self.assertEqual(len(list(output.glob("bundle-*.zip"))), 1)
        self.assertEqual(list(output.glob(".bundle-*")), [])

    def test_replaced_lock_inode_preserves_different_task_finalizations(self) -> None:
        first_id = "competitor-20260801-a1"
        second_id = "competitor-20260801-b2"
        first = self.prepare_bundle_task(first_id)
        second = self.prepare_bundle_task(second_id)
        context = multiprocessing.get_context("fork")
        holder_entered = context.Event()
        holder_release = context.Event()
        holder_results = context.Queue()
        holder = context.Process(
            target=_paused_finalize_in_process,
            args=(
                str(self.project_root), first_id, self.bundle_payload(first),
                holder_entered, holder_release, holder_results,
            ),
        )
        holder.start()
        self.assertTrue(holder_entered.wait(timeout=5))

        lock_path = self.store_path.with_name(".project-records.lock")
        replacement = lock_path.with_name(".project-records.replacement")
        replacement.write_text("replacement", "utf-8")
        os.replace(replacement, lock_path)

        attempted = context.Event()
        completed = context.Event()
        contender_results = context.Queue()
        contender = context.Process(
            target=_signaled_finalize_in_process,
            args=(
                str(self.project_root), second_id, self.bundle_payload(second),
                attempted, completed, contender_results,
            ),
        )
        contender.start()
        self.assertTrue(attempted.wait(timeout=5))
        completed_before_release = completed.wait(timeout=0.75)
        holder_release.set()
        holder.join(timeout=15)
        contender.join(timeout=15)

        self.assertFalse(completed_before_release)
        self.assertEqual(holder.exitcode, 0)
        self.assertEqual(contender.exitcode, 0)
        self.assertEqual(holder_results.get(timeout=2)[0], "ok")
        self.assertEqual(contender_results.get(timeout=2)[0], "ok")
        persisted = project_records.read_records("competitor-insight")
        self.assertEqual(len(persisted["bundles"]), 2)
        self.assertEqual({task["status"] for task in persisted["tasks"]}, {"completed"})
        for output in (first, second):
            self.assertEqual(len(list(output.glob("bundle-*.manifest.json"))), 1)
            self.assertEqual(len(list(output.glob("bundle-*.zip"))), 1)
            self.assertEqual(list(output.glob(".bundle-*")), [])


if __name__ == "__main__":
    unittest.main()
