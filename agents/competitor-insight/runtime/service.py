"""Controlled local file service for evidence-backed competitor reports."""

from __future__ import annotations

from datetime import datetime
from contextlib import contextmanager
import errno
import json
import math
import os
from pathlib import Path
import re
import secrets
import stat
from typing import BinaryIO, Iterator, cast
import zipfile

from contracts import EvidenceBundle, ReportArtifact
from analytics import calculate_metrics, rank_works
from evidence_bundle import build_evidence_bundle, canonical_evidence_input
from report_renderer import assemble_report, validate_final_report
from section_validator import validate_section_batch
from source_reader import read_scrape_source
from workbook_reader import read_account_workbook


PROJECT_ROOT = Path(__file__).resolve().parents[3]
MAX_EXCEL_BYTES = 50 * 1024 * 1024
MAX_XLSX_MEMBERS = 10_000
MAX_XLSX_MEMBER_BYTES = 100 * 1024 * 1024
MAX_XLSX_TOTAL_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
MAX_XLSX_COMPRESSION_RATIO = 100
MAX_EVIDENCE_SESSION_BYTES = 16 * 1024 * 1024
MAX_EVIDENCE_ITEMS = 500
MAX_WARNING_ITEMS = 5_000
MAX_ITEM_METRIC = 1_000_000_000_000

_EVIDENCE_ID = re.compile(r"^[0-9a-f]{16}$")
_TASK_ID = re.compile(r"^competitor-[0-9A-Za-z-]{4,120}$")
_PLATFORMS = {"douyin", "xiaohongshu"}
_INPUT_KINDS = {"account", "content"}
_REQUIRED_XLSX_MEMBERS = {
    "[Content_Types].xml",
    "_rels/.rels",
    "xl/workbook.xml",
}
_EXPECTED_BATCH_IDS = ("strategy", "performance", "execution")
_BATCH_RANKINGS = {
    "strategy": ("overall", "startup"),
    "performance": ("overall", "startup", "collect", "share", "comment"),
    "execution": ("overall", "collect", "share", "comment"),
}
_METRIC_KEYS = (
    "workCount",
    "averageLikes",
    "averageComments",
    "averageCollects",
    "averageShares",
    "averageInteractions",
    "maxInteractions",
    "aboveAverageInteractionCount",
    "top10InteractionShare",
    "maxToAverageMultiple",
)
_DANGEROUS_KEYS = {"__proto__", "constructor", "prototype"}
_SUBJECT_KEYS = {"nickname", "accountId", "signature", "followers"}
_FIELD_MAP_KEYS = {"title", "likes", "comments", "collects", "shares", "publishedAt", "url"}
_AVAILABILITY_KEYS = {"comments", "collects", "shares"}
_RANKING_KEYS = {"overall", "startup", "collect", "share", "comment"}
_ITEM_KEYS = {
    "evidenceId", "sourceRow", "title", "likes", "comments", "collects",
    "shares", "totalInteractions", "publishedAt", "url", "ranks",
}
_WORK_KEYS = {
    "sourceRow", "title", "likes", "comments", "collects", "shares",
    "totalInteractions", "publishedAt", "url",
}
_CONTENT_KEYS = {
    "body", "ocr", "transcript", "transcriptSource", "author",
    "imageCount", "videoDuration",
}
_REPORT_TYPES = {
    ("douyin", "account"): "douyin-account",
    ("douyin", "content"): "douyin-content",
    ("xiaohongshu", "account"): "xhs-account",
    ("xiaohongshu", "content"): "xhs-note",
}
_KNOWN_WORKBOOK_VALUE_ERRORS = {
    "invalid_account_identity",
    "missing_account_identity",
    "missing_account_sheet",
    "wrong_platform_account_sheet",
    "missing_title_field",
    "no_work_rows",
}


_REPORT_COMPONENTS = ("outputs", "competitor-insight", "reports")


def _reports_root() -> Path:
    return PROJECT_ROOT.resolve() / "outputs" / "competitor-insight" / "reports"


def _task_directory(platform_id: str, task_id: str) -> Path:
    return PROJECT_ROOT.resolve() / "outputs" / "competitor-insight" / platform_id / task_id


def _request_text(payload: dict[str, object], field: str) -> str:
    value = payload.get(field)
    if not isinstance(value, str) or not value or "\x00" in value:
        raise ValueError(f"invalid_{field}")
    return value


def _validate_analysis_request(payload: object) -> dict[str, object]:
    fields = {"taskId", "platformId", "inputKind", "outputDir", "dataPath", "excelPath"}
    if not isinstance(payload, dict) or set(payload) != fields:
        raise ValueError("invalid_request_fields")
    request = cast(dict[str, object], payload)
    task_id = _request_text(request, "taskId")
    platform_id = _request_text(request, "platformId")
    input_kind = _request_text(request, "inputKind")
    if not _TASK_ID.fullmatch(task_id):
        raise ValueError("invalid_task_id")
    if platform_id not in _PLATFORMS or input_kind not in _INPUT_KINDS:
        raise ValueError("unsupported_report_source")
    task_dir = _task_directory(platform_id, task_id)
    output_dir = _request_text(request, "outputDir")
    if output_dir != str(task_dir):
        raise ValueError("path_not_allowed")
    data_path = Path(_request_text(request, "dataPath"))
    excel_value = request["excelPath"]
    if excel_value is not None and (not isinstance(excel_value, str) or not excel_value or "\x00" in excel_value):
        raise ValueError("invalid_excelPath")
    excel_path = Path(excel_value) if isinstance(excel_value, str) else None
    for source in (data_path, excel_path):
        if source is None:
            continue
        try:
            source.relative_to(task_dir)
        except ValueError:
            raise ValueError("path_not_allowed") from None
    if data_path.suffix.casefold() != ".json" or (excel_path is not None and excel_path.suffix.casefold() != ".xlsx"):
        raise ValueError("invalid_source_path")
    return {
        "taskId": task_id,
        "platformId": platform_id,
        "inputKind": input_kind,
        "outputDir": task_dir,
        "dataPath": data_path,
        "excelPath": excel_path,
    }


def _open_task_directory(platform_id: str, task_id: str) -> tuple[int, Path]:
    descriptor = _opened_component(None, PROJECT_ROOT.resolve(), directory=True)
    try:
        for component in ("outputs", "competitor-insight", platform_id, task_id):
            next_descriptor = _opened_component(descriptor, component, directory=True)
            os.close(descriptor)
            descriptor = next_descriptor
    except Exception:
        os.close(descriptor)
        raise
    return descriptor, _task_directory(platform_id, task_id)


def _write_task_json(platform_id: str, task_id: str, filename: str, value: object) -> Path:
    directory_fd, task_dir = _open_task_directory(platform_id, task_id)
    content = (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
    temporary = f".{filename}.{secrets.token_hex(16)}.tmp"
    descriptor = -1
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0), 0o600, dir_fd=directory_fd)
        _write_all(descriptor, content)
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        try:
            os.link(temporary, filename, src_dir_fd=directory_fd, dst_dir_fd=directory_fd, follow_symlinks=False)
        except FileExistsError:
            existing = os.open(filename, _open_flags(directory=False), dir_fd=directory_fd)
            try:
                if os.read(existing, len(content) + 1) != content:
                    raise ValueError("invalid_evidence_bundle")
            finally:
                os.close(existing)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            os.unlink(temporary, dir_fd=directory_fd)
        except FileNotFoundError:
            pass
        os.close(directory_fd)
    return task_dir / filename


