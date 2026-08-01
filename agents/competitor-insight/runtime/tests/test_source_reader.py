import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest


RUNTIME_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME_DIR))

from evidence_bundle import build_evidence_bundle
from source_reader import read_scrape_source


class SourceReaderTests(unittest.TestCase):
    """Each test catches a wrong source adapter, not a scraper implementation detail."""

    def _write_json(self, directory: str, name: str, value: object) -> Path:
        path = Path(directory) / name
        path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
        return path

    def test_xhs_profile_json_normalizes_all_notes_without_using_skill_score(self) -> None:
        """Would fail if profile notes are dropped or a skill-only score leaks into evidence."""
        notes = [
            {
                "note_id": f"note-{index}",
                "title": f"笔记 {index}",
                "liked_count": "1.5万" if index == 0 else index,
                "collected_count": index + 1,
                "comment_count": index + 2,
                "shared_count": index + 3,
                "internal_score": 9999,
                "url": f"https://www.xiaohongshu.com/explore/note-{index}",
            }
            for index in range(12)
        ]
        with TemporaryDirectory() as directory:
            profile_json = self._write_json(
                directory,
                "profile.json",
                {
                    "content_type": "profile",
                    "profile": {"nickname": "测试账号", "user_id": "xhs-user", "fans": "2w"},
                    "notes": notes,
                },
            )
            parsed = read_scrape_source("xiaohongshu", "account", profile_json, None)

        self.assertEqual(parsed["subject"]["nickname"], "测试账号")
        self.assertEqual(len(parsed["items"]), 12)
        self.assertEqual(parsed["items"][0]["likes"], 15000)
        self.assertNotIn("internal_score", json.dumps(parsed, ensure_ascii=False))

    def test_douyin_content_keeps_captured_content_and_has_no_account_rankings(self) -> None:
        """Would fail if a single video gains account rankings or fabricated content fields."""
        with TemporaryDirectory() as directory:
            video_json = self._write_json(
                directory,
                "video.json",
                {
                    "status": "success",
                    "data": {
                        "video": {
                            "id": "dy-1",
                            "title": "公开标题",
                            "likes": "1.5w",
                            "comments": 4,
                            "collects": None,
                            "shares": 2,
                            "create_time": 1_722_429_000,
                            "url": "https://www.douyin.com/video/dy-1",
                            "author": {"nickname": "公开作者", "sec_uid": "sec-1"},
                            "transcript": "已抓到的转写",
                            "image_count": 3,
                        }
                    },
                },
            )
            parsed = read_scrape_source("douyin", "content", video_json, None)
            bundle = build_evidence_bundle(parsed, {"platformId": "douyin", "inputKind": "content"})

        self.assertEqual(len(bundle["items"]), 1)
        self.assertEqual(bundle["rankings"], {})
        self.assertEqual(bundle["content"]["transcript"], "已抓到的转写")
        self.assertIn("collects", bundle["completeness"]["missingFields"])
        self.assertNotIn("ocr", bundle["content"])

    def test_douyin_account_and_xhs_note_normalize_platform_specific_metrics(self) -> None:
        """Would fail if either platform adapter uses the wrong interaction field mapping."""
        with TemporaryDirectory() as directory:
            douyin_json = self._write_json(
                directory,
                "account.json",
                {
                    "status": "success",
                    "data": {
                        "profile": {"nickname": "抖音账号", "sec_uid": "sec-2", "follower_count": 8},
                        "videos": [{"id": "v1", "title": "作品", "likes": 1, "comments": 2, "collects": 3, "shares": 4}],
                    },
                },
            )
            xhs_json = self._write_json(
                directory,
                "note.json",
                {
                    "content_type": "note",
                    "title": "单篇笔记",
                    "content": "抓到的正文",
                    "author": "公开作者",
                    "liked_count": 5,
                    "collected_count": 6,
                    "comment_count": 7,
                    "shared_count": 8,
                    "image_count": 2,
                    "url": "https://www.xiaohongshu.com/explore/note-1",
                },
            )
            douyin = read_scrape_source("douyin", "account", douyin_json, None)
            xhs = read_scrape_source("xiaohongshu", "content", xhs_json, None)

        self.assertEqual(douyin["items"][0]["totalInteractions"], 10)
        self.assertEqual(xhs["items"][0]["totalInteractions"], 26)
        self.assertEqual(xhs["content"]["body"], "抓到的正文")

    def test_rejects_unsupported_or_non_json_source(self) -> None:
        """Would fail if arbitrary files were accepted as scraper evidence input."""
        with TemporaryDirectory() as directory:
            not_json = Path(directory) / "source.txt"
            not_json.write_text("not-json", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, r"^invalid_source_path$"):
                read_scrape_source("douyin", "account", not_json, None)
            source = self._write_json(directory, "source.json", {"data": {}})
            with self.assertRaisesRegex(ValueError, r"^unsupported_report_source$"):
                read_scrape_source("unknown", "account", source, None)

    def test_rejects_excel_path_that_is_not_a_real_workbook(self) -> None:
        """Would fail if a renamed non-XLSX file bypassed source structure validation."""
        with TemporaryDirectory() as directory:
            source = self._write_json(
                directory,
                "source.json",
                {"status": "success", "data": {"profile": {"nickname": "账号"}, "videos": [{"title": "作品"}]}},
            )
            fake_workbook = Path(directory) / "fake.xlsx"
            fake_workbook.write_text("not a workbook", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, r"^invalid_source_workbook$"):
                read_scrape_source("douyin", "account", source, fake_workbook)


if __name__ == "__main__":
    unittest.main()
