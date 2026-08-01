import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
import zipfile

from openpyxl import Workbook


RUNTIME_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME_DIR))

from evidence_bundle import build_evidence_bundle
import source_reader
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
                            "image_count": 3,
                        },
                        "author": {"nickname": "公开作者", "sec_uid": "sec-1", "follower_count": "3w"},
                        "transcription": {
                            "polished_transcript": "不可作为证据的改写文本",
                            "raw_transcript": "更原始的抓取文本",
                            "cleaned_transcript": "清洗后的抓取文本",
                            "transcript": "已抓到的最终转写",
                        },
                    },
                },
            )
            parsed = read_scrape_source("douyin", "content", video_json, None)
            bundle = build_evidence_bundle(parsed, {"platformId": "douyin", "inputKind": "content"})

        self.assertEqual(len(bundle["items"]), 1)
        self.assertEqual(bundle["rankings"], {})
        self.assertEqual(bundle["content"]["transcript"], "已抓到的最终转写")
        self.assertEqual(bundle["subject"]["nickname"], "公开作者")
        self.assertEqual(bundle["subject"]["accountId"], "sec-1")
        self.assertNotEqual(bundle["subject"].get("accountId"), "dy-1")
        self.assertIn("collects", bundle["completeness"]["missingFields"])
        self.assertNotIn("ocr", bundle["content"])

    def test_douyin_content_ignores_polished_transcript_without_captured_transcript(self) -> None:
        """Would fail if agent-polished text were admitted as captured evidence."""
        with TemporaryDirectory() as directory:
            source = self._write_json(
                directory,
                "video.json",
                {
                    "data": {
                        "video": {"id": "video", "title": "标题"},
                        "author": {"nickname": "作者", "sec_uid": "sec"},
                        "transcription": {"polished_transcript": "Agent 改写，不是抓取证据"},
                    }
                },
            )
            parsed = read_scrape_source("douyin", "content", source, None)

        self.assertNotIn("transcript", parsed["content"])
        self.assertIn("missing_content:transcript", parsed["warnings"])

    def test_douyin_content_records_cleaned_transcript_fallback_source(self) -> None:
        """Would fail if the allowed non-generative cleaned fallback lost its provenance."""
        with TemporaryDirectory() as directory:
            source = self._write_json(
                directory,
                "video.json",
                {
                    "data": {
                        "video": {"id": "video", "title": "标题"},
                        "author": {"nickname": "作者", "sec_uid": "sec"},
                        "transcription": {"cleaned_transcript": "清洗后的抓取文本"},
                    }
                },
            )
            parsed = read_scrape_source("douyin", "content", source, None)

        self.assertEqual(parsed["content"]["transcript"], "清洗后的抓取文本")
        self.assertEqual(parsed["content"]["transcriptSource"], "transcription.cleaned_transcript")

    def test_rejects_ancestor_swap_before_json_leaf_open(self) -> None:
        """Would fail if a checked ancestor could be swapped to a symlink before JSON open."""
        with TemporaryDirectory() as directory:
            root = Path(directory)
            safe, outside, moved = root / "safe", root / "outside", root / "moved"
            safe.mkdir()
            outside.mkdir()
            source = self._write_json(str(safe), "source.json", {"data": {"profile": {"nickname": "safe"}, "videos": [{"title": "作品"}]}})
            self._write_json(str(outside), "source.json", {"data": {"profile": {"nickname": "outside"}, "videos": [{"title": "作品"}]}})
            real_open = source_reader.os.open
            swapped = False

            def swap_before_open(name: object, flags: int, mode: int = 0o777, *, dir_fd: int | None = None) -> int:
                nonlocal swapped
                if not swapped and (name == source.absolute() or name == "safe"):
                    swapped = True
                    os.rename(safe, moved)
                    os.symlink(outside, safe)
                return real_open(name, flags, mode, dir_fd=dir_fd)

            with patch.object(source_reader.os, "open", side_effect=swap_before_open) as mocked_open:
                with patch.object(
                    source_reader.os,
                    "supports_dir_fd",
                    set(source_reader.os.supports_dir_fd) | {mocked_open},
                ):
                    with self.assertRaisesRegex(ValueError, r"^invalid_source_path$"):
                        read_scrape_source("douyin", "account", source, None)
            self.assertTrue(swapped)
            self.assertTrue(
                any(
                    call.args[0] == "safe" and call.kwargs.get("dir_fd") is not None
                    for call in mocked_open.call_args_list
                )
            )

    def test_rejects_ancestor_swap_before_xlsx_leaf_open(self) -> None:
        """Would fail if an XLSX companion followed an ancestor symlink during open."""
        with TemporaryDirectory() as directory:
            root = Path(directory)
            safe, outside, moved = root / "safe-xlsx", root / "outside-xlsx", root / "moved-xlsx"
            safe.mkdir()
            outside.mkdir()
            source = self._write_json(directory, "source.json", {"data": {"profile": {"nickname": "账号"}, "videos": [{"title": "作品"}]}})
            for parent in (safe, outside):
                workbook = Workbook()
                workbook.save(parent / "source.xlsx")
                workbook.close()
            workbook_path = safe / "source.xlsx"
            real_open = source_reader.os.open
            swapped = False

            def swap_before_open(name: object, flags: int, mode: int = 0o777, *, dir_fd: int | None = None) -> int:
                nonlocal swapped
                if not swapped and (name == workbook_path.absolute() or name == "safe-xlsx"):
                    swapped = True
                    os.rename(safe, moved)
                    os.symlink(outside, safe)
                return real_open(name, flags, mode, dir_fd=dir_fd)

            with patch.object(source_reader.os, "open", side_effect=swap_before_open) as mocked_open:
                with patch.object(
                    source_reader.os,
                    "supports_dir_fd",
                    set(source_reader.os.supports_dir_fd) | {mocked_open},
                ):
                    with self.assertRaisesRegex(ValueError, r"^invalid_source_path$"):
                        read_scrape_source("douyin", "account", source, workbook_path)
            self.assertTrue(swapped)
            self.assertTrue(
                any(
                    call.args[0] == "safe-xlsx" and call.kwargs.get("dir_fd") is not None
                    for call in mocked_open.call_args_list
                )
            )

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
                    "comments": [{"content": "已抓评论正文，不能进入证据内容"}],
                    "comment_count_declared": "7",
                    "shared_count": 8,
                    "image_count": 2,
                    "url": "https://www.xiaohongshu.com/explore/note-1",
                },
            )
            douyin = read_scrape_source("douyin", "account", douyin_json, None)
            xhs = read_scrape_source("xiaohongshu", "content", xhs_json, None)

        self.assertEqual(douyin["items"][0]["totalInteractions"], 10)
        self.assertEqual(xhs["items"][0]["comments"], 7)
        self.assertEqual(xhs["items"][0]["totalInteractions"], 26)
        self.assertEqual(xhs["content"]["body"], "抓到的正文")
        self.assertNotIn("评论正文", json.dumps(xhs["content"], ensure_ascii=False))

    def test_metric_aliases_continue_after_empty_or_invalid_values(self) -> None:
        """Would fail if an unusable early alias hides a later captured scalar metric."""
        with TemporaryDirectory() as directory:
            source = self._write_json(
                directory,
                "note.json",
                {
                    "title": "笔记",
                    "liked_count": {},
                    "likedCount": "9",
                    "comments": [],
                    "comment_count_declared": "not-a-number",
                    "commentCount": "8",
                    "collected_count": "",
                    "collectedCount": "7",
                    "shared_count": None,
                },
            )
            parsed = read_scrape_source("xiaohongshu", "content", source, None)

        item = parsed["items"][0]
        self.assertEqual((item["likes"], item["comments"], item["collects"]), (9, 8, 7))
        self.assertEqual(item["shares"], 0)
        self.assertIn("shares", parsed["missingFields"])
        self.assertIn("unrecognized_metric:likes:row=1", parsed["warnings"])
        self.assertIn("unrecognized_metric:comments:row=1", parsed["warnings"])
        self.assertNotIn("comments", parsed["missingFields"])

    def test_metric_missing_and_invalid_values_have_distinct_completeness_signals(self) -> None:
        """Would fail if invalid nonempty data were mislabeled as a missing real zero."""
        with TemporaryDirectory() as directory:
            empty = self._write_json(directory, "empty.json", {"title": "空字段", "liked_count": "", "likedCount": None})
            invalid = self._write_json(directory, "invalid.json", {"title": "坏字段", "liked_count": []})
            empty_parsed = read_scrape_source("xiaohongshu", "content", empty, None)
            invalid_parsed = read_scrape_source("xiaohongshu", "content", invalid, None)

        self.assertIn("likes", empty_parsed["missingFields"])
        self.assertIn("missing_metric:likes:row=1", empty_parsed["warnings"])
        self.assertNotIn("likes", invalid_parsed["missingFields"])
        self.assertNotIn("missing_metric:likes:row=1", invalid_parsed["warnings"])
        self.assertIn("unrecognized_metric:likes:row=1", invalid_parsed["warnings"])

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

    def test_rejects_unsafe_xlsx_archive_before_workbook_open(self) -> None:
        """Would fail if an archive bomb or traversal member reaches openpyxl."""
        with TemporaryDirectory() as directory:
            source = self._write_json(
                directory,
                "source.json",
                {"data": {"profile": {"nickname": "账号"}, "videos": [{"title": "作品"}]}},
            )
            for name, payload, expected in (
                ("bomb.xlsx", b"x" * (2 * 1024 * 1024), "xlsx_archive_too_large"),
                ("traversal.xlsx", b"x", "invalid_xlsx_signature"),
            ):
                with self.subTest(name=name):
                    workbook = Path(directory) / name
                    with zipfile.ZipFile(workbook, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                        archive.writestr("[Content_Types].xml", b"<Types/>")
                        archive.writestr("_rels/.rels", b"<Relationships/>")
                        archive.writestr("xl/workbook.xml", b"<workbook/>")
                        archive.writestr("xl/worksheets/sheet1.xml" if name == "bomb.xlsx" else "../escape", payload)
                    with self.assertRaisesRegex(ValueError, f"^{expected}$"):
                        read_scrape_source("douyin", "account", source, workbook)

    @unittest.skipUnless(hasattr(os, "symlink"), "symlink support required")
    def test_rejects_source_under_a_symlinked_ancestor(self) -> None:
        """Would fail if a symlinked directory bypassed the source-file trust boundary."""
        with TemporaryDirectory() as directory:
            real = Path(directory) / "real"
            real.mkdir()
            source = self._write_json(
                str(real),
                "source.json",
                {"data": {"profile": {"nickname": "账号"}, "videos": [{"title": "作品"}]}},
            )
            linked = Path(directory) / "linked"
            os.symlink(real, linked)
            with self.assertRaisesRegex(ValueError, r"^invalid_source_path$"):
                read_scrape_source("douyin", "account", linked / source.name, None)

    def test_reads_opened_json_snapshot_when_path_is_replaced(self) -> None:
        """Would fail if JSON is reopened by path after a successful no-follow open."""
        with TemporaryDirectory() as directory:
            source = self._write_json(
                directory,
                "source.json",
                {"data": {"profile": {"nickname": "原始账号"}, "videos": [{"title": "作品"}]}},
            )
            replacement = self._write_json(
                directory,
                "replacement.json",
                {"data": {"profile": {"nickname": "替换账号"}, "videos": [{"title": "作品"}]}},
            )
            real_open = source_reader._open_source

            def open_then_replace(path: Path, suffix: str, maximum: int):
                opened = real_open(path, suffix, maximum)
                os.replace(replacement, source)
                return opened

            with patch.object(source_reader, "_open_source", side_effect=open_then_replace):
                parsed = read_scrape_source("douyin", "account", source, None)

        self.assertEqual(parsed["subject"]["nickname"], "原始账号")


if __name__ == "__main__":
    unittest.main()