def _write_task_markdown(platform_id: str, task_id: str, filename: str, markdown: str) -> Path:
    directory_fd, task_dir = _open_task_directory(platform_id, task_id)
    try:
        return task_dir / _atomic_markdown_name(directory_fd, filename, markdown)
    finally:
        os.close(directory_fd)
    raise ValueError("report_filename_exhausted")


def _atomic_markdown_name(directory_fd: int, filename: str, markdown: str) -> str:
    base = Path(filename)
    content = markdown.encode("utf-8")
    for attempt in range(1000):
        suffix = "" if attempt == 0 else f"_{attempt:02d}"
        name = f"{base.stem}{suffix}{base.suffix}"
        temporary = f".{name}.{secrets.token_hex(16)}.tmp"
        descriptor = -1
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0), 0o600, dir_fd=directory_fd)
            _write_all(descriptor, content)
            os.fsync(descriptor)
            os.close(descriptor)
            descriptor = -1
            try:
                os.link(temporary, name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd, follow_symlinks=False)
            except FileExistsError:
                continue
            os.fsync(directory_fd)
            return name
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            try:
                os.unlink(temporary, dir_fd=directory_fd)
            except FileNotFoundError:
                pass
    raise ValueError("report_filename_exhausted")


def _validate_extension(filename: str) -> None:
    if Path(filename).suffix.casefold() != ".xlsx":
        raise ValueError("invalid_extension")


def _validate_size(size: int) -> None:
    if size > MAX_EXCEL_BYTES:
        raise ValueError("excel_too_large")


def _normalized_xlsx_member_name(name: str) -> str:
    normalized = name.replace("\\", "/")
    without_trailing_slash = normalized[:-1] if normalized.endswith("/") else normalized
    parts = without_trailing_slash.split("/")
    if (
        not without_trailing_slash
        or normalized.startswith("/")
        or re.match(r"^[A-Za-z]:", normalized)
        or any(part in {"", ".", ".."} for part in parts)
    ):
        raise ValueError("invalid_xlsx_signature")
    return normalized


def _validate_xlsx_archive(source: Path | BinaryIO) -> None:
    try:
        with zipfile.ZipFile(source) as archive:
            infos = archive.infolist()
            if len(infos) > MAX_XLSX_MEMBERS:
                raise ValueError("xlsx_archive_too_large")
            members: set[str] = set()
            total_uncompressed = 0
            for info in infos:
                normalized_name = _normalized_xlsx_member_name(info.filename)
                if normalized_name in members:
                    raise ValueError("invalid_xlsx_signature")
                members.add(normalized_name)
                if info.flag_bits & 0x1:
                    raise ValueError("invalid_xlsx_signature")
                if info.is_dir():
                    continue
                if (
                    info.file_size < 0
                    or info.compress_size < 0
                    or info.file_size > MAX_XLSX_MEMBER_BYTES
                ):
                    raise ValueError("xlsx_archive_too_large")
                total_uncompressed += info.file_size
                if total_uncompressed > MAX_XLSX_TOTAL_UNCOMPRESSED_BYTES:
                    raise ValueError("xlsx_archive_too_large")
                if info.file_size:
                    if info.compress_size == 0:
                        raise ValueError("xlsx_archive_too_large")
                    if info.file_size / info.compress_size > MAX_XLSX_COMPRESSION_RATIO:
                        raise ValueError("xlsx_archive_too_large")
            if not _REQUIRED_XLSX_MEMBERS.issubset(members):
                raise ValueError("invalid_xlsx_signature")
            if archive.testzip() is not None:
                raise ValueError("invalid_xlsx_signature")
    except (OSError, zipfile.BadZipFile, zipfile.LargeZipFile):
        raise ValueError("invalid_xlsx_signature") from None


def _secure_nofollow_flag() -> int:
    nofollow = getattr(os, "O_NOFOLLOW", None)
    if (
        isinstance(nofollow, bool)
        or not isinstance(nofollow, int)
        or nofollow <= 0
    ):
        raise ValueError("secure_nofollow_unavailable")
    return nofollow


def _secure_directory_flag() -> int:
    directory = getattr(os, "O_DIRECTORY", None)
    if (
        isinstance(directory, bool)
        or not isinstance(directory, int)
        or directory <= 0
    ):
        raise ValueError("secure_directory_unavailable")
    return directory


def _open_flags(*, directory: bool) -> int:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    flags |= _secure_nofollow_flag()
    if directory:
        flags |= _secure_directory_flag()
    return flags


def _opened_component(
    parent_fd: int | None,
    component: str | Path,
    *,
    directory: bool,
) -> int:
    stat_kwargs = (
        {"dir_fd": parent_fd, "follow_symlinks": False}
        if parent_fd is not None
        else {"follow_symlinks": False}
    )
    try:
        before = os.stat(component, **stat_kwargs)
    except FileNotFoundError:
        raise ValueError("invalid_xlsx_path") from None
    except OSError:
        raise ValueError("invalid_xlsx_path") from None
    if stat.S_ISLNK(before.st_mode):
        raise ValueError("symlink_not_allowed")

    open_kwargs = {"dir_fd": parent_fd} if parent_fd is not None else {}
    try:
        descriptor = os.open(component, _open_flags(directory=directory), **open_kwargs)
    except OverflowError:
        raise ValueError("secure_nofollow_unavailable") from None
    except OSError as error:
        if error.errno == errno.ELOOP:
            raise ValueError("symlink_not_allowed") from None
        unsupported_errors = {
            errno.EINVAL,
            getattr(errno, "ENOTSUP", errno.EINVAL),
            getattr(errno, "EOPNOTSUPP", errno.EINVAL),
        }
        if error.errno in unsupported_errors:
            raise ValueError("secure_nofollow_unavailable") from None
        raise ValueError("invalid_xlsx_path") from None
    opened = os.fstat(descriptor)
    expected_type = stat.S_ISDIR if directory else stat.S_ISREG
    if (
        not expected_type(opened.st_mode)
        or (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino)
    ):
        os.close(descriptor)
        if stat.S_ISLNK(before.st_mode):
            raise ValueError("symlink_not_allowed")
        raise ValueError("invalid_xlsx_path")
    return descriptor


