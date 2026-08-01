"""Controlled local file service for evidence-backed competitor reports."""

from __future__ import annotations

from datetime import datetime
from contextlib import contextmanager
import errno
import json
import os
from pathlib import Path
import re
import secrets
import stat
from typing import BinaryIO, Iterator, cast
import zipfile

from contracts import EvidenceBundle, ReportArtifact
from evidence_bundle import build_evidence_bundle
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
    base = Path(filename)
    try:
        for attempt in range(1000):
            suffix = "" if attempt == 0 else f"_{attempt:02d}"
            name = f"{base.stem}{suffix}{base.suffix}"
            try:
                descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0), 0o600, dir_fd=directory_fd)
            except FileExistsError:
                continue
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                output.write(markdown)
            return task_dir / name
    finally:
        os.close(directory_fd)
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
    bundle = build_evidence_bundle(parsed, {
        "kind": "scrape-artifacts",
        "taskId": task_id,
        "platformId": platform_id,
    })
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
    _write_task_json(platform_id, task_id, evidence_name, bundle)
    _write_task_json(platform_id, task_id, f"{evidence_id}.evidence-session.json", {
        "evidenceId": evidence_id,
        "evidence": bundle,
        "trustedBatchContexts": contexts,
    })
    return _evidence_ready(bundle, output_dir)


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
    required = {
        "evidenceVersion",
        "evidenceId",
        "platformId",
        "inputKind",
        "reportType",
        "account",
        "completeness",
        "metrics",
        "rankings",
        "items",
    }
    if (
        not isinstance(loaded, dict)
        or loaded.get("evidenceVersion") != "2.0"
        or loaded.get("evidenceId") != evidence_id
        or not required.issubset(loaded)
    ):
        raise ValueError("invalid_evidence_bundle")
    return cast(EvidenceBundle, loaded)


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
            with os.fdopen(descriptor, "r", encoding="utf-8") as source:
                loaded = json.load(source)
        except (OSError, UnicodeError, json.JSONDecodeError):
            raise ValueError("invalid_evidence_bundle") from None
    except FileNotFoundError:
        raise ValueError("evidence_not_found") from None
    finally:
        os.close(directory_fd)
    if not isinstance(loaded, dict) or loaded.get("evidenceId") != evidence_id or not isinstance(loaded.get("evidence"), dict) or not isinstance(loaded.get("trustedBatchContexts"), list):
        raise ValueError("invalid_evidence_bundle")
    return cast(EvidenceBundle, loaded["evidence"]), cast(list[dict[str, object]], loaded["trustedBatchContexts"])


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
    base = Path(filename)
    for attempt in range(1000):
        suffix = "" if attempt == 0 else f"_{attempt:02d}"
        target = reports_root / f"{base.stem}{suffix}{base.suffix}"
        try:
            descriptor = os.open(
                target.name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0),
                0o600,
                dir_fd=reports_fd,
            )
        except FileExistsError:
            continue
        except Exception:
            os.close(reports_fd)
            raise
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                output.write(markdown)
        except Exception:
            try:
                os.unlink(target.name, dir_fd=reports_fd)
            except FileNotFoundError:
                pass
            os.close(reports_fd)
            raise
        os.close(reports_fd)
        return target
    os.close(reports_fd)
    raise ValueError("report_filename_exhausted")


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
