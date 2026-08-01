"""Durable local task and artifact records for competitor collection runs."""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import threading
from typing import Callable, cast
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
import zipfile


PROJECT_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_VERSION = 2
AGENT_ID = "competitor-insight"
STORE_COMPONENTS = (
    "outputs",
    "competitor-insight",
    ".workbench",
    "project-records.json",
)
ALLOWED_STATUSES = {"waiting", "running", "completed", "failed", "stopped"}
ALLOWED_ARTIFACT_KINDS = {
    "excel",
    "file",
    "image",
    "markdown",
    "json",
    "image-directory",
    "output-directory",
}
ALLOWED_TRANSITIONS = {
    "waiting": {"waiting", "running", "failed", "stopped"},
    "running": {"running", "completed", "failed", "stopped"},
    "completed": {"completed"},
    "failed": {"failed"},
    "stopped": {"stopped"},
}
MAX_RECORD_BYTES = 4 * 1024 * 1024
MAX_SOURCE_URL_CHARACTERS = 2_048
MAX_TEXT_CHARACTERS = 500
MAX_ARTIFACTS_PER_TASK = 1_000
MAX_BUNDLE_FILES = 500
MAX_BUNDLE_FILE_BYTES = 32 * 1024 * 1024
MAX_BUNDLE_BYTES = 100 * 1024 * 1024
_TASK_ID = re.compile(r"^competitor-[0-9A-Za-z-]{4,120}$")
_ARTIFACT_ID = re.compile(r"^artifact-[0-9a-f]{16}$")
_BUNDLE_ID = re.compile(r"^bundle-[0-9a-f]{16}$")
_SAFE_QUERY_KEYS = {"modal_id"}
_SENSITIVE_QUERY_PARTS = (
    "token",
    "sign",
    "signature",
    "verify",
    "trace",
    "source",
    "utm_",
)
_SENSITIVE_TEXT_PARAMETER = re.compile(
    r"(?i)(xsec_token|share_token|access_token|token|signature|sign)=([^&\s]+)"
)
_IMAGE_EXTENSIONS = {
    ".avif",
    ".gif",
    ".heic",
    ".jpeg",
    ".jpg",
    ".png",
    ".webp",
}
_INPUT_KINDS = {"unknown", "account", "content"}
_CATEGORIES = {
    "douyin-account",
    "douyin-content",
    "xhs-account",
    "xhs-note",
}
_SENSITIVE_PATH_PARTS = ("cookie", "state", "profile", "token", "credential")
_TASK_FIELDS = {
    "id", "agentId", "title", "platformId", "platformLabel", "skillId", "sourceUrl",
    "status", "progress", "currentStep", "model", "createdAt", "updatedAt",
    "completedAt", "stoppedAt", "errorSummary", "artifactIds", "inputKind", "category",
    "bundleId",
}
_V1_TASK_FIELDS = _TASK_FIELDS - {"inputKind", "category", "bundleId"}
_ARTIFACT_FIELDS = {
    "id", "agentId", "taskId", "kind", "name", "filename", "absolutePath", "sizeBytes",
    "contentSha256", "createdAt", "completedAt", "previewable", "exists", "isDirectory", "markdown",
}
_V1_ARTIFACT_FIELDS = _ARTIFACT_FIELDS - {"contentSha256"}
_BUNDLE_FIELDS = {
    "id", "agentId", "taskId", "platformId", "inputKind", "category", "subjectName",
    "itemCount", "status", "rootDirectory", "primaryReportPath", "manifestPath", "archivePath",
    "artifactIds", "manifestSha256", "archiveSha256", "memberIdentitySha256", "createdAt", "updatedAt",
}
_STORE_LOCK = threading.RLock()
_STORE_LOCK_STATE = threading.local()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _store_path() -> Path:
    return PROJECT_ROOT.resolve().joinpath(*STORE_COMPONENTS)


def _store_lock_path() -> Path:
    return _store_path().with_name(".project-records.lock")


def _open_store_lock() -> int:
    lock_path = _store_lock_path()
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    if lock_path.parent.is_symlink() or not getattr(os, "O_NOFOLLOW", 0):
        raise ValueError("record_lock_unavailable")
    try:
        descriptor = os.open(
            lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600,
        )
    except OSError:
        raise ValueError("record_lock_unavailable") from None
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError("record_lock_unavailable")
        os.fchmod(descriptor, 0o600)
        if (os.fstat(descriptor).st_mode & 0o777) != 0o600:
            raise ValueError("record_lock_unavailable")
        return descriptor
    except (OSError, ValueError):
        os.close(descriptor)
        raise ValueError("record_lock_unavailable") from None


@contextmanager
def _store_transaction() -> object:
    """Serialize one durable-store transaction in thread then process order."""
    with _STORE_LOCK:
        depth = getattr(_STORE_LOCK_STATE, "depth", 0)
        if depth:
            _STORE_LOCK_STATE.depth = depth + 1
            try:
                yield
            finally:
                _STORE_LOCK_STATE.depth -= 1
            return
        descriptor = _open_store_lock()
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            _STORE_LOCK_STATE.depth = 1
            _STORE_LOCK_STATE.descriptor = descriptor
            try:
                yield
            finally:
                del _STORE_LOCK_STATE.descriptor
                del _STORE_LOCK_STATE.depth
                fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)


def _allowed_roots() -> tuple[Path, ...]:
    base = PROJECT_ROOT.resolve() / "outputs" / "competitor-insight"
    return tuple((base / name).resolve() for name in ("douyin", "xiaohongshu", "reports"))


def _empty_store() -> dict[str, object]:
    return {"schemaVersion": SCHEMA_VERSION, "tasks": [], "artifacts": [], "bundles": []}


def _bundle_id(value: object) -> str:
    if not isinstance(value, str) or not _BUNDLE_ID.fullmatch(value):
        raise ValueError("invalid_bundle_id")
    return value


def _valid_category(platform_id: object, input_kind: object, category: object) -> bool:
    return (
        isinstance(platform_id, str)
        and isinstance(input_kind, str)
        and isinstance(category, str)
        and category in _CATEGORIES
        and ((platform_id == "douyin" and category == f"douyin-{'content' if input_kind == 'content' else 'account'}")
             or (platform_id == "xiaohongshu" and category == f"xhs-{'note' if input_kind == 'content' else 'account'}"))
    )


def _valid_timestamp(value: object) -> bool:
    if not isinstance(value, str) or len(value) > 40 or not value.endswith("Z"):
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def _stored_path(value: object, root: Path) -> bool:
    if not isinstance(value, str) or not value or "\0" in value or len(value) > 4096:
        return False
    candidate = Path(value)
    try:
        return candidate.is_absolute() and candidate.resolve(strict=False).is_relative_to(root)
    except (OSError, ValueError):
        return False


def _valid_task_record(task: object, fields: set[str]) -> bool:
    if not isinstance(task, dict) or set(task) != fields:
        return False
    required_text = ("title", "platformLabel", "skillId", "currentStep", "model", "createdAt", "updatedAt")
    return (
        bool(_TASK_ID.fullmatch(cast(str, task.get("id", ""))))
        and task.get("agentId") == AGENT_ID and task.get("platformId") in {"douyin", "xiaohongshu"}
        and task.get("status") in ALLOWED_STATUSES
        and all(isinstance(task.get(key), str) and 0 < len(cast(str, task[key])) <= MAX_TEXT_CHARACTERS for key in required_text)
        and isinstance(task.get("sourceUrl"), str) and 0 < len(cast(str, task["sourceUrl"])) <= MAX_SOURCE_URL_CHARACTERS
        and _valid_timestamp(task.get("createdAt")) and _valid_timestamp(task.get("updatedAt"))
        and (task.get("completedAt") is None or _valid_timestamp(task.get("completedAt")))
        and (task.get("stoppedAt") is None or _valid_timestamp(task.get("stoppedAt")))
        and (task.get("errorSummary") is None or isinstance(task.get("errorSummary"), str))
        and isinstance(task.get("progress"), int) and not isinstance(task.get("progress"), bool) and 0 <= cast(int, task["progress"]) <= 100
        and isinstance(task.get("artifactIds"), list) and all(isinstance(item, str) and _ARTIFACT_ID.fullmatch(item) for item in cast(list[object], task["artifactIds"]))
        and len(set(cast(list[str], task["artifactIds"]))) == len(cast(list[object], task["artifactIds"]))
        and (task.get("status") != "completed" or (task.get("completedAt") is not None and task.get("progress") == 100))
        and (task.get("status") != "stopped" or task.get("stoppedAt") is not None)
    )