def _opened_output_component(
    parent_fd: int | None,
    component: str | Path,
    *,
    create: bool,
) -> int:
    stat_kwargs = (
        {"dir_fd": parent_fd, "follow_symlinks": False}
        if parent_fd is not None
        else {"follow_symlinks": False}
    )
    try:
        before = os.stat(component, **stat_kwargs)
    except FileNotFoundError:
        if not create or parent_fd is None:
            raise ValueError("unsafe_output_path") from None
        try:
            os.mkdir(component, 0o700, dir_fd=parent_fd)
            before = os.stat(component, dir_fd=parent_fd, follow_symlinks=False)
        except (FileExistsError, OSError, TypeError):
            try:
                before = os.stat(component, dir_fd=parent_fd, follow_symlinks=False)
            except (OSError, TypeError):
                raise ValueError("unsafe_output_path") from None
    except (OSError, TypeError):
        raise ValueError("unsafe_output_path") from None
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISDIR(before.st_mode):
        raise ValueError("unsafe_output_path")
    try:
        descriptor = os.open(
            component,
            _open_flags(directory=True),
            **({"dir_fd": parent_fd} if parent_fd is not None else {}),
        )
    except (OverflowError, OSError, TypeError, ValueError):
        raise ValueError("unsafe_output_path") from None
    opened = os.fstat(descriptor)
    if (
        not stat.S_ISDIR(opened.st_mode)
        or (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino)
    ):
        os.close(descriptor)
        raise ValueError("unsafe_output_path")
    return descriptor


def _open_output_directory(*extra_components: str) -> tuple[int, Path]:
    _secure_nofollow_flag()
    try:
        _secure_directory_flag()
    except ValueError:
        raise ValueError("unsafe_output_path") from None
    descriptor = _opened_output_component(None, PROJECT_ROOT, create=False)
    components = (*_REPORT_COMPONENTS, *extra_components)
    try:
        for component in components:
            next_descriptor = _opened_output_component(
                descriptor,
                component,
                create=True,
            )
            os.close(descriptor)
            descriptor = next_descriptor
    except Exception:
        os.close(descriptor)
        raise
    return descriptor, _reports_root().joinpath(*extra_components)


@contextmanager
def _snapshot_file() -> Iterator[int]:
    directory_fd, _path = _open_output_directory(".tmp")
    name = f"snapshot-{secrets.token_hex(16)}.xlsx"
    descriptor = -1
    try:
        descriptor = os.open(
            name,
            os.O_RDWR | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0),
            0o600,
            dir_fd=directory_fd,
        )
        yield descriptor
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            os.unlink(name, dir_fd=directory_fd)
        except FileNotFoundError:
            pass
        os.close(directory_fd)


def _open_controlled_workbook(path_text: str) -> tuple[int, str]:
    _secure_nofollow_flag()
    candidate = Path(path_text)
    if not candidate.is_absolute():
        candidate = PROJECT_ROOT / candidate
    lexical_candidate = Path(os.path.abspath(candidate))
    project_root = Path(os.path.abspath(PROJECT_ROOT))
    lexical_root = project_root / "outputs" / "competitor-insight" / "douyin"
    try:
        relative = lexical_candidate.relative_to(lexical_root)
    except ValueError:
        raise ValueError("path_outside_douyin_output") from None
    _validate_extension(lexical_candidate.name)

    descriptor = _opened_component(None, project_root, directory=True)
    components = (
        "outputs",
        "competitor-insight",
        "douyin",
        *relative.parts,
    )
    try:
        for index, component in enumerate(components):
            next_descriptor = _opened_component(
                descriptor,
                component,
                directory=index < len(components) - 1,
            )
            os.close(descriptor)
            descriptor = next_descriptor
        opened = os.fstat(descriptor)
        _validate_size(opened.st_size)
        return descriptor, lexical_candidate.name
    except Exception:
        os.close(descriptor)
        raise


def _metadata_identity(value: os.stat_result) -> tuple[int, int, int, int]:
    return (
        value.st_dev,
        value.st_ino,
        value.st_size,
        value.st_mtime_ns,
    )


def _copy_open_workbook(descriptor: int, snapshot_descriptor: int) -> None:
    before = os.fstat(descriptor)
    copied = 0
    duplicate = os.dup(descriptor)
    try:
        with os.fdopen(duplicate, "rb") as source:
            source.seek(0)
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                _write_all(snapshot_descriptor, chunk)
                copied += len(chunk)
    except Exception:
        raise
    after = os.fstat(descriptor)
    if (
        copied != before.st_size
        or _metadata_identity(before) != _metadata_identity(after)
    ):
        raise ValueError("workbook_changed_during_read")
    os.lseek(snapshot_descriptor, 0, os.SEEK_SET)


def _safe_source_name(filename: str) -> str:
    normalized = filename.replace("\\", "/")
    return normalized.rsplit("/", 1)[-1] or "upload.xlsx"


def _persist_bundle(
    workbook: BinaryIO,
    source: dict[str, str],
) -> EvidenceBundle:
    try:
        parsed = read_account_workbook(workbook)
    except ValueError as error:
        if str(error) in _KNOWN_WORKBOOK_VALUE_ERRORS:
            raise
        raise ValueError("invalid_workbook") from None
    except Exception:
        raise ValueError("invalid_workbook") from None
    bundle = build_evidence_bundle(parsed, source)
    evidence_id = str(bundle.get("evidenceId", ""))
    if not _EVIDENCE_ID.fullmatch(evidence_id):
        raise ValueError("invalid_evidence_bundle")

    _write_evidence_bundle(bundle)
    _write_legacy_contexts(bundle)
    return bundle


def _write_all(descriptor: int, content: bytes) -> None:
    view = memoryview(content)
    while view:
        written = os.write(descriptor, view)
        if written <= 0:
            raise OSError("short_write")
        view = view[written:]


