"""Controlled local file service for evidence-backed competitor reports."""

from __future__ import annotations

from datetime import datetime
import io
import json
import os
from pathlib import Path
import re
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

_EVIDENCE_ID = re.compile(r"^[0-9a-f]{16}$")
_REQUIRED_XLSX_MEMBERS = {
    "[Content_Types].xml",
    "_rels/.rels",
    "xl/workbook.xml",
}
_EXPECTED_BATCH_IDS = ("strategy", "performance", "execution")


def _douyin_root() -> Path:
    return PROJECT_ROOT / "outputs" / "competitor-insight" / "douyin"


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


def _validate_xlsx_archive(source: Path | io.BytesIO) -> None:
    try:
        with zipfile.ZipFile(source) as archive:
            members = set(archive.namelist())
            if not _REQUIRED_XLSX_MEMBERS.issubset(members):
                raise ValueError("invalid_xlsx_signature")
            if archive.testzip() is not None:
                raise ValueError("invalid_xlsx_signature")
    except (OSError, zipfile.BadZipFile, zipfile.LargeZipFile):
        raise ValueError("invalid_xlsx_signature") from None


def _controlled_workbook(path_text: str) -> Path:
    candidate = Path(path_text)
    if not candidate.is_absolute():
        candidate = PROJECT_ROOT / candidate
    lexical_candidate = Path(os.path.abspath(candidate))
    lexical_root = Path(os.path.abspath(_douyin_root()))
    try:
        relative = lexical_candidate.relative_to(lexical_root)
    except ValueError:
        raise ValueError("path_outside_douyin_output") from None

    current = lexical_root
    for component in relative.parts:
        current = current / component
        if current.is_symlink():
            raise ValueError("symlink_not_allowed")

    resolved_root = lexical_root.resolve()
    resolved_candidate = lexical_candidate.resolve()
    try:
        resolved_candidate.relative_to(resolved_root)
    except ValueError:
        raise ValueError("path_outside_douyin_output") from None
    _validate_extension(resolved_candidate.name)
    if not resolved_candidate.is_file():
        raise ValueError("invalid_xlsx_path")
    _validate_size(resolved_candidate.stat().st_size)
    _validate_xlsx_archive(resolved_candidate)
    return resolved_candidate


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
    except ValueError:
        raise
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


def _evidence_ready(bundle: EvidenceBundle) -> dict[str, object]:
    return {
        "ok": True,
        "stage": "evidence_ready",
        "evidenceId": bundle["evidenceId"],
        "account": bundle.get("account", {}),
        "completeness": bundle.get("completeness", {}),
        "batchInputs": {},
    }


def analyze_path(path_text: str) -> dict[str, object]:
    """Analyze one ordinary XLSX located under the controlled Douyin output."""
    if not isinstance(path_text, str) or not path_text.strip():
        raise ValueError("invalid_path")
    workbook_path = _controlled_workbook(path_text)
    bundle = _persist_bundle(
        workbook_path,
        {"kind": "path", "name": workbook_path.name},
    )
    return _evidence_ready(bundle)


def analyze_upload(filename: str, content: bytes) -> dict[str, object]:
    """Analyze an uploaded XLSX from an automatically deleted temporary copy."""
    if not isinstance(filename, str) or not filename.strip():
        raise ValueError("invalid_filename")
    if not isinstance(content, bytes):
        raise ValueError("invalid_upload_content")
    _validate_extension(filename)
    _validate_size(len(content))
    _validate_xlsx_archive(io.BytesIO(content))

    with TemporaryDirectory(dir=_temporary_root()) as directory:
        staging_dir = Path(directory)
        workbook_path = staging_dir / "upload.xlsx"
        workbook_path.write_bytes(content)
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
    target = reports_root / filename
    with TemporaryDirectory(dir=_temporary_root()) as directory:
        staged = Path(directory) / "report.md"
        staged.write_text(markdown, encoding="utf-8")
        os.replace(staged, target)
    return target


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
            "filename": filename,
            "reportPath": str(report_path),
            "markdown": markdown,
            "validationErrors": [],
        },
    )