def _valid_sha256(value: object, *, nullable: bool = False) -> bool:
    return (nullable and value is None) or (
        isinstance(value, str) and bool(re.fullmatch(r"[0-9a-f]{64}", value))
    )


def _valid_artifact_record(artifact: object, fields: set[str] = _ARTIFACT_FIELDS) -> bool:
    root = PROJECT_ROOT.resolve() / "outputs" / "competitor-insight"
    return isinstance(artifact, dict) and set(artifact) == fields and (
        bool(_ARTIFACT_ID.fullmatch(cast(str, artifact.get("id", ""))))
        and artifact.get("agentId") == AGENT_ID and bool(_TASK_ID.fullmatch(cast(str, artifact.get("taskId", ""))))
        and artifact.get("kind") in ALLOWED_ARTIFACT_KINDS
        and all(isinstance(artifact.get(key), str) and 0 < len(cast(str, artifact[key])) <= 4096 for key in ("name", "filename"))
        and _stored_path(artifact.get("absolutePath"), root)
        and isinstance(artifact.get("sizeBytes"), int) and not isinstance(artifact.get("sizeBytes"), bool) and 0 <= cast(int, artifact["sizeBytes"]) <= MAX_BUNDLE_FILE_BYTES
        and _valid_timestamp(artifact.get("createdAt")) and _valid_timestamp(artifact.get("completedAt"))
        and isinstance(artifact.get("previewable"), bool) and isinstance(artifact.get("exists"), bool) and isinstance(artifact.get("isDirectory"), bool)
        and artifact.get("markdown") is None
        and ("contentSha256" not in fields or _valid_sha256(artifact.get("contentSha256"), nullable=True))
        and (not artifact.get("isDirectory") or artifact.get("contentSha256") is None)
        and (artifact.get("kind") in {"image-directory", "output-directory"}) == artifact.get("isDirectory")
    )


def _validate_v1_store(loaded: object) -> dict[str, object]:
    if not isinstance(loaded, dict) or set(loaded) != {"schemaVersion", "tasks", "artifacts"}:
        raise ValueError("record_store_damaged")
    if loaded.get("schemaVersion") != 1 or not isinstance(loaded.get("tasks"), list) or not isinstance(loaded.get("artifacts"), list):
        raise ValueError("record_store_damaged")
    tasks = cast(list[dict[str, object]], loaded["tasks"]); artifacts = cast(list[dict[str, object]], loaded["artifacts"])
    if any(not _valid_task_record(task, _V1_TASK_FIELDS) for task in tasks) or any(not _valid_artifact_record(item, _V1_ARTIFACT_FIELDS) for item in artifacts):
        raise ValueError("record_store_damaged")
    task_ids = [cast(str, item["id"]) for item in tasks]; artifact_ids = [cast(str, item["id"]) for item in artifacts]
    if len(task_ids) != len(set(task_ids)) or len(artifact_ids) != len(set(artifact_ids)):
        raise ValueError("record_store_damaged")
    by_task = {task_id: [] for task_id in task_ids}
    for artifact in artifacts:
        if artifact["taskId"] not in by_task:
            raise ValueError("record_store_damaged")
        by_task[cast(str, artifact["taskId"])].append(cast(str, artifact["id"]))
    if any(set(cast(list[str], task["artifactIds"])) != set(by_task[cast(str, task["id"])]) for task in tasks):
        raise ValueError("record_store_damaged")
    return cast(dict[str, object], loaded)


def _legacy_bundle_id(task_id: str) -> str:
    return "bundle-" + hashlib.sha256(("legacy\\0" + task_id).encode("utf-8")).hexdigest()[:16]


def _safe_legacy_root(paths: list[Path]) -> Path:
    if not paths:
        return (PROJECT_ROOT.resolve() / "outputs" / "competitor-insight").resolve()
    try:
        return Path(os.path.commonpath([str(path.parent) for path in paths])).resolve()
    except ValueError:
        return (PROJECT_ROOT.resolve() / "outputs" / "competitor-insight").resolve()


def _append_legacy_bundle(store: dict[str, object], task: dict[str, object]) -> None:
    if task.get("status") != "completed":
        return
    task_id = _task_id(task.get("id"))
    artifacts = [
        item for item in _artifacts(store)
        if item.get("taskId") == task_id and isinstance(item.get("absolutePath"), str)
    ]
    root = PROJECT_ROOT.resolve() / "outputs" / "competitor-insight" / cast(str, task["platformId"]) / task_id
    paths = [Path(cast(str, item["absolutePath"])).resolve(strict=False) for item in artifacts]
    all_owned = bool(paths) and all(path.is_relative_to(root) for path in paths)
    markdown = next((path for path in paths if path.suffix.casefold() == ".md" and path.is_relative_to(root)), None)
    bundle_id = _legacy_bundle_id(task_id)
    now = _now()
    status = "legacy" if all_owned and markdown is not None and markdown.is_file() and not _has_symlink_ancestor(markdown) else "missing"
    _bundles(store).append({
        "id": bundle_id,
        "agentId": AGENT_ID,
        "taskId": task_id,
        "platformId": task["platformId"],
        "inputKind": "unknown",
        "category": None,
        "subjectName": task["title"],
        "itemCount": 0,
        "status": status,
        "rootDirectory": str(root),
        "primaryReportPath": str(markdown) if status == "legacy" and markdown is not None else None,
        "manifestPath": str(root / f"{bundle_id}.manifest.json"),
        "archivePath": str(root / f"{bundle_id}.zip"),
        "artifactIds": [item["id"] for item in artifacts],
        "manifestSha256": None,
        "archiveSha256": None,
        "memberIdentitySha256": None,
        "createdAt": task["completedAt"] or now,
        "updatedAt": now,
    })
    task["inputKind"] = "unknown"
    task["category"] = None
    task["bundleId"] = bundle_id


def _migrate_v1(store: dict[str, object]) -> dict[str, object]:
    migrated: dict[str, object] = {
        "schemaVersion": SCHEMA_VERSION,
        "tasks": [dict(task) for task in _tasks(store)],
        "artifacts": [{**item, "contentSha256": None} for item in _artifacts(store)],
        "bundles": [],
    }
    for task in _tasks(migrated):
        _append_legacy_bundle(migrated, task)
    _validate_v2_store(migrated)
    return migrated