def _write_evidence_bundle(bundle: EvidenceBundle) -> None:
    directory_fd, _path = _open_output_directory("evidence")
    evidence_id = str(bundle["evidenceId"])
    final_name = f"{evidence_id}.json"
    temp_name = f".{evidence_id}-{secrets.token_hex(16)}.tmp"
    content = (json.dumps(bundle, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
    descriptor = -1
    try:
        descriptor = os.open(
            temp_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0),
            0o600,
            dir_fd=directory_fd,
        )
        _write_all(descriptor, content)
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        try:
            os.link(
                temp_name,
                final_name,
                src_dir_fd=directory_fd,
                dst_dir_fd=directory_fd,
                follow_symlinks=False,
            )
        except FileExistsError:
            existing = os.open(
                final_name,
                _open_flags(directory=False),
                dir_fd=directory_fd,
            )
            try:
                with os.fdopen(os.dup(existing), "rb") as source:
                    if source.read(len(content) + 1) != content:
                        raise ValueError("invalid_evidence_bundle")
            finally:
                os.close(existing)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            os.unlink(temp_name, dir_fd=directory_fd)
        except FileNotFoundError:
            pass
        os.close(directory_fd)


def _write_legacy_contexts(bundle: EvidenceBundle) -> None:
    directory_fd, _path = _open_output_directory("evidence")
    evidence_id = str(bundle["evidenceId"])
    filename = f"{evidence_id}.contexts.json"
    contexts = [
        {
            "batchId": batch_id,
            "allowedEvidenceIds": batch.get("allowedEvidenceIds", []),
        }
        for batch_id, batch in cast(dict[str, dict[str, object]], _batch_inputs(bundle)).items()
    ]
    content = (json.dumps(contexts, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8")
    temporary = f".{evidence_id}-{secrets.token_hex(16)}.contexts.tmp"
    descriptor = -1
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0), 0o600, dir_fd=directory_fd)
        _write_all(descriptor, content)
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        try:
            os.link(temporary, filename, src_dir_fd=directory_fd, dst_dir_fd=directory_fd, follow_symlinks=False)
        except FileExistsError:
            pass
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            os.unlink(temporary, dir_fd=directory_fd)
        except FileNotFoundError:
            pass
        os.close(directory_fd)


def _bounded_evidence_item(item: dict[str, object]) -> dict[str, object]:
    return {
        "evidenceId": str(item.get("evidenceId", "")),
        "title": str(item.get("title", ""))[:500],
        "likes": int(item.get("likes", 0)),
        "comments": int(item.get("comments", 0)),
        "collects": int(item.get("collects", 0)),
        "shares": int(item.get("shares", 0)),
        "totalInteractions": int(item.get("totalInteractions", 0)),
        "publishedAt": str(item.get("publishedAt", ""))[:64],
    }


def _batch_inputs(bundle: EvidenceBundle) -> dict[str, object]:
    items = cast(list[dict[str, object]], bundle.get("items", []))
    by_row = {
        int(item.get("sourceRow", 0)): item
        for item in items
    }
    completeness = cast(dict[str, object], bundle.get("completeness", {}))
    raw_availability = cast(
        dict[str, object],
        completeness.get("availability", {}),
    )
    availability = {
        key: bool(raw_availability.get(key, False))
        for key in ("comments", "collects", "shares")
    }
    raw_rankings = cast(
        dict[str, dict[str, object]],
        bundle.get("rankings", {}),
    )
    raw_metrics = cast(dict[str, object], bundle.get("metrics", {}))
    metrics = {key: raw_metrics.get(key) for key in _METRIC_KEYS}

    if bundle.get("inputKind") == "content":
        item = items[0] if items else {}
        content = cast(dict[str, object], bundle.get("content", {}))
        author = cast(dict[str, object], content.get("author", {}))
        return {
            "content": {
                "batchId": "content",
                "allowedEvidenceIds": [str(item.get("evidenceId", ""))],
                "content": {
                    "title": str(item.get("title", ""))[:500],
                    "body": str(content.get("body", ""))[:2_000],
                    "transcript": str(content.get("transcript", ""))[:2_000],
                },
                "author": {
                    key: value for key, value in author.items()
                    if key in {"nickname", "accountId", "followers", "signature"}
                },
                "evidence": [_bounded_evidence_item(item)],
            },
        }

    result: dict[str, object] = {}
    for batch_id, ranking_names in _BATCH_RANKINGS.items():
        rankings: dict[str, object] = {}
        selected_rows: list[int] = []
        for name in ranking_names:
            ranking = raw_rankings.get(name, {})
            status = (
                ranking.get("status")
                if ranking.get("status") in {"available", "unavailable"}
                else "unavailable"
            )
            rows = [
                int(row)
                for row in cast(list[object], ranking.get("rows", []))[:10]
                if isinstance(row, (int, float)) and not isinstance(row, bool)
            ]
            evidence_ids = [
                str(by_row[row].get("evidenceId", ""))
                for row in rows
                if row in by_row
            ]
            rankings[name] = {
                "status": status,
                "evidenceIds": evidence_ids,
            }
            selected_rows.extend(row for row in rows if row in by_row)

        unique_rows = list(dict.fromkeys(selected_rows))[:30]
        batch_input: dict[str, object] = {
            "batchId": batch_id,
            "allowedEvidenceIds": [
                str(by_row[row].get("evidenceId", "")) for row in unique_rows
            ],
            "availability": dict(availability),
            "rankings": rankings,
            "evidence": [_bounded_evidence_item(by_row[row]) for row in unique_rows],
        }
        if batch_id == "strategy":
            batch_input["account"] = dict(cast(dict[str, object], bundle.get("account", {})))
        if batch_id == "performance":
            batch_input["metrics"] = dict(metrics)
        result[batch_id] = batch_input
    return result


def _evidence_ready(bundle: EvidenceBundle, output_dir: Path | None = None) -> dict[str, object]:
    subject = cast(dict[str, object], bundle.get("subject", bundle.get("account", {})))
    return {
        "ok": True,
        "stage": "evidence_ready",
        "evidenceId": bundle["evidenceId"],
        "platformId": bundle["platformId"],
        "inputKind": bundle["inputKind"],
        "reportType": bundle["reportType"],
        "outputDir": str(output_dir) if output_dir is not None else str(_reports_root()),
        "subjectName": str(subject.get("nickname") or subject.get("accountId") or "未命名对象")[:200],
        "itemCount": len(cast(list[object], bundle.get("items", []))),
        "account": bundle.get("account", {}),
        "completeness": bundle.get("completeness", {}),
        "batchInputs": _batch_inputs(bundle),
    }


def analyze_artifacts(payload: dict[str, object]) -> dict[str, object]:
    """Build task-scoped evidence from one scraper result bundle, never browser bytes."""
    request = _validate_analysis_request(payload)
    platform_id = cast(str, request["platformId"])
    task_id = cast(str, request["taskId"])
    output_dir = cast(Path, request["outputDir"])
    directory_fd, _ = _open_task_directory(platform_id, task_id)
    os.close(directory_fd)
    parsed = read_scrape_source(
        platform_id,
        cast(str, request["inputKind"]),
        cast(Path, request["dataPath"]),
        cast(Path | None, request["excelPath"]),
    )
    source_metadata: dict[str, object] = {
        "kind": "scrape-artifacts",
        "taskId": task_id,
        "platformId": platform_id,
    }
    canonical_input = canonical_evidence_input(parsed, source_metadata)
    bundle = build_evidence_bundle(
        canonical_input["parsed"],
        canonical_input["source"],
    )
    evidence_id = str(bundle.get("evidenceId", ""))
    if not _EVIDENCE_ID.fullmatch(evidence_id):
        raise ValueError("invalid_evidence_bundle")
    subject = cast(dict[str, object], bundle.get("subject", {}))
    evidence_name = f"{_safe_nickname(subject.get('nickname'))}_证据包.json"
    batch_inputs = _batch_inputs(bundle)
    contexts = [
        {
            "batchId": batch_id,
            "allowedEvidenceIds": list(cast(dict[str, object], batch).get("allowedEvidenceIds", [])),
        }
        for batch_id, batch in cast(dict[str, object], batch_inputs).items()
    ]
    session = {
        "sessionVersion": "2.0",
        "evidenceId": evidence_id,
        "canonicalInput": canonical_input,
        "evidence": bundle,
        "trustedBatchContexts": contexts,
    }
    canonical_bundle, _validated_contexts = _validate_task_session(
        session,
        evidence_id=evidence_id,
        platform_id=platform_id,
        input_kind=cast(str, request["inputKind"]),
        task_id=task_id,
    )
    _write_task_json(platform_id, task_id, evidence_name, canonical_bundle)
    _write_task_json(platform_id, task_id, f"{evidence_id}.evidence-session.json", session)
    return _evidence_ready(canonical_bundle, output_dir)


def analyze_path(path_text: str) -> dict[str, object]:
    """Analyze one ordinary XLSX located under the controlled Douyin output."""
    if not isinstance(path_text, str) or not path_text.strip():
        raise ValueError("invalid_path")
    descriptor, source_name = _open_controlled_workbook(path_text)
    try:
        with _snapshot_file() as snapshot_descriptor:
            _copy_open_workbook(descriptor, snapshot_descriptor)
            with os.fdopen(os.dup(snapshot_descriptor), "rb") as snapshot:
                _validate_xlsx_archive(snapshot)
                snapshot.seek(0)
                bundle = _persist_bundle(
                    snapshot,
                    {"kind": "path", "name": source_name},
                )
    finally:
        os.close(descriptor)
    return _evidence_ready(bundle)


def analyze_upload(filename: str, content: bytes) -> dict[str, object]:
    """Analyze an uploaded XLSX from an automatically deleted temporary copy."""
    if not isinstance(filename, str) or not filename.strip():
        raise ValueError("invalid_filename")
    if not isinstance(content, bytes):
        raise ValueError("invalid_upload_content")
    _validate_extension(filename)
    _validate_size(len(content))

    with _snapshot_file() as snapshot_descriptor:
        _write_all(snapshot_descriptor, content)
        os.lseek(snapshot_descriptor, 0, os.SEEK_SET)
        with os.fdopen(os.dup(snapshot_descriptor), "rb") as snapshot:
            _validate_xlsx_archive(snapshot)
            snapshot.seek(0)
            bundle = _persist_bundle(
                snapshot,
                {"kind": "upload", "name": _safe_source_name(filename)},
            )
    return _evidence_ready(bundle)


def _load_evidence(evidence_id: str) -> EvidenceBundle:
    if not isinstance(evidence_id, str) or not _EVIDENCE_ID.fullmatch(evidence_id):
        raise ValueError("invalid_evidence_id")
    directory_fd, _path = _open_output_directory("evidence")
    try:
        descriptor = os.open(
            f"{evidence_id}.json",
            _open_flags(directory=False),
            dir_fd=directory_fd,
        )
    except FileNotFoundError:
        os.close(directory_fd)
        raise ValueError("evidence_not_found") from None
    except OSError:
        os.close(directory_fd)
        raise ValueError("invalid_evidence_bundle") from None
    try:
        with os.fdopen(descriptor, "r", encoding="utf-8") as source:
            loaded = json.load(source)
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise ValueError("invalid_evidence_bundle") from None
    finally:
        os.close(directory_fd)
    return _validate_evidence_bundle(loaded, evidence_id)


def _invalid_bundle() -> None:
    raise ValueError("invalid_evidence_bundle")


def _closed_object(
    value: object,
    required: set[str],
    optional: set[str] | None = None,
) -> dict[str, object]:
    if not isinstance(value, dict):
        _invalid_bundle()
    result = cast(dict[str, object], value)
    allowed = required | (optional or set())
    keys = set(result)
    if _DANGEROUS_KEYS.intersection(keys) or required - keys or keys - allowed:
        _invalid_bundle()
    return result


def _bounded_text(value: object, maximum_bytes: int, *, allow_empty: bool = True) -> str:
    if not isinstance(value, str) or (not allow_empty and not value):
        _invalid_bundle()
    try:
        size = len(value.encode("utf-8"))
    except UnicodeError:
        _invalid_bundle()
    if size > maximum_bytes or "\x00" in value:
        _invalid_bundle()
    return value


def _bounded_integer(value: object, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        _invalid_bundle()
    return value


def _bounded_number_or_none(value: object, minimum: float, maximum: float) -> int | float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _invalid_bundle()
    numeric = float(value)
    if not math.isfinite(numeric) or not minimum <= numeric <= maximum:
        _invalid_bundle()
    return value


def _bounded_string_list(
    value: object,
    *,
    maximum_items: int,
    maximum_item_bytes: int,
    allowed_values: set[str] | None = None,
) -> list[str]:
    if not isinstance(value, list) or len(value) > maximum_items:
        _invalid_bundle()
    result: list[str] = []
    for item in value:
        text = _bounded_text(item, maximum_item_bytes, allow_empty=False)
        if allowed_values is not None and text not in allowed_values:
            _invalid_bundle()
        result.append(text)
    if len(result) != len(set(result)) and allowed_values is not None:
        _invalid_bundle()
    return result


def _validate_subject(value: object, *, require_nickname: bool = False) -> dict[str, object]:
    subject = _closed_object(value, {"nickname"} if require_nickname else set(), _SUBJECT_KEYS)
    if not subject or not any(subject.get(key) not in (None, "") for key in ("nickname", "accountId")):
        _invalid_bundle()
    if "nickname" in subject:
        _bounded_text(subject["nickname"], 200)
    if "accountId" in subject:
        _bounded_text(subject["accountId"], 256, allow_empty=False)
    if "signature" in subject:
        _bounded_text(subject["signature"], 1_000, allow_empty=False)
    if "followers" in subject:
        _bounded_integer(subject["followers"], 0, MAX_ITEM_METRIC)
    return subject


def _validate_field_map(value: object, *, task_source: bool) -> dict[str, object]:
    required = _FIELD_MAP_KEYS if task_source else set()
    field_map = _closed_object(value, required, _FIELD_MAP_KEYS)
    for mapped in field_map.values():
        _bounded_text(mapped, 200, allow_empty=False)
    return field_map


def _validate_content(value: object) -> dict[str, object]:
    content = _closed_object(value, set(), _CONTENT_KEYS)
    if not content:
        _invalid_bundle()
    for field in ("body", "ocr", "transcript"):
        if field in content:
            _bounded_text(content[field], 65_536, allow_empty=False)
    if "transcriptSource" in content:
        transcript_source = _bounded_text(content["transcriptSource"], 64, allow_empty=False)
        if transcript_source not in {
            "transcription.transcript",
            "transcription.cleaned_transcript",
            "item.transcript",
        } or "transcript" not in content:
            _invalid_bundle()
    if "author" in content:
        _validate_subject(content["author"], require_nickname=False)
    for field in ("imageCount", "videoDuration"):
        if field in content:
            _bounded_integer(content[field], 0, 1_000_000_000)
    return content


def _validate_source(value: object, platform_id: str, *, task_source: bool) -> dict[str, object]:
    if task_source:
        source = _closed_object(value, {"kind", "taskId", "platformId"})
        if source.get("kind") != "scrape-artifacts" or source.get("platformId") != platform_id:
            _invalid_bundle()
        task_id = _bounded_text(source["taskId"], 128, allow_empty=False)
        if not _TASK_ID.fullmatch(task_id):
            _invalid_bundle()
        return source
    source = _closed_object(value, {"kind", "name"})
    if source.get("kind") not in {"path", "upload"}:
        _invalid_bundle()
    _bounded_text(source["name"], 1_024, allow_empty=False)
    return source


def _validate_completeness(value: object, *, task_source: bool) -> dict[str, object]:
    completeness = _closed_object(
        value,
        {"fieldMap", "missingFields", "warnings", "availability"},
    )
    _validate_field_map(completeness["fieldMap"], task_source=task_source)
    _bounded_string_list(
        completeness["missingFields"],
        maximum_items=len(_FIELD_MAP_KEYS),
        maximum_item_bytes=32,
        allowed_values=_FIELD_MAP_KEYS,
    )
    _bounded_string_list(
        completeness["warnings"],
        maximum_items=MAX_WARNING_ITEMS,
        maximum_item_bytes=1_000,
    )
    availability = _closed_object(completeness["availability"], _AVAILABILITY_KEYS)
    if any(type(availability[key]) is not bool for key in _AVAILABILITY_KEYS):
        _invalid_bundle()
    return completeness


def _validate_metrics(value: object, item_count: int) -> dict[str, object]:
    metrics = _closed_object(value, set(_METRIC_KEYS))
    if metrics["workCount"] != item_count:
        _invalid_bundle()
    _bounded_integer(metrics["workCount"], 1, MAX_EVIDENCE_ITEMS)
    _bounded_integer(metrics["maxInteractions"], 0, MAX_ITEM_METRIC * 4)
    _bounded_integer(metrics["aboveAverageInteractionCount"], 0, item_count)
    for key in (
        "averageLikes", "averageComments", "averageCollects", "averageShares",
        "averageInteractions",
    ):
        if not isinstance(metrics[key], float):
            _invalid_bundle()
        _bounded_number_or_none(metrics[key], 0, MAX_ITEM_METRIC * 4)
    top_share = metrics["top10InteractionShare"]
    if top_share is not None and not isinstance(top_share, float):
        _invalid_bundle()
    _bounded_number_or_none(top_share, 0, 1)
    multiple = metrics["maxToAverageMultiple"]
    if multiple is not None and not isinstance(multiple, float):
        _invalid_bundle()
    _bounded_number_or_none(multiple, 0, MAX_EVIDENCE_ITEMS)
    return metrics


def _validate_row_list(
    value: object,
    *,
    maximum_items: int,
    known_rows: set[int],
) -> list[int]:
    if not isinstance(value, list) or len(value) > maximum_items:
        _invalid_bundle()
    rows = [_bounded_integer(row, 1, 20_000) for row in value]
    if len(rows) != len(set(rows)) or any(row not in known_rows for row in rows):
        _invalid_bundle()
    return rows


def _validate_rankings(
    value: object,
    *,
    input_kind: str,
    known_rows: set[int],
    availability: dict[str, object],
) -> dict[str, object]:
    if input_kind == "content":
        rankings = _closed_object(value, set())
        return rankings
    rankings = _closed_object(value, _RANKING_KEYS)
    for name in ("overall", "collect", "share", "comment"):
        ranking = _closed_object(rankings[name], {"status", "rows"})
        status = ranking["status"]
        if status not in {"available", "unavailable"}:
            _invalid_bundle()
        maximum = 10 if name == "overall" else 5
        rows = _validate_row_list(ranking["rows"], maximum_items=maximum, known_rows=known_rows)
        availability_key = {
            "collect": "collects",
            "share": "shares",
            "comment": "comments",
        }.get(name)
        expected_available = (
            True
            if name == "overall"
            else availability[cast(str, availability_key)] is True
        )
        if (status == "available") != expected_available or (status == "unavailable" and rows):
            _invalid_bundle()
    startup = _closed_object(rankings["startup"], {"status", "rows", "sampleRows"})
    if startup["status"] != "available":
        _invalid_bundle()
    startup_rows = _validate_row_list(startup["rows"], maximum_items=5, known_rows=known_rows)
    sample_rows = _validate_row_list(
        startup["sampleRows"],
        maximum_items=math.ceil(MAX_EVIDENCE_ITEMS * 0.25),
        known_rows=known_rows,
    )
    if any(row not in sample_rows for row in startup_rows):
        _invalid_bundle()
    return rankings


def _validate_item(
    value: object,
    *,
    expected_id: str,
    input_kind: str,
) -> dict[str, object]:
    item = _closed_object(value, _ITEM_KEYS)
    if item["evidenceId"] != expected_id:
        _invalid_bundle()
    _bounded_integer(item["sourceRow"], 1, 20_000)
    _bounded_text(item["title"], 32_768)
    total = 0
    for field in ("likes", "comments", "collects", "shares"):
        total += _bounded_integer(item[field], 0, MAX_ITEM_METRIC)
    if _bounded_integer(item["totalInteractions"], 0, MAX_ITEM_METRIC * 4) != total:
        _invalid_bundle()
    published_at = _bounded_text(item["publishedAt"], 64)
    if published_at:
        try:
            datetime.fromisoformat(published_at)
        except ValueError:
            _invalid_bundle()
    _bounded_text(item["url"], 4_096)
    expected_rank_keys = _RANKING_KEYS if input_kind == "account" else set()
    ranks = _closed_object(item["ranks"], expected_rank_keys)
    for rank in ranks.values():
        if rank is not None:
            _bounded_integer(rank, 1, MAX_EVIDENCE_ITEMS)
    return item


def _validate_evidence_bundle(
    loaded: object,
    evidence_id: str,
    *,
    task_source: bool = False,
) -> EvidenceBundle:
    common = {
        "evidenceVersion", "evidenceId", "platformId", "inputKind", "reportType",
        "source", "subject", "account", "completeness", "metrics", "rankings", "items",
    }
    if not isinstance(loaded, dict):
        _invalid_bundle()
    input_kind = loaded.get("inputKind")
    required = common | ({"content"} if input_kind == "content" else set())
    bundle = _closed_object(loaded, required)
    if bundle["evidenceVersion"] != "2.0" or bundle["evidenceId"] != evidence_id:
        _invalid_bundle()
    platform_id = bundle["platformId"]
    if platform_id not in _PLATFORMS or input_kind not in _INPUT_KINDS:
        _invalid_bundle()
    if bundle["reportType"] != _REPORT_TYPES[(cast(str, platform_id), cast(str, input_kind))]:
        _invalid_bundle()
    _validate_source(bundle["source"], cast(str, platform_id), task_source=task_source)
    subject = _validate_subject(bundle["subject"], require_nickname=task_source)
    account = _validate_subject(bundle["account"], require_nickname=task_source)
    if subject != account:
        _invalid_bundle()
    completeness = _validate_completeness(bundle["completeness"], task_source=task_source)
    raw_items = bundle["items"]
    if not isinstance(raw_items, list) or not 1 <= len(raw_items) <= MAX_EVIDENCE_ITEMS:
        _invalid_bundle()
    if input_kind == "content" and len(raw_items) != 1:
        _invalid_bundle()
    prefix = "DY" if platform_id == "douyin" else "XHS"
    items = [
        _validate_item(item, expected_id=f"{prefix}-E{index:04d}", input_kind=cast(str, input_kind))
        for index, item in enumerate(raw_items, start=1)
    ]
    source_rows = [cast(int, item["sourceRow"]) for item in items]
    if len(source_rows) != len(set(source_rows)) or source_rows != sorted(source_rows):
        _invalid_bundle()
    _validate_metrics(bundle["metrics"], len(items))
    availability = cast(dict[str, object], completeness["availability"])
    _validate_rankings(
        bundle["rankings"],
        input_kind=cast(str, input_kind),
        known_rows=set(source_rows),
        availability=availability,
    )
    if input_kind == "content":
        _validate_content(bundle["content"])
    return cast(EvidenceBundle, bundle)


def _validate_canonical_work(value: object) -> dict[str, object]:
    work = _closed_object(value, _WORK_KEYS)
    _bounded_integer(work["sourceRow"], 1, 20_000)
    _bounded_text(work["title"], 32_768)
    total = 0
    for field in ("likes", "comments", "collects", "shares"):
        total += _bounded_integer(work[field], 0, MAX_ITEM_METRIC)
    if _bounded_integer(work["totalInteractions"], 0, MAX_ITEM_METRIC * 4) != total:
        _invalid_bundle()
    published_at = work["publishedAt"]
    if published_at is not None:
        text = _bounded_text(published_at, 64)
        if text:
            try:
                datetime.fromisoformat(text)
            except ValueError:
                _invalid_bundle()
    _bounded_text(work["url"], 4_096)
    return work


def _validate_canonical_input(
    value: object,
    *,
    platform_id: str,
    input_kind: str,
    task_id: str,
) -> dict[str, object]:
    canonical = _closed_object(value, {"parsed", "source"})
    source = _validate_source(canonical["source"], platform_id, task_source=True)
    if source["taskId"] != task_id:
        _invalid_bundle()
    parsed = _closed_object(
        canonical["parsed"],
        {
            "platformId", "inputKind", "reportType", "subject", "fieldMap",
            "missingFields", "warnings", "works", "content",
        },
    )
    if (
        parsed["platformId"] != platform_id
        or parsed["inputKind"] != input_kind
        or parsed["reportType"] != _REPORT_TYPES[(platform_id, input_kind)]
    ):
        _invalid_bundle()
    _validate_subject(parsed["subject"], require_nickname=True)
    _validate_field_map(parsed["fieldMap"], task_source=True)
    _bounded_string_list(
        parsed["missingFields"],
        maximum_items=len(_FIELD_MAP_KEYS),
        maximum_item_bytes=32,
        allowed_values=_FIELD_MAP_KEYS,
    )
    _bounded_string_list(
        parsed["warnings"],
        maximum_items=MAX_WARNING_ITEMS,
        maximum_item_bytes=1_000,
    )
    works = parsed["works"]
    if not isinstance(works, list) or not 1 <= len(works) <= MAX_EVIDENCE_ITEMS:
        _invalid_bundle()
    validated_works = [_validate_canonical_work(work) for work in works]
    rows = [cast(int, work["sourceRow"]) for work in validated_works]
    if rows != sorted(rows) or len(rows) != len(set(rows)):
        _invalid_bundle()
    content = parsed["content"]
    if input_kind == "content":
        if len(works) != 1:
            _invalid_bundle()
        _validate_content(content)
    elif content != {}:
        _invalid_bundle()
    return canonical


def _recompute_bundle_derivatives(bundle: EvidenceBundle) -> None:
    works = [
        {
            key: item[key]
            for key in _WORK_KEYS
        }
        for item in cast(list[dict[str, object]], bundle["items"])
    ]
    completeness = cast(dict[str, object], bundle["completeness"])
    availability = cast(dict[str, bool], completeness["availability"])
    rankings = rank_works(
        works,
        dict(availability),
        account=bundle["inputKind"] == "account",
    )
    metrics = calculate_metrics(works, rankings)
    if rankings != bundle["rankings"] or metrics != bundle["metrics"]:
        _invalid_bundle()


def _validate_task_session(
    loaded: object,
    *,
    evidence_id: str,
    platform_id: str,
    input_kind: str,
    task_id: str,
) -> tuple[EvidenceBundle, list[dict[str, object]]]:
    try:
        encoded_size = len(
            json.dumps(loaded, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        )
    except (TypeError, UnicodeError, ValueError):
        _invalid_bundle()
    if encoded_size > MAX_EVIDENCE_SESSION_BYTES:
        _invalid_bundle()
    session = _closed_object(
        loaded,
        {"sessionVersion", "evidenceId", "canonicalInput", "evidence", "trustedBatchContexts"},
    )
    if session["sessionVersion"] != "2.0" or session["evidenceId"] != evidence_id:
        _invalid_bundle()
    canonical = _validate_canonical_input(
        session["canonicalInput"],
        platform_id=platform_id,
        input_kind=input_kind,
        task_id=task_id,
    )
    persisted = _validate_evidence_bundle(session["evidence"], evidence_id, task_source=True)
    if persisted["platformId"] != platform_id or persisted["inputKind"] != input_kind:
        _invalid_bundle()
    persisted_source = cast(dict[str, object], persisted["source"])
    if persisted_source["taskId"] != task_id:
        _invalid_bundle()
    _recompute_bundle_derivatives(persisted)
    try:
        rebuilt = build_evidence_bundle(
            cast(dict[str, object], canonical["parsed"]),
            cast(dict[str, object], canonical["source"]),
        )
        rebuilt = _validate_evidence_bundle(rebuilt, evidence_id, task_source=True)
    except (KeyError, TypeError, ValueError, OverflowError):
        _invalid_bundle()
    if rebuilt != persisted or rebuilt["evidenceId"] != evidence_id:
        _invalid_bundle()
    contexts = _validate_contexts(rebuilt, session["trustedBatchContexts"])
    return rebuilt, contexts


def _validate_contexts(bundle: EvidenceBundle, contexts: object) -> list[dict[str, object]]:
    if not isinstance(contexts, list):
        raise ValueError("invalid_evidence_bundle")
    expected = ("content",) if bundle.get("inputKind") == "content" else _EXPECTED_BATCH_IDS
    known = {
        item.get("evidenceId") for item in cast(list[dict[str, object]], bundle.get("items", []))
        if isinstance(item, dict) and isinstance(item.get("evidenceId"), str)
    }
    by_id: dict[str, dict[str, object]] = {}
    for context in contexts:
        if not isinstance(context, dict) or set(context) != {"batchId", "allowedEvidenceIds"} or not isinstance(context.get("batchId"), str) or not isinstance(context.get("allowedEvidenceIds"), list):
            raise ValueError("invalid_evidence_bundle")
        batch_id = cast(str, context["batchId"])
        allowed = context["allowedEvidenceIds"]
        if batch_id in by_id or not allowed or len(allowed) > 30 or any(not isinstance(item, str) or item not in known for item in allowed) or len(set(allowed)) != len(allowed):
            raise ValueError("invalid_evidence_bundle")
        by_id[batch_id] = cast(dict[str, object], context)
    if set(by_id) != set(expected):
        raise ValueError("invalid_evidence_bundle")
    canonical_inputs = _batch_inputs(bundle)
    canonical = [
        {"batchId": batch_id, "allowedEvidenceIds": cast(dict[str, object], batch)["allowedEvidenceIds"]}
        for batch_id, batch in cast(dict[str, object], canonical_inputs).items()
    ]
    persisted = [by_id[batch_id] for batch_id in expected]
    if persisted != canonical:
        raise ValueError("invalid_evidence_bundle")
    return persisted


def _legacy_contexts(evidence_id: str) -> list[dict[str, object]]:
    directory_fd, _path = _open_output_directory("evidence")
    try:
        descriptor = os.open(f"{evidence_id}.contexts.json", _open_flags(directory=False), dir_fd=directory_fd)
        try:
            with os.fdopen(descriptor, "r", encoding="utf-8") as source:
                loaded = json.load(source)
        except (OSError, UnicodeError, json.JSONDecodeError):
            raise ValueError("invalid_evidence_bundle") from None
    except FileNotFoundError:
        raise ValueError("invalid_evidence_bundle") from None
    finally:
        os.close(directory_fd)
    if not isinstance(loaded, list):
        raise ValueError("invalid_evidence_bundle")
    return cast(list[dict[str, object]], loaded)


def _task_session(evidence_id: str, output_dir_text: str) -> tuple[EvidenceBundle, list[dict[str, object]]]:
    if not isinstance(evidence_id, str) or not _EVIDENCE_ID.fullmatch(evidence_id):
        raise ValueError("invalid_evidence_id")
    candidate = Path(output_dir_text)
    root = PROJECT_ROOT.resolve() / "outputs" / "competitor-insight"
    try:
        platform_id, task_id = candidate.relative_to(root).parts
    except ValueError:
        raise ValueError("path_not_allowed") from None
    if platform_id not in _PLATFORMS or not _TASK_ID.fullmatch(task_id) or output_dir_text != str(_task_directory(platform_id, task_id)):
        raise ValueError("path_not_allowed")
    directory_fd, _task_dir = _open_task_directory(platform_id, task_id)
    try:
        descriptor = os.open(f"{evidence_id}.evidence-session.json", _open_flags(directory=False), dir_fd=directory_fd)
        try:
            with os.fdopen(descriptor, "rb") as source:
                if os.fstat(source.fileno()).st_size > MAX_EVIDENCE_SESSION_BYTES:
                    raise ValueError("invalid_evidence_bundle")
                payload = source.read(MAX_EVIDENCE_SESSION_BYTES + 1)
            if len(payload) > MAX_EVIDENCE_SESSION_BYTES:
                raise ValueError("invalid_evidence_bundle")
            loaded = json.loads(payload.decode("utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            raise ValueError("invalid_evidence_bundle") from None
    except FileNotFoundError:
        raise ValueError("evidence_not_found") from None
    finally:
        os.close(directory_fd)
    if not isinstance(loaded, dict) or loaded.get("evidenceId") != evidence_id:
        raise ValueError("invalid_evidence_bundle")
    raw_evidence = loaded.get("evidence")
    if not isinstance(raw_evidence, dict) or raw_evidence.get("inputKind") not in _INPUT_KINDS:
        raise ValueError("invalid_evidence_bundle")
    return _validate_task_session(
        loaded,
        evidence_id=evidence_id,
        platform_id=platform_id,
        input_kind=cast(str, raw_evidence["inputKind"]),
        task_id=task_id,
    )


def _context_for_batch(contexts: list[dict[str, object]], batch: object) -> dict[str, object]:
    if not isinstance(batch, dict) or not isinstance(batch.get("batchId"), str):
        raise ValueError("expected_section_batch_object")
    batch_id = cast(str, batch["batchId"])
    for context in contexts:
        if context.get("batchId") == batch_id:
            return context
    raise ValueError("missing_trusted_batch_context")


def validate_batch(evidence_id: str, batch: object, output_dir: str | None = None) -> dict[str, object]:
    """Validate one batch against evidence freshly loaded from controlled disk."""
    if output_dir is None:
        bundle = _load_evidence(evidence_id)
        contexts = _legacy_contexts(evidence_id)
    else:
        bundle, contexts = _task_session(evidence_id, output_dir)
    validated = validate_section_batch(batch, bundle, _context_for_batch(contexts, batch))
    return {
        "ok": True,
        "stage": "section_validated",
        "evidenceId": evidence_id,
        "batchId": validated["batchId"],
        "batch": validated,
    }


def _validated_batches(
    bundle: EvidenceBundle,
    batches: list[object],
) -> list[dict[str, object]]:
    if not isinstance(batches, list):
        raise ValueError("invalid_batches")
    contexts = _legacy_contexts(str(bundle["evidenceId"]))
    validated = [
        validate_section_batch(batch, bundle, _context_for_batch(contexts, batch))
        for batch in batches
    ]
    by_id: dict[str, dict[str, object]] = {}
    for batch in validated:
        batch_id = str(batch["batchId"])
        if batch_id in by_id:
            raise ValueError(f"duplicate_batch_id:{batch_id}")
        by_id[batch_id] = batch
    for batch_id in _EXPECTED_BATCH_IDS:
        if batch_id not in by_id:
            raise ValueError(f"missing_batch_id:{batch_id}")
    extras = sorted(set(by_id) - set(_EXPECTED_BATCH_IDS))
    if extras:
        raise ValueError(f"invalid_batch_id:{extras[0]}")
    return [by_id[batch_id] for batch_id in _EXPECTED_BATCH_IDS]


def _safe_nickname(value: object) -> str:
    nickname = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff_-]+", "_", str(value or ""))
    nickname = nickname.strip("._-")
    return nickname[:80] or "未命名账号"


def _write_report(filename: str, markdown: str) -> Path:
    reports_fd, reports_root = _open_output_directory()
    try:
        return reports_root / _atomic_markdown_name(reports_fd, filename, markdown)
    finally:
        os.close(reports_fd)


def assemble(evidence_id: str, batches: list[object], output_dir: str | None = None) -> ReportArtifact:
    """Validate all three batches, render, validate again, and persist the report."""
    if output_dir is None:
        bundle = _load_evidence(evidence_id)
        contexts = _legacy_contexts(evidence_id)
    else:
        bundle, contexts = _task_session(evidence_id, output_dir)
    validated_batches = [
        validate_section_batch(batch, bundle, _context_for_batch(contexts, batch))
        for batch in batches
    ]
    by_id = {str(batch["batchId"]): batch for batch in validated_batches}
    expected = ("content",) if bundle.get("inputKind") == "content" else _EXPECTED_BATCH_IDS
    if len(validated_batches) != len(by_id):
        duplicate = next(
            batch["batchId"]
            for batch in validated_batches
            if sum(1 for item in validated_batches if item["batchId"] == batch["batchId"]) > 1
        )
        raise ValueError(f"duplicate_batch_id:{duplicate}")
    for batch_id in expected:
        if batch_id not in by_id:
            raise ValueError(f"missing_batch_id:{batch_id}")
    extras = sorted(set(by_id) - set(expected))
    if extras:
        raise ValueError(f"invalid_batch_id:{extras[0]}")
    validated_batches = [by_id[batch_id] for batch_id in expected]
    markdown = assemble_report(bundle, validated_batches, contexts)
    validation_errors = validate_final_report(markdown, bundle, validated_batches, contexts)
    if validation_errors:
        raise ValueError(f"final_report_validation_failed:{validation_errors[0]}")

    account = bundle.get("account", {})
    nickname = account.get("nickname") if isinstance(account, dict) else None
    filename = (
        f"{_safe_nickname(nickname)}_抖音账号分析报告_"
        f"{datetime.now().strftime('%Y%m%d_%H%M%S')}.md"
    )
    if output_dir is None:
        report_path = _write_report(filename, markdown)
    else:
        relative = Path(output_dir).relative_to(PROJECT_ROOT.resolve() / "outputs" / "competitor-insight")
        report_path = _write_task_markdown(relative.parts[0], relative.parts[1], filename, markdown)
    return cast(
        ReportArtifact,
        {
            "ok": True,
            "stage": "report_ready",
            "filename": report_path.name,
            "reportPath": str(report_path),
            "markdown": markdown,
            "validationErrors": [],
        },
    )
