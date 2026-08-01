"""Durable local task and artifact records for competitor collection runs."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
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
    "createdAt", "completedAt", "previewable", "exists", "isDirectory", "markdown",
}
_BUNDLE_FIELDS = {
    "id", "agentId", "taskId", "platformId", "inputKind", "category", "subjectName",
    "itemCount", "status", "rootDirectory", "primaryReportPath", "manifestPath", "archivePath",
    "artifactIds", "createdAt", "updatedAt",
}
_STORE_LOCK = threading.RLock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _store_path() -> Path:
    return PROJECT_ROOT.resolve().joinpath(*STORE_COMPONENTS)


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


def _validate_v1_store(loaded: object) -> dict[str, object]:
    if not isinstance(loaded, dict) or set(loaded) != {"schemaVersion", "tasks", "artifacts"}:
        raise ValueError("record_store_damaged")
    if loaded.get("schemaVersion") != 1 or not isinstance(loaded.get("tasks"), list) or not isinstance(loaded.get("artifacts"), list):
        raise ValueError("record_store_damaged")
    for task in cast(list[object], loaded["tasks"]):
        if not isinstance(task, dict) or set(task) != _V1_TASK_FIELDS:
            raise ValueError("record_store_damaged")
    for artifact in cast(list[object], loaded["artifacts"]):
        if not isinstance(artifact, dict) or set(artifact) != _ARTIFACT_FIELDS:
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
    paths = [Path(cast(str, item["absolutePath"])) for item in artifacts]
    markdown = next((path for path in paths if path.suffix.casefold() == ".md"), None)
    root = _safe_legacy_root(paths)
    bundle_id = _legacy_bundle_id(task_id)
    now = _now()
    status = "legacy" if markdown is not None and markdown.is_file() else "missing"
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
        "primaryReportPath": str(markdown) if markdown is not None else None,
        "manifestPath": str(root / "bundle-manifest.json"),
        "archivePath": str(root / f"{bundle_id}.zip"),
        "artifactIds": [item["id"] for item in artifacts],
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
        "artifacts": [dict(item) for item in _artifacts(store)],
        "bundles": [],
    }
    for task in _tasks(migrated):
        _append_legacy_bundle(migrated, task)
    return migrated


def _validate_v2_store(loaded: object) -> dict[str, object]:
    if not isinstance(loaded, dict) or set(loaded) != {"schemaVersion", "tasks", "artifacts", "bundles"}:
        raise ValueError("record_store_damaged")
    if loaded.get("schemaVersion") != SCHEMA_VERSION or not all(isinstance(loaded.get(key), list) for key in ("tasks", "artifacts", "bundles")):
        raise ValueError("record_store_damaged")
    for task in cast(list[object], loaded["tasks"]):
        if not isinstance(task, dict) or set(task) != _TASK_FIELDS or task.get("inputKind") not in _INPUT_KINDS:
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
        if not isinstance(artifact, dict) or set(artifact) != _ARTIFACT_FIELDS:
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
        if bundle.get("status") == "ready" and not _valid_category(
            bundle.get("platformId"), bundle.get("inputKind"), bundle.get("category")
        ):
            raise ValueError("record_store_damaged")
        bundles_by_id[cast(str, bundle["id"])] = cast(dict[str, object], bundle)
    for task in _tasks(cast(dict[str, object], loaded)):
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
    created_at = _now()
    task: dict[str, object] = {
        "id": task_id,
        "agentId": AGENT_ID,
        "title": _safe_text(payload["title"], "title"),
        "platformId": _safe_text(payload["platformId"], "platform_id", 64),
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
    with _STORE_LOCK:
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
    with _STORE_LOCK:
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
        ".md": "markdown",
        ".json": "json",
    }.get(path.suffix.casefold())


def _artifact_record(task_id: str, path: Path, kind: str) -> dict[str, object]:
    digest = hashlib.sha256(f"{task_id}\0{path}".encode("utf-8")).hexdigest()[:16]
    stat_result = path.stat()
    return {
        "id": f"artifact-{digest}",
        "agentId": AGENT_ID,
        "taskId": task_id,
        "kind": kind,
        "name": path.name,
        "filename": path.name,
        "absolutePath": str(path),
        "sizeBytes": 0 if path.is_dir() else stat_result.st_size,
        "createdAt": datetime.fromtimestamp(
            stat_result.st_mtime, timezone.utc
        ).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "completedAt": _now(),
        "previewable": kind == "markdown",
        "exists": True,
        "isDirectory": path.is_dir(),
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
        discovered[str(path)] = path
    try:
        for root, directories, files in os.walk(output_dir, followlinks=False):
            current = Path(root)
            directories[:] = [
                name for name in directories if not (current / name).is_symlink()
            ]
            if any(
                Path(name).suffix.casefold() in _IMAGE_EXTENSIONS
                and (current / name).stat().st_mtime >= modified_after
                for name in files
            ):
                discovered[str(current)] = current
            for filename in files:
                candidate = current / filename
                if candidate.is_symlink():
                    continue
                if (
                    candidate.suffix.casefold() in {".xlsx", ".md", ".json"}
                    and candidate.stat().st_mtime >= modified_after
                ):
                    discovered[str(candidate.resolve(strict=True))] = candidate.resolve(strict=True)
    except OSError:
        raise ValueError("artifact_scan_failed") from None
    return list(discovered.values())


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
    with _STORE_LOCK:
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
    if len(generated) > MAX_ARTIFACTS_PER_TASK:
        raise ValueError("too_many_artifacts")
    with _STORE_LOCK:
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
    with _STORE_LOCK:
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
    with _STORE_LOCK:
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
        part == ".workbench" or any(marker in part.casefold() for marker in _SENSITIVE_PATH_PARTS)
        for part in relative.parts
    )


def _task_output_directory(task: dict[str, object], value: object) -> Path:
    output_dir = _validate_existing_path(value)
    platform = task.get("platformId")
    if platform not in {"douyin", "xiaohongshu"} or not output_dir.is_dir():
        raise ValueError("invalid_output_directory")
    expected = (
        PROJECT_ROOT.resolve() / "outputs" / "competitor-insight" / cast(str, platform) / _task_id(task["id"])
    )
    if output_dir != expected:
        raise ValueError("invalid_output_directory")
    return output_dir


def _strict_task_member(value: object, output_dir: Path) -> Path:
    path = _validate_existing_path(value)
    if path == output_dir or not path.is_relative_to(output_dir):
        raise ValueError("path_not_allowed")
    relative = path.relative_to(output_dir)
    if _is_sensitive_relative(relative):
        raise ValueError("sensitive_path_not_allowed")
    return path


def _regular_file(path: Path) -> os.stat_result:
    if _has_symlink_ancestor(path):
        raise ValueError("symlink_not_allowed")
    try:
        info = path.lstat()
    except OSError:
        raise ValueError("artifact_missing") from None
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("invalid_bundle_file")
    if info.st_size > MAX_BUNDLE_FILE_BYTES:
        raise ValueError("bundle_file_too_large")
    return info


def _read_regular_file(path: Path, expected_size: int | None = None, expected_digest: str | None = None) -> bytes:
    info = _regular_file(path)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError:
        raise ValueError("bundle_file_changed") from None
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or opened.st_size != info.st_size:
            raise ValueError("bundle_file_changed")
        chunks: list[bytes] = []
        remaining = MAX_BUNDLE_FILE_BYTES + 1
        while remaining:
            chunk = os.read(descriptor, min(64 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        content = b"".join(chunks)
    finally:
        os.close(descriptor)
    if len(content) != info.st_size or (expected_size is not None and len(content) != expected_size):
        raise ValueError("bundle_file_changed")
    digest = hashlib.sha256(content).hexdigest()
    if expected_digest is not None and digest != expected_digest:
        raise ValueError("bundle_file_changed")
    return content


def _discover_bundle_files(output_dir: Path, explicit_paths: list[object]) -> list[Path]:
    discovered: dict[str, Path] = {}
    for raw in explicit_paths:
        path = _strict_task_member(raw, output_dir)
        if path.is_dir():
            try:
                for root, directories, files in os.walk(path, followlinks=False):
                    current = Path(root)
                    directories[:] = [name for name in directories if not (current / name).is_symlink()]
                    for filename in files:
                        child = current / filename
                        if child.is_symlink():
                            continue
                        safe_child = _strict_task_member(str(child), output_dir)
                        _regular_file(safe_child)
                        discovered[str(safe_child)] = safe_child
            except OSError:
                raise ValueError("artifact_scan_failed") from None
        else:
            _regular_file(path)
            discovered[str(path)] = path
    files = sorted(discovered.values(), key=lambda item: item.relative_to(output_dir).as_posix())
    if not files or len(files) > MAX_BUNDLE_FILES:
        raise ValueError("invalid_bundle_files")
    total = sum(_regular_file(path).st_size for path in files)
    if total > MAX_BUNDLE_BYTES:
        raise ValueError("bundle_too_large")
    return files


def _bundle_request(task_id: str, payload: dict[str, object], task: dict[str, object]) -> dict[str, object]:
    fields = {
        "platformId", "inputKind", "category", "outputDir", "primaryReportPath",
        "explicitPaths", "subjectName", "itemCount",
    }
    if not isinstance(payload, dict) or set(payload) != fields:
        raise ValueError("invalid_request_fields")
    if (
        payload["platformId"] != task.get("platformId")
        or payload["inputKind"] != task.get("inputKind")
        or payload["category"] != task.get("category")
        or task.get("inputKind") not in {"account", "content"}
        or not _valid_category(payload["platformId"], payload["inputKind"], payload["category"])
    ):
        raise ValueError("invalid_task_classification")
    output_dir = _task_output_directory(task, payload["outputDir"])
    explicit_paths = payload["explicitPaths"]
    if not isinstance(explicit_paths, list) or not explicit_paths or len(explicit_paths) > MAX_BUNDLE_FILES:
        raise ValueError("invalid_explicit_paths")
    primary = _strict_task_member(payload["primaryReportPath"], output_dir)
    if primary.suffix.casefold() != ".md":
        raise ValueError("primary_report_required")
    subject_name = _safe_text(payload["subjectName"], "subject_name")
    item_count = payload["itemCount"]
    if isinstance(item_count, bool) or not isinstance(item_count, int) or not 0 <= item_count <= 100_000:
        raise ValueError("invalid_item_count")
    return {
        "taskId": task_id, "outputDir": output_dir, "primary": primary,
        "explicitPaths": explicit_paths, "subjectName": subject_name, "itemCount": item_count,
    }


def _fsync_directory(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)


def _publish_exclusive(temporary: Path, target: Path) -> None:
    try:
        os.link(temporary, target)
    except FileExistsError:
        raise ValueError("bundle_output_exists") from None
    except OSError:
        raise ValueError("bundle_publish_failed") from None
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
    _fsync_directory(target.parent)


def _manifest_members(output_dir: Path, files: list[Path]) -> list[dict[str, object]]:
    members: list[dict[str, object]] = []
    for path in files:
        relative = path.relative_to(output_dir)
        if relative.is_absolute() or ".." in relative.parts or _is_sensitive_relative(relative):
            raise ValueError("path_not_allowed")
        content = _read_regular_file(path)
        members.append({
            "path": relative.as_posix(), "sizeBytes": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
            "kind": _artifact_kind(path, output_dir) or "file",
        })
    return members


def _write_manifest_exclusive(output_dir: Path, files: list[Path], primary: Path) -> tuple[Path, list[dict[str, object]]]:
    if primary not in files:
        raise ValueError("primary_report_required")
    members = _manifest_members(output_dir, files)
    target = output_dir / "bundle-manifest.json"
    if target.exists():
        raise ValueError("bundle_output_exists")
    payload = {
        "schemaVersion": 1,
        "primaryReport": primary.relative_to(output_dir).as_posix(),
        "files": members,
    }
    temporary = output_dir / f".bundle-manifest.{secrets.token_hex(8)}.tmp"
    try:
        with temporary.open("x", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        _publish_exclusive(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    return target, members


def _write_archive_exclusive(
    output_dir: Path, bundle_id: str, manifest_path: Path, members: list[dict[str, object]]
) -> Path:
    target = output_dir / f"{bundle_id}.zip"
    if target.exists():
        raise ValueError("bundle_output_exists")
    temporary = output_dir / f".{bundle_id}.{secrets.token_hex(8)}.tmp"
    try:
        with zipfile.ZipFile(temporary, "x", compression=zipfile.ZIP_DEFLATED) as archive:
            for member in members:
                relative = Path(cast(str, member["path"]))
                if relative.is_absolute() or ".." in relative.parts:
                    raise ValueError("path_not_allowed")
                content = _read_regular_file(
                    output_dir / relative,
                    cast(int, member["sizeBytes"]), cast(str, member["sha256"]),
                )
                archive.writestr(relative.as_posix(), content)
            archive.writestr("bundle-manifest.json", _read_regular_file(manifest_path))
        with temporary.open("rb") as handle:
            os.fsync(handle.fileno())
        _publish_exclusive(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    return target


def _new_bundle_id(store: dict[str, object]) -> str:
    existing = {cast(str, item["id"]) for item in _bundles(store)}
    while True:
        candidate = "bundle-" + secrets.token_hex(8)
        if candidate not in existing:
            return candidate


def _commit_ready_bundle(
    store: dict[str, object], task: dict[str, object], request: dict[str, object],
    primary: Path, manifest_path: Path, archive_path: Path, bundle_id: str,
) -> None:
    now = _now()
    bundle = {
        "id": bundle_id, "agentId": AGENT_ID, "taskId": task["id"],
        "platformId": task["platformId"], "inputKind": task["inputKind"],
        "category": task["category"], "subjectName": request["subjectName"],
        "itemCount": request["itemCount"], "status": "ready", "rootDirectory": str(request["outputDir"]),
        "primaryReportPath": str(primary), "manifestPath": str(manifest_path),
        "archivePath": str(archive_path), "artifactIds": list(task["artifactIds"]),
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
    with _STORE_LOCK:
        store = _load_store()
        task = _find_task(store, normalized_task_id)
        existing_id = task.get("bundleId")
        if isinstance(existing_id, str):
            _find_bundle(store, _bundle_id(existing_id))
            return _snapshot(store, AGENT_ID)
        if task.get("status") not in {"waiting", "running"}:
            raise ValueError("invalid_status_transition")
        request = _bundle_request(normalized_task_id, payload, task)
        files = _discover_bundle_files(cast(Path, request["outputDir"]), cast(list[object], request["explicitPaths"]))
        primary = cast(Path, request["primary"])
        bundle_id = _new_bundle_id(store)
        manifest_path, members = _write_manifest_exclusive(cast(Path, request["outputDir"]), files, primary)
        archive_path = _write_archive_exclusive(cast(Path, request["outputDir"]), bundle_id, manifest_path, members)
        _commit_ready_bundle(store, task, request, primary, manifest_path, archive_path, bundle_id)
        _atomic_write(store)
        return _snapshot(store, AGENT_ID)


def read_bundle(bundle_id: str) -> dict[str, object]:
    normalized_bundle_id = _bundle_id(bundle_id)
    with _STORE_LOCK:
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
                _regular_file(path)
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
    manifest_path, members = _write_manifest_exclusive(root, files, primary)
    archive_path = _write_archive_exclusive(root, cast(str, bundle["id"]), manifest_path, members)
    bundle["manifestPath"] = str(manifest_path)
    bundle["archivePath"] = str(archive_path)
    bundle["updatedAt"] = _now()
    _atomic_write(store)
    return archive_path


def bundle_archive(bundle_id: str) -> Path:
    normalized_bundle_id = _bundle_id(bundle_id)
    with _STORE_LOCK:
        store = _load_store()
        if _refresh_bundle_statuses(store):
            _atomic_write(store)
        bundle = _find_bundle(store, normalized_bundle_id)
        if bundle.get("status") == "missing":
            raise ValueError("bundle_missing")
        archive_raw = bundle.get("archivePath")
        if bundle.get("status") == "legacy" and (not isinstance(archive_raw, str) or not Path(archive_raw).is_file()):
            return _materialize_legacy_archive(store, bundle)
        if not isinstance(archive_raw, str):
            raise ValueError("bundle_missing")
        archive = Path(archive_raw)
        if _has_symlink_ancestor(archive) or not archive.is_file():
            raise ValueError("bundle_missing")
        return archive


def reveal_bundle(
    bundle_id: str,
    *,
    runner: Runner = subprocess.run,
) -> dict[str, object]:
    normalized_bundle_id = _bundle_id(bundle_id)
    with _STORE_LOCK:
        store = _load_store()
        if _refresh_bundle_statuses(store):
            _atomic_write(store)
        bundle = _find_bundle(store, normalized_bundle_id)
        if bundle.get("status") == "missing":
            raise ValueError("bundle_missing")
        root = bundle.get("rootDirectory")
        if not isinstance(root, str):
            raise ValueError("bundle_missing")
        root_path = Path(root)
        if _has_symlink_ancestor(root_path) or not root_path.is_dir() or not _within_allowed_root(root_path.resolve()):
            raise ValueError("bundle_missing")
    try:
        runner(["open", "--", str(root_path)], check=True, shell=False)
    except (OSError, subprocess.SubprocessError):
        raise ValueError("reveal_failed") from None
    return {"ok": True, "bundleId": normalized_bundle_id}
