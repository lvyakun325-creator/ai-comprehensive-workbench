import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest


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
        self.assertEqual(persisted["schemaVersion"], 1)
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

        completed = project_records.update_task(
            "competitor-20260801-a1",
            {
                "status": "completed",
                "progress": 100,
                "currentStep": "成果已登记",
            },
        )
        self.assertIsInstance(completed["completedAt"], str)

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


if __name__ == "__main__":
    unittest.main()
