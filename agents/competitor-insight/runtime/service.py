"""Controlled local file service for evidence-backed competitor reports."""

from __future__ import annotations

from datetime import datetime
import errno
import json
import os
from pathlib import Path
import re
import stat
from tempfile import TemporaryDirectory
from typing import cast
import zipfile

from contracts import EvidenceBundle, ReportArtifact
from evidence_bundle import build_evidence_bundle, write_evidence_bundle
from report_renderer import assemble_report, validate_final_report
from section_validator import validate_section_batch
from workbook_reader import read_account_workbook


PROJECT_ROOT = Path(__file__).resolve().parents[3]
MAX_EXCEL_BYTES = 50 * 1024 * 1024
MAX_XLSX_MEMBERS = 10_000
MAX_XLSX_MEMBER_BYTES = 100 * 1024 * 1024
MAX_XLSX_TOTAL_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
MAX_XLSX_COMPRESSION_RATIO = 100

_EVIDENCE_ID = re.compile(r"^[0-9a-f]{16}$")
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
    "missing_title_field",
    "no_work_rows",
}


def _reports_root() -> Path:
    path = PROJECT_ROOT / "outputs" / "competitor-insight" / "reports"
    path.mkdir(parents=True, exist_ok=True)
    return path.resolve()


def _temporary_root() -> Path:
    path = _reports_root() / ".tmp"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _evidence_root() -> Path:
    path = _reports_root() / "evidence"
    path.mkdir(parents=True, exist_ok=True)
    return path


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


def _validate_xlsx_archive(source: Path) -> None:
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


def _open_flags(*, directory: bool) -> int:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    flags |= _secure_nofollow_flag()
    if directory:
        flags |= getattr(os, "O_DIRECTORY", 0)
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


def _copy_open_workbook(descriptor: int, snapshot: Path) -> None:
    before = os.fstat(descriptor)
    copied = 0
    duplicate = os.dup(descriptor)
    try:
        with os.fdopen(duplicate, "rb") as source, snapshot.open("xb") as destination:
            source.seek(0)
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                destination.write(chunk)
                copied += len(chunk)
    except Exception:
        snapshot.unlink(missing_ok=True)
        raise
    after = os.fstat(descriptor)
    if (
        copied != before.st_size
        or _metadata_identity(before) != _metadata_identity(after)
    ):
        snapshot.unlink(missing_ok=True)
        raise ValueError("workbook_changed_during_read")


def _safe_source_name(filename: str) -> str:
    normalized = filename.replace("\\", "/")
    return normalized.rsplit("/", 1)[-1] or "upload.xlsx"


def _persist_bundle(
    workbook_path: Path,
    source: dict[str, str],
    staging_dir: Path | None = None,
) -> EvidenceBundle:
    try:
        parsed = read_account_workbook(workbook_path)
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

    if staging_dir is not None:
        staged = write_evidence_bundle(bundle, staging_dir)
        os.replace(staged, _evidence_root() / f"{evidence_id}.json")
        return bundle

    with TemporaryDirectory(dir=_temporary_root()) as directory:
        staged = write_evidence_bundle(bundle, Path(directory))
        os.replace(staged, _evidence_root() / f"{evidence_id}.json")
    return bundle


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
            "availability": dict(availability),
            "rankings": rankings,
            "evidence": [_bounded_evidence_item(by_row[row]) for row in unique_rows],
        }
        if batch_id == "performance":
            batch_input["metrics"] = dict(metrics)
        result[batch_id] = batch_input
    return result


def _evidence_ready(bundle: EvidenceBundle) -> dict[str, object]:
    return {
        "ok": True,
        "stage": "evidence_ready",
        "evidenceId": bundle["evidenceId"],
        "account": bundle.get("account", {}),
        "completeness": bundle.get("completeness", {}),
        "batchInputs": _batch_inputs(bundle),
    }


def analyze_path(path_text: str) -> dict[str, object]:
    """Analyze one ordinary XLSX located under the controlled Douyin output."""
    if not isinstance(path_text, str) or not path_text.strip():
        raise ValueError("invalid_path")
    descriptor, source_name = _open_controlled_workbook(path_text)
    try:
        with TemporaryDirectory(dir=_temporary_root()) as directory:
            staging_dir = Path(directory)
            workbook_path = staging_dir / "workbook.xlsx"
            _copy_open_workbook(descriptor, workbook_path)
            _validate_xlsx_archive(workbook_path)
            bundle = _persist_bundle(
                workbook_path,
                {"kind": "path", "name": source_name},
                staging_dir,
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

    with TemporaryDirectory(dir=_temporary_root()) as directory:
        staging_dir = Path(directory)
        workbook_path = staging_dir / "upload.xlsx"
        workbook_path.write_bytes(content)
        _validate_xlsx_archive(workbook_path)
        bundle = _persist_bundle(
            workbook_path,
            {"kind": "upload", "name": _safe_source_name(filename)},
            staging_dir,
        )
    return _evidence_ready(bundle)


def _load_evidence(evidence_id: str) -> EvidenceBundle:
    if not isinstance(evidence_id, str) or not _EVIDENCE_ID.fullmatch(evidence_id):
        raise ValueError("invalid_evidence_id")
    path = _evidence_root() / f"{evidence_id}.json"
    if path.is_symlink():
        raise ValueError("invalid_evidence_bundle")
    if not path.is_file():
        raise ValueError("evidence_not_found")
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise ValueError("invalid_evidence_bundle") from None
    required = {
        "evidenceVersion",
        "evidenceId",
        "account",
        "completeness",
        "metrics",
        "rankings",
        "items",
    }
    if (
        not isinstance(loaded, dict)
        or loaded.get("evidenceVersion") != "1.0"
        or loaded.get("evidenceId") != evidence_id
        or not required.issubset(loaded)
    ):
        raise ValueError("invalid_evidence_bundle")
    return cast(EvidenceBundle, loaded)


def validate_batch(evidence_id: str, batch: object) -> dict[str, object]:
    """Validate one batch against evidence freshly loaded from controlled disk."""
    bundle = _load_evidence(evidence_id)
    validated = validate_section_batch(batch, bundle)
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
    validated = [validate_section_batch(batch, bundle) for batch in batches]
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
    reports_root = _reports_root()
    base = Path(filename)
    for attempt in range(1000):
        suffix = "" if attempt == 0 else f"_{attempt:02d}"
        target = reports_root / f"{base.stem}{suffix}{base.suffix}"
        try:
            descriptor = os.open(
                target,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0),
                0o600,
            )
        except FileExistsError:
            continue
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                output.write(markdown)
        except Exception:
            target.unlink(missing_ok=True)
            raise
        return target
    raise ValueError("report_filename_exhausted")


def assemble(evidence_id: str, batches: list[object]) -> ReportArtifact:
    """Validate all three batches, render, validate again, and persist the report."""
    bundle = _load_evidence(evidence_id)
    validated_batches = _validated_batches(bundle, batches)
    markdown = assemble_report(bundle, validated_batches)
    validation_errors = validate_final_report(markdown, bundle, validated_batches)
    if validation_errors:
        raise ValueError(f"final_report_validation_failed:{validation_errors[0]}")

    account = bundle.get("account", {})
    nickname = account.get("nickname") if isinstance(account, dict) else None
    filename = (
        f"{_safe_nickname(nickname)}_抖音账号分析报告_"
        f"{datetime.now().strftime('%Y%m%d_%H%M%S')}.md"
    )
    report_path = _write_report(filename, markdown)
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