def _validate_v2_store(loaded: object) -> dict[str, object]:
    if not isinstance(loaded, dict) or set(loaded) != {"schemaVersion", "tasks", "artifacts", "bundles"}:
        raise ValueError("record_store_damaged")
    if loaded.get("schemaVersion") != SCHEMA_VERSION or not all(isinstance(loaded.get(key), list) for key in ("tasks", "artifacts", "bundles")):
        raise ValueError("record_store_damaged")
    for task in cast(list[object], loaded["tasks"]):
        if not _valid_task_record(task, _TASK_FIELDS) or not isinstance(task, dict) or task.get("inputKind") not in _INPUT_KINDS:
            raise ValueError("record_store_damaged")
        if (
            not _TASK_ID.fullmatch(cast(str, task.get("id", "")))
            or task.get("agentId") != AGENT_ID
            or task.get("platformId") not in {"douyin", "xiaohongshu"}
            or task.get("status") not in ALLOWED_STATUSES
            or isinstance(task.get("progress"), bool)
            or not isinstance(task.get("progress"), int)
            or not 0 <= cast(int, task["progress"]) <= 100
            or not isinstance(task.get("artifactIds"), list)
        ):
            raise ValueError("record_store_damaged")
        category = task.get("category")
        if category is not None and not _valid_category(task.get("platformId"), task.get("inputKind"), category):
            raise ValueError("record_store_damaged")
        if task.get("inputKind") == "unknown" and category is not None:
            raise ValueError("record_store_damaged")
    for artifact in cast(list[object], loaded["artifacts"]):
        if not _valid_artifact_record(artifact):
            raise ValueError("record_store_damaged")
    bundles_by_id: dict[str, dict[str, object]] = {}
    for bundle in cast(list[object], loaded["bundles"]):
        if not isinstance(bundle, dict) or set(bundle) != _BUNDLE_FIELDS:
            raise ValueError("record_store_damaged")
        if (
            not _BUNDLE_ID.fullmatch(cast(str, bundle.get("id", "")))
            or bundle.get("agentId") != AGENT_ID
            or bundle.get("status") not in {"legacy", "ready", "missing"}
            or bundle.get("platformId") not in {"douyin", "xiaohongshu"}
            or bundle.get("inputKind") not in _INPUT_KINDS
            or not isinstance(bundle.get("rootDirectory"), str)
            or not isinstance(bundle.get("manifestPath"), str)
            or not isinstance(bundle.get("archivePath"), str)
            or (bundle.get("primaryReportPath") is not None and not isinstance(bundle.get("primaryReportPath"), str))
            or isinstance(bundle.get("itemCount"), bool)
            or not isinstance(bundle.get("itemCount"), int)
            or not isinstance(bundle.get("artifactIds"), list)
        ):
            raise ValueError("record_store_damaged")
        task_id = bundle.get("taskId")
        root = PROJECT_ROOT.resolve() / "outputs" / "competitor-insight" / cast(str, bundle.get("platformId")) / cast(str, task_id)
        if (
            not _TASK_ID.fullmatch(cast(str, task_id))
            or not _stored_path(bundle.get("rootDirectory"), root.parent)
            or Path(cast(str, bundle["rootDirectory"])).resolve(strict=False) != root
            or not _stored_path(bundle.get("manifestPath"), root)
            or not _stored_path(bundle.get("archivePath"), root)
            or (bundle.get("primaryReportPath") is not None and not _stored_path(bundle.get("primaryReportPath"), root))
            or Path(cast(str, bundle["manifestPath"])).name != f"{bundle['id']}.manifest.json"
            or Path(cast(str, bundle["archivePath"])).name != f"{bundle['id']}.zip"
            or (bundle.get("primaryReportPath") is not None and Path(cast(str, bundle["primaryReportPath"])).suffix.casefold() != ".md")
            or not isinstance(bundle.get("subjectName"), str) or not 0 < len(cast(str, bundle["subjectName"])) <= MAX_TEXT_CHARACTERS
            or not 0 <= cast(int, bundle["itemCount"]) <= 100_000
            or len(cast(list[object], bundle["artifactIds"])) != len(set(cast(list[object], bundle["artifactIds"])))
            or any(not isinstance(item, str) or not _ARTIFACT_ID.fullmatch(item) for item in cast(list[object], bundle["artifactIds"]))
            or not all(_valid_sha256(bundle.get(field), nullable=True) for field in ("manifestSha256", "archiveSha256", "memberIdentitySha256"))
        ):
            raise ValueError("record_store_damaged")
        commitments = tuple(bundle.get(field) for field in ("manifestSha256", "archiveSha256", "memberIdentitySha256"))
        if bundle.get("status") == "ready" and not all(isinstance(value, str) for value in commitments):
            raise ValueError("record_store_damaged")
        if bundle.get("status") == "legacy" and any(value is not None for value in commitments) and not all(isinstance(value, str) for value in commitments):
            raise ValueError("record_store_damaged")
        if bundle.get("status") == "ready" and not _valid_category(
            bundle.get("platformId"), bundle.get("inputKind"), bundle.get("category")
        ):
            raise ValueError("record_store_damaged")
        bundles_by_id[cast(str, bundle["id"])] = cast(dict[str, object], bundle)
    tasks = _tasks(cast(dict[str, object], loaded)); artifacts = _artifacts(cast(dict[str, object], loaded))
    task_ids = [cast(str, task["id"]) for task in tasks]; artifact_ids = [cast(str, artifact["id"]) for artifact in artifacts]
    if len(task_ids) != len(set(task_ids)) or len(artifact_ids) != len(set(artifact_ids)) or len(bundles_by_id) != len(cast(list[object], loaded["bundles"])):
        raise ValueError("record_store_damaged")
    artifact_by_id = {cast(str, artifact["id"]): artifact for artifact in artifacts}
    for task in tasks:
        if any(artifact_id not in artifact_by_id or artifact_by_id[artifact_id].get("taskId") != task.get("id") for artifact_id in cast(list[str], task["artifactIds"])):
            raise ValueError("record_store_damaged")
        bundle_id = task.get("bundleId")
        if task.get("status") == "completed":
            if (
                not isinstance(bundle_id, str)
                or bundle_id not in bundles_by_id
                or bundles_by_id[bundle_id].get("taskId") != task.get("id")
            ):
                raise ValueError("record_store_damaged")
        elif bundle_id is not None:
            raise ValueError("record_store_damaged")
    for bundle in bundles_by_id.values():
        if any(artifact_id not in artifact_by_id or artifact_by_id[artifact_id].get("taskId") != bundle.get("taskId") for artifact_id in cast(list[str], bundle["artifactIds"])):
            raise ValueError("record_store_damaged")
        if bundle.get("status") == "ready" and any(
            artifact_by_id[artifact_id].get("isDirectory")
            or not _valid_sha256(artifact_by_id[artifact_id].get("contentSha256"))
            for artifact_id in cast(list[str], bundle["artifactIds"])
        ):
            raise ValueError("record_store_damaged")
        if bundle.get("status") == "ready" and not any(
            artifact_by_id[artifact_id].get("absolutePath") == bundle.get("primaryReportPath")
            for artifact_id in cast(list[str], bundle["artifactIds"])
        ):
            raise ValueError("record_store_damaged")
    return cast(dict[str, object], loaded)


