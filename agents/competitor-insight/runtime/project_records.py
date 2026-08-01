"""Durable local task and artifact records for competitor collection runs."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import threading
from typing import Callable, cast
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


PROJECT_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_VERSION = 1
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
_TASK_ID = re.compile(r"^competitor-[0-9A-Za-z-]{4,120}$")
_ARTIFACT_ID = re.compile(r"^artifact-[0-9a-f]{16}$")
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
    return {"schemaVersion": SCHEMA_VERSION, "tasks": [], "artifacts": []}


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
    if (
        not isinstance(loaded, dict)
        or loaded.get("schemaVersion") != SCHEMA_VERSION
        or not isinstance(loaded.get("tasks"), list)
        or not isinstance(loaded.get("artifacts"), list)
    ):
        raise ValueError("record_store_damaged")
    return cast(dict[str, object], loaded)


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


def _find_task(store: dict[str, object], task_id: str) -> dict[str, object]:
    task = next((item for item in _tasks(store) if item.get("id") == task_id), None)
    if task is None:
        raise ValueError("task_not_found")
    return task


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
    if not isinstance(payload, dict) or set(payload) != required:
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
    }
    with _STORE_LOCK:
        store = _load_store()
        if any(item.get("id") == task_id for item in _tasks(store)):
            raise ValueError("task_already_exists")
        _tasks(store).append(task)
        _atomic_write(store)
    return dict(task)


def update_task(task_id: str, patch: dict[str, object]) -> dict[str, object]:
    normalized_task_id = _task_id(task_id)
    allowed_fields = {"status", "progress", "currentStep", "errorSummary"}
    if not isinstance(patch, dict) or not patch or not set(patch).issubset(allowed_fields):
        raise ValueError("invalid_request_fields")
    with _STORE_LOCK:
        store = _load_store()
        task = _find_task(store, normalized_task_id)
        current_status = cast(str, task["status"])
        next_status = patch.get("status", current_status)
        if not isinstance(next_status, str) or next_status not in ALLOWED_STATUSES:
            raise ValueError("invalid_status")
        if next_status not in ALLOWED_TRANSITIONS[current_status]:
            raise ValueError("invalid_status_transition")
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


def _validate_existing_path(value: object) -> Path:
    if not isinstance(value, str) or not value or len(value) > 4_096:
        raise ValueError("invalid_path")
    candidate = Path(value).expanduser()
    if candidate.is_symlink():
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


def _snapshot(store: dict[str, object], agent_id: str) -> dict[str, object]:
    if agent_id != AGENT_ID:
        return {"tasks": [], "artifacts": []}
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
    return {"tasks": tasks, "artifacts": artifacts}


def read_records(agent_id: str) -> dict[str, object]:
    if not isinstance(agent_id, str) or len(agent_id) > 128:
        raise ValueError("invalid_agent_id")
    with _STORE_LOCK:
        return _snapshot(_load_store(), agent_id)


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