def _load_store() -> dict[str, object]:
    target = _store_path()
    if not target.exists():
        return _empty_store()
    if target.is_symlink() or not target.is_file():
        raise ValueError("record_store_damaged")
    try:
        if target.stat().st_size > MAX_RECORD_BYTES:
            raise ValueError("record_store_damaged")
        loaded = json.loads(target.read_text("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise ValueError("record_store_damaged") from None
    if isinstance(loaded, dict) and loaded.get("schemaVersion") == 1:
        migrated = _migrate_v1(_validate_v1_store(loaded))
        _atomic_write(migrated)
        return migrated
    return _validate_v2_store(loaded)


def _atomic_write(store: dict[str, object]) -> None:
    target = _store_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.parent.is_symlink():
        raise ValueError("record_store_damaged")
    temporary = target.with_name(f".{target.name}.{secrets.token_hex(8)}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as handle:
            json.dump(store, handle, ensure_ascii=False, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def sanitize_source_url(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("invalid_source_url")
    candidate = value.strip()
    if not candidate or len(candidate) > MAX_SOURCE_URL_CHARACTERS:
        raise ValueError("invalid_source_url")
    try:
        parsed = urlsplit(candidate)
    except ValueError:
        raise ValueError("invalid_source_url") from None
    if (
        parsed.scheme.casefold() not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise ValueError("invalid_source_url")
    safe_query: list[tuple[str, str]] = []
    for key, item in parse_qsl(parsed.query, keep_blank_values=False):
        normalized = key.casefold()
        if normalized in _SAFE_QUERY_KEYS:
            safe_query.append((key, item))
            continue
        if any(part in normalized for part in _SENSITIVE_QUERY_PARTS):
            continue
    return urlunsplit(
        (
            parsed.scheme.casefold(),
            parsed.netloc.casefold(),
            parsed.path,
            urlencode(safe_query),
            "",
        )
    )


def _safe_text(value: object, field: str, maximum: int = MAX_TEXT_CHARACTERS) -> str:
    if not isinstance(value, str):
        raise ValueError(f"invalid_{field}")
    text = value.strip()
    if not text or len(text) > maximum or any(ord(character) < 32 for character in text):
        raise ValueError(f"invalid_{field}")
    return text


def _redact_sensitive_text(value: object) -> str:
    text = _safe_text(value, "error_summary")
    return _SENSITIVE_TEXT_PARAMETER.sub(r"\1=[redacted]", text)


def _task_id(value: object) -> str:
    if not isinstance(value, str) or not _TASK_ID.fullmatch(value):
        raise ValueError("invalid_task_id")
    return value


def _artifact_id(value: object) -> str:
    if not isinstance(value, str) or not _ARTIFACT_ID.fullmatch(value):
        raise ValueError("invalid_artifact_id")
    return value


def _tasks(store: dict[str, object]) -> list[dict[str, object]]:
    return cast(list[dict[str, object]], store["tasks"])


def _artifacts(store: dict[str, object]) -> list[dict[str, object]]:
    return cast(list[dict[str, object]], store["artifacts"])


def _bundles(store: dict[str, object]) -> list[dict[str, object]]:
    return cast(list[dict[str, object]], store["bundles"])


def _find_task(store: dict[str, object], task_id: str) -> dict[str, object]:
    task = next((item for item in _tasks(store) if item.get("id") == task_id), None)
    if task is None:
        raise ValueError("task_not_found")
    return task


def _find_bundle(store: dict[str, object], bundle_id: str) -> dict[str, object]:
    bundle = next((item for item in _bundles(store) if item.get("id") == bundle_id), None)
    if bundle is None:
        raise ValueError("bundle_not_found")
    return bundle


def create_task(payload: dict[str, object]) -> dict[str, object]:
    required = {
        "id",
        "agentId",
        "title",
        "platformId",
        "platformLabel",
        "skillId",
        "sourceUrl",
        "model",
    }
    allowed = required | {"inputKind"}
    if not isinstance(payload, dict) or not required.issubset(payload) or not set(payload).issubset(allowed):
        raise ValueError("invalid_request_fields")
    if payload["agentId"] != AGENT_ID:
        raise ValueError("invalid_agent_id")
    task_id = _task_id(payload["id"])
    platform_id = payload["platformId"]
    if not isinstance(platform_id, str) or platform_id not in {"douyin", "xiaohongshu"}:
        raise ValueError("invalid_platform_id")
    created_at = _now()
    task: dict[str, object] = {
        "id": task_id,
        "agentId": AGENT_ID,
        "title": _safe_text(payload["title"], "title"),
        "platformId": platform_id,
        "platformLabel": _safe_text(payload["platformLabel"], "platform_label", 64),
        "skillId": _safe_text(payload["skillId"], "skill_id", 128),
        "sourceUrl": sanitize_source_url(cast(str, payload["sourceUrl"])),
        "status": "waiting",
        "progress": 10,
        "currentStep": "平台已识别，等待连接",
        "model": _safe_text(payload["model"], "model", 128),
        "createdAt": created_at,
        "updatedAt": created_at,
        "completedAt": None,
        "stoppedAt": None,
        "errorSummary": None,
        "artifactIds": [],
        "inputKind": payload.get("inputKind", "unknown"),
        "category": None,
        "bundleId": None,
    }
    if task["inputKind"] not in _INPUT_KINDS:
        raise ValueError("invalid_task_classification")
    with _store_transaction():
        store = _load_store()
        if any(item.get("id") == task_id for item in _tasks(store)):
            raise ValueError("task_already_exists")
        _tasks(store).append(task)
        _atomic_write(store)
    return dict(task)


def update_task(task_id: str, patch: dict[str, object]) -> dict[str, object]:
    normalized_task_id = _task_id(task_id)
    allowed_fields = {"status", "progress", "currentStep", "errorSummary", "inputKind", "category"}
    if not isinstance(patch, dict) or not patch or not set(patch).issubset(allowed_fields):
        raise ValueError("invalid_request_fields")
    with _store_transaction():
        store = _load_store()
        task = _find_task(store, normalized_task_id)
        current_status = cast(str, task["status"])
        next_status = patch.get("status", current_status)
        if not isinstance(next_status, str) or next_status not in ALLOWED_STATUSES:
            raise ValueError("invalid_status")
        if next_status == "completed":
            raise ValueError("invalid_status_transition")
        if next_status not in ALLOWED_TRANSITIONS[current_status]:
            raise ValueError("invalid_status_transition")
        classification_fields = {"inputKind", "category"}
        present_classification = classification_fields & set(patch)
        if present_classification:
            if present_classification != classification_fields:
                raise ValueError("invalid_task_classification")
            input_kind = patch["inputKind"]
            category = patch["category"]
            if (
                input_kind not in {"account", "content"}
                or not _valid_category(task.get("platformId"), input_kind, category)
                or task.get("category") is not None
                or (task.get("inputKind") not in {"unknown", input_kind})
            ):
                raise ValueError("invalid_task_classification")
            task["inputKind"] = input_kind
            task["category"] = category
        if "progress" in patch:
            progress = patch["progress"]
            if isinstance(progress, bool) or not isinstance(progress, int):
                raise ValueError("invalid_progress")
            task["progress"] = min(100, max(0, progress))
        if "currentStep" in patch:
            task["currentStep"] = _safe_text(patch["currentStep"], "current_step")
        if "errorSummary" in patch:
            task["errorSummary"] = (
                None
                if patch["errorSummary"] is None
                else _redact_sensitive_text(patch["errorSummary"])
            )
        task["status"] = next_status
        timestamp = _now()
        task["updatedAt"] = timestamp
        if next_status == "completed":
            task["completedAt"] = timestamp
            task["progress"] = 100
            task["errorSummary"] = None
        elif next_status == "failed":
            task["completedAt"] = None
        elif next_status == "stopped":
            task["stoppedAt"] = timestamp
        _atomic_write(store)
        return dict(task)


def _within_allowed_root(path: Path) -> bool:
    return any(path == root or path.is_relative_to(root) for root in _allowed_roots())


def _has_symlink_ancestor(path: Path) -> bool:
    candidate = path.absolute()
    anchor = PROJECT_ROOT.absolute()
    try:
        parts = candidate.relative_to(anchor).parts
    except ValueError:
        parts = ()
    current = anchor
    for part in parts:
        current = current / part
        try:
            if current.is_symlink():
                return True
        except OSError:
            return True
    if parts:
        return False
    try:
        return candidate.is_symlink()
    except OSError:
        return True


def _validate_existing_path(value: object) -> Path:
    if not isinstance(value, str) or not value or "\0" in value or len(value) > 4_096:
        raise ValueError("invalid_path")
    candidate = Path(value)
    if not candidate.is_absolute():
        raise ValueError("invalid_path")
    if _has_symlink_ancestor(candidate):
        raise ValueError("symlink_not_allowed")
    try:
        resolved = candidate.resolve(strict=True)
    except OSError:
        raise ValueError("artifact_missing") from None
    if not _within_allowed_root(resolved):
        raise ValueError("path_not_allowed")
    return resolved


def _artifact_kind(path: Path, output_dir: Path) -> str | None:
    if path == output_dir:
        return "output-directory"
    if path.is_dir():
        try:
            has_images = any(
                item.is_file() and item.suffix.casefold() in _IMAGE_EXTENSIONS
                for item in path.iterdir()
            )
        except OSError:
            return None
        return "image-directory" if has_images else None
    return {
        ".xlsx": "excel",
        **{extension: "image" for extension in _IMAGE_EXTENSIONS},
        ".md": "markdown",
        ".json": "json",
    }.get(path.suffix.casefold())


def _file_snapshot(path: Path) -> tuple[bytes, os.stat_result]:
    directory_fd = _open_directory_fd(path.parent)
    try:
        return _read_member_snapshot(directory_fd, path.name, validate_archive_name=False)
    finally:
        os.close(directory_fd)


def _artifact_record(
    task_id: str,
    path: Path,
    kind: str,
    snapshot: tuple[bytes, os.stat_result] | None = None,
) -> dict[str, object]:
    digest = hashlib.sha256(f"{task_id}\0{path}".encode("utf-8")).hexdigest()[:16]
    is_directory = kind in {"image-directory", "output-directory"}
    if is_directory:
        stat_result = path.stat()
        content_sha256: str | None = None
        size_bytes = 0
    else:
        data, stat_result = snapshot or _file_snapshot(path)
        content_sha256 = hashlib.sha256(data).hexdigest()
        size_bytes = len(data)
    return {
        "id": f"artifact-{digest}",
        "agentId": AGENT_ID,
        "taskId": task_id,
        "kind": kind,
        "name": path.name,
        "filename": path.name,
        "absolutePath": str(path),
        "sizeBytes": size_bytes,
        "contentSha256": content_sha256,
        "createdAt": datetime.fromtimestamp(
            stat_result.st_mtime, timezone.utc
        ).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "completedAt": _now(),
        "previewable": kind == "markdown",
        "exists": True,
        "isDirectory": is_directory,
        "markdown": None,
    }


def _scan_paths(
    output_dir: Path,
    explicit_paths: list[object],
    modified_after: float,
) -> list[Path]:
    discovered: dict[str, Path] = {str(output_dir): output_dir}
    for raw in explicit_paths:
        path = _validate_existing_path(raw)
        if path.is_relative_to(output_dir) and _is_sensitive_relative(path.relative_to(output_dir)):
            continue
        discovered[str(path)] = path
    try:
        for root, directories, files in os.walk(output_dir, followlinks=False):
            current = Path(root)
            directories[:] = [
                name for name in directories
                if not (current / name).is_symlink()
                and not _is_sensitive_relative((current / name).relative_to(output_dir))
            ]
            if any(
                Path(name).suffix.casefold() in _IMAGE_EXTENSIONS
                and (current / name).stat().st_mtime >= modified_after
                for name in files
            ):
                discovered[str(current)] = current
            for filename in files:
                candidate = current / filename
                if candidate.is_symlink() or _is_sensitive_relative(candidate.relative_to(output_dir)):
                    continue
                if (
                    candidate.suffix.casefold() in {".xlsx", ".md", ".json"}
                    and candidate.stat().st_mtime >= modified_after
                ):
                    discovered[str(candidate.resolve(strict=True))] = candidate.resolve(strict=True)
    except OSError:
        raise ValueError("artifact_scan_failed") from None
    return list(discovered.values())


def _registered_directory_members(task_id: str, output_dir: Path, directory: Path) -> list[dict[str, object]]:
    root_fd = _open_directory_fd(output_dir)
    names: set[str] = set()

    def visit(name: str) -> None:
        parent_fd = os.dup(root_fd)
        directory_fd = -1
        try:
            for component in name.split("/"):
                next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
                os.close(parent_fd)
                parent_fd = next_fd
            directory_fd = parent_fd
            parent_fd = -1
            for child in os.listdir(directory_fd):
                child_name = f"{name}/{child}"
                relative = Path(child_name)
                _archive_name(relative)
                if _is_sensitive_relative(relative):
                    continue
                metadata = os.stat(child, dir_fd=directory_fd, follow_symlinks=False)
                if stat.S_ISDIR(metadata.st_mode):
                    visit(child_name)
                elif stat.S_ISREG(metadata.st_mode):
                    names.add(child_name)
        except OSError:
            raise ValueError("artifact_scan_failed") from None
        finally:
            if directory_fd >= 0:
                os.close(directory_fd)
            if parent_fd >= 0:
                os.close(parent_fd)

    try:
        root_name = _archive_name(directory.relative_to(output_dir))
        visit(root_name)
        records: list[dict[str, object]] = []
        for name in sorted(names):
            snapshot = _read_member_snapshot(root_fd, name)
            path = output_dir / name
            kind = "image" if path.suffix.casefold() in _IMAGE_EXTENSIONS else "file"
            records.append(_artifact_record(task_id, path, kind, snapshot))
        return records
    finally:
        os.close(root_fd)


def register_artifacts(task_id: str, payload: dict[str, object]) -> dict[str, object]:
    normalized_task_id = _task_id(task_id)
    if not isinstance(payload, dict) or set(payload) != {"outputDir", "explicitPaths"}:
        raise ValueError("invalid_request_fields")
    explicit_paths = payload["explicitPaths"]
    if not isinstance(explicit_paths, list) or len(explicit_paths) > MAX_ARTIFACTS_PER_TASK:
        raise ValueError("invalid_explicit_paths")
    output_dir = _validate_existing_path(payload["outputDir"])
    if not output_dir.is_dir():
        raise ValueError("invalid_output_directory")
    with _store_transaction():
        initial_store = _load_store()
        initial_task = _find_task(initial_store, normalized_task_id)
        created_at = cast(str, initial_task["createdAt"])
    modified_after = datetime.fromisoformat(
        created_at.replace("Z", "+00:00")
    ).timestamp() - 2
    scanned = _scan_paths(output_dir, explicit_paths, modified_after)
    generated: list[dict[str, object]] = []
    for path in scanned:
        kind = _artifact_kind(path, output_dir)
        if kind in ALLOWED_ARTIFACT_KINDS:
            generated.append(_artifact_record(normalized_task_id, path, cast(str, kind)))
            if kind == "image-directory":
                generated.extend(_registered_directory_members(normalized_task_id, output_dir, path))
    generated = list({cast(str, item["absolutePath"]): item for item in generated}.values())
    if len(generated) > MAX_ARTIFACTS_PER_TASK:
        raise ValueError("too_many_artifacts")
    with _store_transaction():
        store = _load_store()
        task = _find_task(store, normalized_task_id)
        existing = {
            cast(str, item["absolutePath"]): item
            for item in _artifacts(store)
            if item.get("taskId") == normalized_task_id
        }
        for item in generated:
            existing[cast(str, item["absolutePath"])] = item
        retained = [
            item
            for item in _artifacts(store)
            if item.get("taskId") != normalized_task_id
        ]
        merged = sorted(existing.values(), key=lambda item: cast(str, item["absolutePath"]))
        store["artifacts"] = retained + merged
        task["artifactIds"] = [item["id"] for item in merged]
        task["updatedAt"] = _now()
        _atomic_write(store)
        return _snapshot(store, AGENT_ID)


def _bundle_is_missing(store: dict[str, object], bundle: dict[str, object]) -> bool:
    root = bundle.get("rootDirectory")
    primary = bundle.get("primaryReportPath")
    if not isinstance(root, str) or not isinstance(primary, str):
        return True
    try:
        root_path = Path(root)
        primary_path = Path(primary)
        if not root_path.is_dir() or not primary_path.is_file() or _has_symlink_ancestor(primary_path):
            return True
        if bundle.get("status") == "legacy":
            task_id = bundle.get("taskId")
            legacy = [item for item in _artifacts(store) if item.get("taskId") == task_id]
            return any(
                not isinstance(item.get("absolutePath"), str)
                or not Path(cast(str, item["absolutePath"])).is_file()
                or _has_symlink_ancestor(Path(cast(str, item["absolutePath"])))
                for item in legacy
            )
        return not all(
            isinstance(bundle.get(field), str) and Path(cast(str, bundle[field])).is_file()
            for field in ("manifestPath", "archivePath")
        )
    except OSError:
        return True


def _refresh_bundle_statuses(store: dict[str, object]) -> bool:
    changed = False
    for bundle in _bundles(store):
        if bundle.get("status") in {"legacy", "ready"} and _bundle_is_missing(store, bundle):
            bundle["status"] = "missing"
            bundle["updatedAt"] = _now()
            changed = True
    return changed


def _snapshot(store: dict[str, object], agent_id: str) -> dict[str, object]:
    if agent_id != AGENT_ID:
        return {"tasks": [], "artifacts": [], "bundles": []}
    tasks = [dict(item) for item in _tasks(store) if item.get("agentId") == agent_id]
    artifacts: list[dict[str, object]] = []
    for item in _artifacts(store):
        if item.get("agentId") != agent_id:
            continue
        copy = dict(item)
        raw_path = copy.get("absolutePath")
        copy["exists"] = isinstance(raw_path, str) and Path(raw_path).exists()
        artifacts.append(copy)
    tasks.sort(key=lambda item: cast(str, item.get("updatedAt", "")), reverse=True)
    artifacts.sort(
        key=lambda item: cast(str, item.get("completedAt", item.get("createdAt", ""))),
        reverse=True,
    )
    bundles = [dict(item) for item in _bundles(store) if item.get("agentId") == agent_id]
    bundles.sort(key=lambda item: cast(str, item.get("updatedAt", "")), reverse=True)
    return {"tasks": tasks, "artifacts": artifacts, "bundles": bundles}


def read_records(agent_id: str) -> dict[str, object]:
    if not isinstance(agent_id, str) or len(agent_id) > 128:
        raise ValueError("invalid_agent_id")
    with _store_transaction():
        store = _load_store()
        if _refresh_bundle_statuses(store):
            _atomic_write(store)
        return _snapshot(store, agent_id)


Runner = Callable[..., object]


def reveal_artifact(
    artifact_id: str,
    *,
    runner: Runner = subprocess.run,
) -> dict[str, object]:
    normalized_artifact_id = _artifact_id(artifact_id)
    with _store_transaction():
        store = _load_store()
        artifact = next(
            (
                item
                for item in _artifacts(store)
                if item.get("id") == normalized_artifact_id
            ),
            None,
        )
    if artifact is None:
        raise ValueError("artifact_not_found")
    path = _validate_existing_path(artifact.get("absolutePath"))
    if path.is_dir():
        arguments = ["open", "--", str(path)]
    else:
        arguments = ["open", "-R", "--", str(path)]
    try:
        runner(arguments, check=True, shell=False)
    except (OSError, subprocess.SubprocessError):
        raise ValueError("reveal_failed") from None
    return {"ok": True, "artifactId": normalized_artifact_id}


def _is_sensitive_relative(relative: Path) -> bool:
    return any(
        part.casefold() == ".workbench"
        or any(marker in part.casefold() for marker in _SENSITIVE_PATH_PARTS)
        for part in relative.parts
    )


def _archive_name(relative: Path) -> str:
    value = relative.as_posix()
    parts = value.split("/")
    if (
        not value or "\0" in value or "\\" in value or value.startswith("/")
        or value.startswith("//") or re.match(r"^[A-Za-z]:", value)
        or any(part in {"", ".", ".."} for part in parts)
    ):
        raise ValueError("invalid_archive_member")
    return value


def _task_output_directory(task: dict[str, object], value: object) -> Path:
    output_dir = _validate_existing_path(value)
    platform = task.get("platformId")
    expected = PROJECT_ROOT.resolve() / "outputs" / "competitor-insight" / cast(str, platform) / _task_id(task["id"])
    if platform not in {"douyin", "xiaohongshu"} or not output_dir.is_dir() or output_dir != expected:
        raise ValueError("invalid_output_directory")
    return output_dir


def _strict_task_member(value: object, output_dir: Path) -> Path:
    path = _validate_existing_path(value)
    if path == output_dir or not path.is_relative_to(output_dir):
        raise ValueError("path_not_allowed")
    relative = path.relative_to(output_dir)
    _archive_name(relative)
    if _is_sensitive_relative(relative):
        raise ValueError("sensitive_path_not_allowed")
    return path


def _open_directory_fd(path: Path) -> int:
    if not getattr(os, "O_NOFOLLOW", 0) or not getattr(os, "O_DIRECTORY", 0):
        raise ValueError("bundle_path_unsafe")
    absolute = path.resolve()
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in absolute.parts[1:]:
            next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_fd
    except OSError:
        os.close(descriptor)
        raise ValueError("bundle_path_unsafe") from None
    return descriptor


def _read_member_snapshot(
    root_fd: int, name: str, *, validate_archive_name: bool = True,
) -> tuple[bytes, os.stat_result]:
    parts = name.split("/")
    if validate_archive_name:
        _archive_name(Path(name))
    elif not name or "\0" in name or "/" in name:
        raise ValueError("invalid_bundle_file")
    parent_fd = os.dup(root_fd)
    descriptor = -1
    try:
        for component in parts[:-1]:
            next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
            os.close(parent_fd)
            parent_fd = next_fd
        descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_BUNDLE_FILE_BYTES:
            raise ValueError("invalid_bundle_file")
        chunks: list[bytes] = []
        while True:
            chunk = os.read(descriptor, 64 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
            if sum(map(len, chunks)) > MAX_BUNDLE_FILE_BYTES:
                raise ValueError("bundle_file_too_large")
        data = b"".join(chunks)
        if len(data) != info.st_size:
            raise ValueError("bundle_file_changed")
        return data, info
    except OSError:
        raise ValueError("bundle_file_changed") from None
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        os.close(parent_fd)


def _authorized_paths(
    store: dict[str, object], task: dict[str, object], output_dir: Path,
) -> tuple[dict[str, dict[str, object]], set[str]]:
    artifact_ids = task.get("artifactIds")
    if not isinstance(artifact_ids, list):
        raise ValueError("record_store_damaged")
    by_id = {item.get("id"): item for item in _artifacts(store) if item.get("taskId") == task.get("id")}
    authorized: dict[str, dict[str, object]] = {}
    containers: set[str] = set()
    for artifact_id in artifact_ids:
        item = by_id.get(artifact_id)
        if not isinstance(item, dict):
            raise ValueError("record_store_damaged")
        if item.get("kind") == "output-directory":
            continue
        raw = item.get("absolutePath")
        if not isinstance(raw, str):
            raise ValueError("record_store_damaged")
        path = _strict_task_member(raw, output_dir)
        if item.get("isDirectory"):
            containers.add(str(path))
        elif _valid_sha256(item.get("contentSha256")):
            authorized[str(path)] = item
        else:
            raise ValueError("artifact_identity_missing")
    return authorized, containers


def _bundle_request(task_id: str, payload: dict[str, object], task: dict[str, object], store: dict[str, object]) -> dict[str, object]:
    fields = {"platformId", "inputKind", "category", "outputDir", "primaryReportPath", "explicitPaths", "subjectName", "itemCount"}
    if not isinstance(payload, dict) or set(payload) != fields:
        raise ValueError("invalid_request_fields")
    if (payload["platformId"], payload["inputKind"], payload["category"]) != (task.get("platformId"), task.get("inputKind"), task.get("category")) or not _valid_category(payload["platformId"], payload["inputKind"], payload["category"]):
        raise ValueError("invalid_task_classification")
    output_dir = _task_output_directory(task, payload["outputDir"])
    explicit = payload["explicitPaths"]
    if not isinstance(explicit, list) or not explicit or len(explicit) > MAX_BUNDLE_FILES:
        raise ValueError("invalid_explicit_paths")
    authorized, containers = _authorized_paths(store, task, output_dir)
    requested = [_strict_task_member(value, output_dir) for value in explicit]
    if len({str(path) for path in requested}) != len(requested):
        raise ValueError("artifact_not_authorized")
    selected: dict[str, dict[str, object]] = {}
    for path in requested:
        if str(path) in authorized:
            selected[str(path)] = authorized[str(path)]
        elif str(path) in containers:
            for raw, artifact in authorized.items():
                if Path(raw).is_relative_to(path):
                    selected[raw] = artifact
        else:
            raise ValueError("artifact_not_authorized")
    if not selected:
        raise ValueError("artifact_not_authorized")
    primary = _strict_task_member(payload["primaryReportPath"], output_dir)
    if str(primary) not in authorized or primary.suffix.casefold() != ".md":
        raise ValueError("primary_report_required")
    item_count = payload["itemCount"]
    if isinstance(item_count, bool) or not isinstance(item_count, int) or not 0 <= item_count <= 100_000:
        raise ValueError("invalid_item_count")
    return {"taskId": task_id, "outputDir": output_dir, "primary": primary, "selected": selected, "subjectName": _safe_text(payload["subjectName"], "subject_name"), "itemCount": item_count}


def _snapshots(
    root_fd: int, selected: dict[str, dict[str, object]], output_dir: Path,
) -> list[dict[str, object]]:
    if not selected or len(selected) > MAX_BUNDLE_FILES:
        raise ValueError("invalid_bundle_files")
    total = 0
    result: list[dict[str, object]] = []
    for raw, artifact in sorted(selected.items()):
        name = _archive_name(Path(raw).relative_to(output_dir))
        data, info = _read_member_snapshot(root_fd, name)
        total += len(data)
        digest = hashlib.sha256(data).hexdigest()
        if total > MAX_BUNDLE_BYTES:
            raise ValueError("bundle_too_large")
        if len(data) != artifact.get("sizeBytes") or digest != artifact.get("contentSha256"):
            raise ValueError("artifact_changed")
        result.append({"path": name, "sizeBytes": len(data), "sha256": digest, "kind": artifact["kind"], "data": data, "inode": info.st_ino, "artifactId": artifact["id"]})
    return result


def _write_all(descriptor: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        view = view[os.write(descriptor, view):]


def _write_archive_exclusive(directory_fd: int, temporary: str, data: bytes) -> None:
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=directory_fd)
    try:
        _write_all(descriptor, data); os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _member_identity_digest(primary_name: str, snapshots: list[dict[str, object]]) -> str:
    identity = {
        "primaryReport": primary_name,
        "files": [
            {key: item[key] for key in ("artifactId", "path", "sizeBytes", "sha256", "kind")}
            for item in snapshots
        ],
    }
    encoded = json.dumps(identity, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _rollback_published_files(directory_fd: int, published: dict[str, int]) -> None:
    removed = False
    for name, inode in published.items():
        try:
            info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            if stat.S_ISREG(info.st_mode) and info.st_ino == inode:
                os.unlink(name, dir_fd=directory_fd)
                removed = True
        except FileNotFoundError:
            continue
    if removed:
        os.fsync(directory_fd)


def _publish_bundle(
    output_dir: Path, bundle_id: str, primary: Path, snapshots: list[dict[str, object]],
) -> tuple[Path, Path, dict[str, str], int, dict[str, int]]:
    root_fd = _open_directory_fd(output_dir)
    manifest_name = f"{bundle_id}.manifest.json"; archive_name = f"{bundle_id}.zip"
    token = secrets.token_hex(16); manifest_temp = f".{bundle_id}.{token}.manifest.tmp"; archive_temp = f".{bundle_id}.{token}.archive.tmp"
    primary_name = _archive_name(primary.relative_to(output_dir))
    manifest = json.dumps({"schemaVersion": 1, "primaryReport": primary_name, "files": [{key: item[key] for key in ("path", "sizeBytes", "sha256", "kind")} for item in snapshots]}, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    stream = BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for item in snapshots: archive.writestr(cast(str, item["path"]), cast(bytes, item["data"]))
        archive.writestr("bundle-manifest.json", manifest)
    archive_bytes = stream.getvalue()
    commitments = {
        "manifestSha256": hashlib.sha256(manifest).hexdigest(),
        "archiveSha256": hashlib.sha256(archive_bytes).hexdigest(),
        "memberIdentitySha256": _member_identity_digest(primary_name, snapshots),
    }
    published: dict[str, int] = {}
    keep_fd = False
    try:
        _write_archive_exclusive(root_fd, manifest_temp, manifest)
        _write_archive_exclusive(root_fd, archive_temp, archive_bytes)
        os.link(manifest_temp, manifest_name, src_dir_fd=root_fd, dst_dir_fd=root_fd, follow_symlinks=False)
        published[manifest_name] = os.stat(manifest_name, dir_fd=root_fd, follow_symlinks=False).st_ino
        os.link(archive_temp, archive_name, src_dir_fd=root_fd, dst_dir_fd=root_fd, follow_symlinks=False)
        published[archive_name] = os.stat(archive_name, dir_fd=root_fd, follow_symlinks=False).st_ino
        os.fsync(root_fd)
        keep_fd = True
    except FileExistsError:
        _rollback_published_files(root_fd, published)
        raise ValueError("bundle_output_exists") from None
    except Exception:
        _rollback_published_files(root_fd, published)
        raise
    finally:
        for name in (manifest_temp, archive_temp):
            try: os.unlink(name, dir_fd=root_fd)
            except FileNotFoundError: pass
        if not keep_fd:
            os.close(root_fd)
    return output_dir / manifest_name, output_dir / archive_name, commitments, root_fd, published


def _new_bundle_id(store: dict[str, object]) -> str:
    existing = {cast(str, item["id"]) for item in _bundles(store)}
    while True:
        candidate = "bundle-" + secrets.token_hex(8)
        if candidate not in existing:
            return candidate


def _commit_ready_bundle(
    store: dict[str, object], task: dict[str, object], request: dict[str, object],
    primary: Path, manifest_path: Path, archive_path: Path, bundle_id: str,
    commitments: dict[str, str],
) -> None:
    now = _now()
    bundle = {
        "id": bundle_id, "agentId": AGENT_ID, "taskId": task["id"],
        "platformId": task["platformId"], "inputKind": task["inputKind"],
        "category": task["category"], "subjectName": request["subjectName"],
        "itemCount": request["itemCount"], "status": "ready", "rootDirectory": str(request["outputDir"]),
        "primaryReportPath": str(primary), "manifestPath": str(manifest_path),
        "archivePath": str(archive_path),
        "artifactIds": [item["id"] for item in cast(dict[str, dict[str, object]], request["selected"]).values()],
        **commitments,
        "createdAt": now, "updatedAt": now,
    }
    _bundles(store).append(bundle)
    task["bundleId"] = bundle_id
    task["status"] = "completed"
    task["progress"] = 100
    task["completedAt"] = now
    task["updatedAt"] = now
    task["errorSummary"] = None


def finalize_bundle(task_id: str, payload: dict[str, object]) -> dict[str, object]:
    normalized_task_id = _task_id(task_id)
    with _store_transaction():
        store = _load_store()
        task = _find_task(store, normalized_task_id)
        existing_id = task.get("bundleId")
        if isinstance(existing_id, str):
            _find_bundle(store, _bundle_id(existing_id))
            return _snapshot(store, AGENT_ID)
        if task.get("status") not in {"waiting", "running"}:
            raise ValueError("invalid_status_transition")
        request = _bundle_request(normalized_task_id, payload, task, store)
        primary = cast(Path, request["primary"])
        bundle_id = _new_bundle_id(store)
        output_dir = cast(Path, request["outputDir"])
        root_fd = _open_directory_fd(output_dir)
        try:
            snapshots = _snapshots(root_fd, cast(dict[str, dict[str, object]], request["selected"]), output_dir)
        finally:
            os.close(root_fd)
        manifest_path, archive_path, commitments, publish_fd, published = _publish_bundle(output_dir, bundle_id, primary, snapshots)
        try:
            _commit_ready_bundle(store, task, request, primary, manifest_path, archive_path, bundle_id, commitments)
            _atomic_write(store)
        except Exception:
            _rollback_published_files(publish_fd, published)
            raise
        finally:
            os.close(publish_fd)
        return _snapshot(store, AGENT_ID)


def read_bundle(bundle_id: str) -> dict[str, object]:
    normalized_bundle_id = _bundle_id(bundle_id)
    with _store_transaction():
        store = _load_store()
        if _refresh_bundle_statuses(store):
            _atomic_write(store)
        return dict(_find_bundle(store, normalized_bundle_id))


def _legacy_bundle_files(store: dict[str, object], bundle: dict[str, object]) -> list[Path]:
    root = Path(cast(str, bundle["rootDirectory"]))
    task_id = bundle["taskId"]
    files: list[Path] = []
    for artifact in _artifacts(store):
        if artifact.get("taskId") != task_id:
            continue
        raw = artifact.get("absolutePath")
        if not isinstance(raw, str):
            continue
        path = Path(raw)
        try:
            path = path.resolve(strict=True)
            if (
                path.is_file()
                and path.is_relative_to(root)
                and not _has_symlink_ancestor(path)
                and not _is_sensitive_relative(path.relative_to(root))
            ):
                _archive_name(path.relative_to(root))
                files.append(path)
        except OSError:
            continue
    return sorted(set(files), key=lambda item: item.relative_to(root).as_posix())


def _materialize_legacy_archive(store: dict[str, object], bundle: dict[str, object]) -> Path:
    if bundle.get("status") != "legacy":
        raise ValueError("bundle_missing")
    root = Path(cast(str, bundle["rootDirectory"]))
    primary_raw = bundle.get("primaryReportPath")
    if not isinstance(primary_raw, str):
        raise ValueError("bundle_missing")
    primary = Path(primary_raw).resolve(strict=True)
    files = _legacy_bundle_files(store, bundle)
    if primary not in files:
        bundle["status"] = "missing"
        bundle["updatedAt"] = _now()
        _atomic_write(store)
        raise ValueError("bundle_missing")
    root_fd = _open_directory_fd(root)
    try:
        artifacts_by_path = {
            str(Path(cast(str, item["absolutePath"])).resolve(strict=False)): item
            for item in _artifacts(store)
            if item.get("taskId") == bundle.get("taskId") and isinstance(item.get("absolutePath"), str)
        }
        snapshots: list[dict[str, object]] = []
        for path in files:
            name = _archive_name(path.relative_to(root))
            data, info = _read_member_snapshot(root_fd, name)
            artifact = artifacts_by_path.get(str(path))
            if not isinstance(artifact, dict):
                raise ValueError("bundle_missing")
            snapshots.append({
                "path": name,
                "sizeBytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
                "kind": artifact["kind"],
                "data": data,
                "inode": info.st_ino,
                "artifactId": artifact["id"],
            })
    finally:
        os.close(root_fd)
    manifest_path, archive_path, commitments, publish_fd, published = _publish_bundle(root, cast(str, bundle["id"]), primary, snapshots)
    try:
        bundle["manifestPath"] = str(manifest_path)
        bundle["archivePath"] = str(archive_path)
        bundle.update(commitments)
        bundle["updatedAt"] = _now()
        _atomic_write(store)
    except Exception:
        _rollback_published_files(publish_fd, published)
        raise
    finally:
        os.close(publish_fd)
    return archive_path


def _ready_archive_is_valid(store: dict[str, object], bundle: dict[str, object]) -> bool:
    try:
        commitments = tuple(bundle.get(field) for field in ("manifestSha256", "archiveSha256", "memberIdentitySha256"))
        if not all(_valid_sha256(value) for value in commitments):
            return False
        root = Path(cast(str, bundle["rootDirectory"])).resolve(strict=True)
        manifest_path = Path(cast(str, bundle["manifestPath"])).resolve(strict=True)
        archive_path = Path(cast(str, bundle["archivePath"])).resolve(strict=True)
        if manifest_path.parent != root or archive_path.parent != root:
            return False
        root_fd = _open_directory_fd(root)
        try:
            manifest_bytes, _ = _read_member_snapshot(root_fd, manifest_path.name)
            archive_bytes, _ = _read_member_snapshot(root_fd, archive_path.name)
        finally:
            os.close(root_fd)
        if hashlib.sha256(manifest_bytes).hexdigest() != bundle.get("manifestSha256"):
            return False
        if hashlib.sha256(archive_bytes).hexdigest() != bundle.get("archiveSha256"):
            return False
        manifest = json.loads(manifest_bytes.decode("utf-8"))
        if not isinstance(manifest, dict) or set(manifest) != {"schemaVersion", "primaryReport", "files"} or manifest.get("schemaVersion") != 1:
            return False
        files = manifest.get("files")
        if not isinstance(files, list) or not isinstance(manifest.get("primaryReport"), str):
            return False
        primary_name = _archive_name(Path(cast(str, manifest["primaryReport"])))
        primary_path = Path(cast(str, bundle["primaryReportPath"])).resolve(strict=False)
        if primary_path.parent != root or primary_name != _archive_name(primary_path.relative_to(root)):
            return False
        artifact_by_id = {cast(str, item["id"]): item for item in _artifacts(store)}
        allowed: dict[str, dict[str, object]] = {}
        for artifact_id in cast(list[object], bundle["artifactIds"]):
            artifact = artifact_by_id.get(cast(str, artifact_id))
            if not isinstance(artifact, dict) or artifact.get("taskId") != bundle.get("taskId") or artifact.get("isDirectory"):
                continue
            path = Path(cast(str, artifact.get("absolutePath"))).resolve(strict=False)
            if path.is_relative_to(root):
                allowed[_archive_name(path.relative_to(root))] = artifact
        if not allowed or primary_name not in allowed:
            return False
        member_names: set[str] = set()
        identity_members: list[dict[str, object]] = []
        with zipfile.ZipFile(BytesIO(archive_bytes)) as archive:
            names = archive.namelist()
            if len(names) != len(set(names)) or set(names) != {"bundle-manifest.json", *allowed}:
                return False
            if archive.read("bundle-manifest.json") != manifest_bytes:
                return False
            for item in files:
                if not isinstance(item, dict) or set(item) != {"path", "sizeBytes", "sha256", "kind"}:
                    return False
                name = _archive_name(Path(cast(str, item.get("path"))))
                artifact = allowed.get(name)
                if not isinstance(artifact, dict) or item.get("kind") != artifact.get("kind"):
                    return False
                if item.get("sizeBytes") != artifact.get("sizeBytes"):
                    return False
                if bundle.get("status") == "ready" and item.get("sha256") != artifact.get("contentSha256"):
                    return False
                member_names.add(name)
                data = archive.read(name)
                if len(data) != item.get("sizeBytes") or hashlib.sha256(data).hexdigest() != item.get("sha256"):
                    return False
                identity_members.append({
                    "artifactId": artifact["id"], "path": name,
                    "sizeBytes": item["sizeBytes"], "sha256": item["sha256"], "kind": item["kind"],
                })
        return (
            member_names == set(allowed)
            and _member_identity_digest(primary_name, identity_members) == bundle.get("memberIdentitySha256")
        )
    except (OSError, UnicodeError, json.JSONDecodeError, zipfile.BadZipFile, ValueError, TypeError):
        return False


def bundle_archive(bundle_id: str) -> Path:
    normalized_bundle_id = _bundle_id(bundle_id)
    with _store_transaction():
        store = _load_store()
        if _refresh_bundle_statuses(store):
            _atomic_write(store)
        bundle = _find_bundle(store, normalized_bundle_id)
        if bundle.get("status") == "missing":
            raise ValueError("bundle_missing")
        archive_raw = bundle.get("archivePath")
        if bundle.get("status") == "legacy" and (not isinstance(archive_raw, str) or not Path(archive_raw).is_file()):
            _materialize_legacy_archive(store, bundle)
            archive_raw = bundle.get("archivePath")
        if not isinstance(archive_raw, str):
            raise ValueError("bundle_missing")
        archive = Path(archive_raw)
        if _has_symlink_ancestor(archive) or not archive.is_file() or not _ready_archive_is_valid(store, bundle):
            bundle["status"] = "missing"
            bundle["updatedAt"] = _now()
            _atomic_write(store)
            raise ValueError("bundle_missing")
        return archive


def reveal_bundle(
    bundle_id: str,
    *,
    runner: Runner = subprocess.run,
) -> dict[str, object]:
    normalized_bundle_id = _bundle_id(bundle_id)
    with _store_transaction():
        store = _load_store()
        if _refresh_bundle_statuses(store):
            _atomic_write(store)
        bundle = _find_bundle(store, normalized_bundle_id)
        if bundle.get("status") == "missing":
            raise ValueError("bundle_missing")
        archive_raw = bundle.get("archivePath")
        if bundle.get("status") == "legacy" and (not isinstance(archive_raw, str) or not Path(archive_raw).is_file()):
            _materialize_legacy_archive(store, bundle)
        if not _ready_archive_is_valid(store, bundle):
            bundle["status"] = "missing"
            bundle["updatedAt"] = _now()
            _atomic_write(store)
            raise ValueError("bundle_missing")
        root = bundle.get("rootDirectory")
        if not isinstance(root, str):
            raise ValueError("bundle_missing")
        root_path = Path(root).resolve(strict=False)
        if _has_symlink_ancestor(root_path) or not _within_allowed_root(root_path):
            raise ValueError("bundle_missing")
        try:
            root_fd = _open_directory_fd(root_path)
        except ValueError:
            raise ValueError("bundle_missing") from None
        os.close(root_fd)
    try:
        runner(["open", "--", str(root_path)], check=True, shell=False)
    except (OSError, subprocess.SubprocessError):
        raise ValueError("reveal_failed") from None
    return {"ok": True, "bundleId": normalized_bundle_id}
