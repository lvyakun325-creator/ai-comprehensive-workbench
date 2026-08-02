"""Normalize task-scoped scraper JSON into deterministic evidence input."""

from __future__ import annotations

import json
import os
from io import BytesIO
from pathlib import Path
import stat
from typing import BinaryIO, Callable
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from metrics import parse_metric, parse_publish_time
from workbook_reader import validate_workbook_source


MAX_JSON_BYTES = 8 * 1024 * 1024
MAX_XLSX_BYTES = 50 * 1024 * 1024
_METRICS = ("likes", "comments", "collects", "shares")
_SENSITIVE_URL_QUERY_PARTS = (
    "token",
    "sign",
    "signature",
    "verify",
    "trace",
    "source",
    "utm_",
)


def _open_source(path: Path, suffix: str, maximum: int) -> BinaryIO:
    absolute = path.absolute()
    parts = absolute.parts
    if parts[:2] == ("/", "var"):
        parts = ("/", "private", "var", *parts[2:])
    if (
        len(parts) < 2
        or any(part in {"", ".", ".."} for part in parts[1:])
        or os.open not in os.supports_dir_fd
    ):
        raise ValueError("invalid_source_path")
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    directory = getattr(os, "O_DIRECTORY", 0)
    if nofollow == 0 or directory == 0:
        raise ValueError("invalid_source_path")
    directory_fd: int | None = None
    descriptor: int | None = None
    try:
        directory_fd = os.open("/", os.O_RDONLY | directory | nofollow)
        for component in parts[1:-1]:
            next_fd = os.open(component, os.O_RDONLY | directory | nofollow, dir_fd=directory_fd)
            os.close(directory_fd)
            directory_fd = next_fd
        descriptor = os.open(parts[-1], os.O_RDONLY | nofollow, dir_fd=directory_fd)
        metadata = os.fstat(descriptor)
    except OSError as error:
        if descriptor is not None:
            os.close(descriptor)
        raise ValueError("invalid_source_path") from error
    finally:
        if directory_fd is not None:
            os.close(directory_fd)
    if not stat.S_ISREG(metadata.st_mode) or absolute.suffix.casefold() != suffix or metadata.st_size > maximum:
        if descriptor is not None:
            os.close(descriptor)
        raise ValueError("invalid_source_path")
    return os.fdopen(descriptor, "rb")


def _load_json(path: Path) -> dict[str, object]:
    try:
        with _open_source(path, ".json", MAX_JSON_BYTES) as source:
            payload = source.read(MAX_JSON_BYTES + 1)
            if len(payload) > MAX_JSON_BYTES:
                raise ValueError("invalid_source_path")
            value = json.loads(payload.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("invalid_source_json") from error
    if not isinstance(value, dict):
        raise ValueError("invalid_source_json")
    return value


def _validate_excel(path: Path | None) -> None:
    if path is not None:
        with _open_source(path, ".xlsx", MAX_XLSX_BYTES) as source:
            payload = source.read(MAX_XLSX_BYTES + 1)
            if len(payload) > MAX_XLSX_BYTES:
                raise ValueError("invalid_source_path")
            validate_workbook_source(BytesIO(payload))


def _object(value: object) -> dict[str, object]:
    return value if isinstance(value, dict) else {}


def _first(value: dict[str, object], *keys: str) -> tuple[bool, object]:
    for key in keys:
        if key in value:
            return True, value[key]
    return False, None


def _text(value: object) -> str:
    return str(value).strip() if value is not None else ""


def sanitize_public_url(value: object) -> str:
    """Remove request-scoped credentials and tracking data before persistence."""
    candidate = _text(value)
    if not candidate:
        return ""
    try:
        parsed = urlsplit(candidate)
    except ValueError:
        return candidate
    if parsed.scheme.casefold() not in {"http", "https"} or not parsed.netloc:
        return candidate
    safe_query = [
        (key, item)
        for key, item in parse_qsl(parsed.query, keep_blank_values=True)
        if not any(part in key.casefold() for part in _SENSITIVE_URL_QUERY_PARTS)
    ]
    return urlunsplit(
        (parsed.scheme, parsed.netloc, parsed.path, urlencode(safe_query), "")
    )


def _metric(item: dict[str, object], paths: tuple[tuple[str, ...], ...]) -> tuple[int, bool, list[str]]:
    warnings: list[str] = []
    seen_nonempty = False
    for path in paths:
        current: object = item
        found = True
        for key in path:
            if not isinstance(current, dict) or key not in current:
                found = False
                break
            current = current[key]
        if found:
            if current is None or (isinstance(current, str) and not current.strip()):
                continue
            seen_nonempty = True
            parsed, parsed_warnings = parse_metric(current)
            if not parsed_warnings:
                return parsed, True, warnings
            warnings.extend(parsed_warnings)
    return 0, seen_nonempty, warnings


def _normalized_item(raw: dict[str, object], row: int, platform_id: str) -> tuple[dict[str, object], list[str], list[str]]:
    title_found, title = _first(raw, "title", "desc", "display_title", "displayTitle")
    if not title_found:
        title = ""
    metric_paths = {
        "likes": (("likes",), ("liked_count",), ("likedCount",), ("statistics", "digg_count"), ("interact_info", "likedCount"), ("interactInfo", "likedCount")),
        "comments": (("comments",), ("comment_count",), ("comment_count_declared",), ("commentCount",), ("statistics", "comment_count"), ("interact_info", "commentCount"), ("interactInfo", "commentCount")),
        "collects": (("collects",), ("collected_count",), ("collectedCount",), ("statistics", "collect_count"), ("interact_info", "collectedCount"), ("interactInfo", "collectedCount")),
        "shares": (("shares",), ("shared_count",), ("sharedCount",), ("statistics", "share_count"), ("interact_info", "sharedCount"), ("interactInfo", "sharedCount")),
    }
    missing: list[str] = []
    warnings: list[str] = []
    result: dict[str, object] = {"sourceRow": row, "title": _text(title)}
    for field in _METRICS:
        number, present, metric_warnings = _metric(raw, metric_paths[field])
        result[field] = number
        if not present:
            missing.append(field)
            warnings.append(f"missing_metric:{field}:row={row}")
        warnings.extend(f"{warning}:{field}:row={row}" for warning in metric_warnings)
    time_found, raw_time = _first(raw, "publishedAt", "published_at", "create_time", "time")
    parsed_time, time_warnings = parse_publish_time(raw_time if time_found else None)
    result["publishedAt"] = parsed_time.isoformat() if parsed_time is not None else None
    if not time_found or parsed_time is None:
        warnings.append(f"missing_publishedAt:row={row}")
    warnings.extend(f"{warning}:row={row}" for warning in time_warnings)
    url_found, raw_url = _first(raw, "url", "share_url", "link")
    result["url"] = sanitize_public_url(raw_url) if url_found else ""
    if not result["url"]:
        missing.append("url")
        warnings.append(f"missing_url:row={row}")
    result["totalInteractions"] = sum(int(result[field]) for field in _METRICS)
    return result, missing, warnings


def _items(raw_items: object, platform_id: str) -> tuple[list[dict[str, object]], list[str], list[str]]:
    if not isinstance(raw_items, list):
        raise ValueError("missing_source_items")
    items: list[dict[str, object]] = []
    missing: set[str] = set()
    warnings: list[str] = []
    for row, raw in enumerate(raw_items, start=1):
        if not isinstance(raw, dict):
            warnings.append(f"invalid_item:row={row}")
            continue
        item, item_missing, item_warnings = _normalized_item(raw, row, platform_id)
        items.append(item)
        missing.update(item_missing)
        warnings.extend(item_warnings)
    if not items:
        raise ValueError("missing_source_items")
    return items, sorted(missing), sorted(warnings)


def _subject(raw: dict[str, object], *, allow_item_id: bool = False) -> dict[str, object]:
    author = _object(raw.get("author"))
    nickname_found, nickname = _first(raw, "nickname", "author")
    if not nickname_found:
        nickname_found, nickname = _first(author, "nickname", "nick_name", "name")
    if not nickname_found:
        nickname = ""
    result: dict[str, object] = {"nickname": _text(nickname)}
    account_keys = ("sec_uid", "user_id", "userId", "red_id") + (("id",) if allow_item_id else ())
    for field, keys in (("accountId", account_keys), ("signature", ("signature", "desc", "description"))):
        found, value = _first(raw, *keys)
        if not found:
            found, value = _first(author, *keys)
        if found and _text(value):
            result[field] = _text(value)
    follower_found, follower_value = _first(raw, "follower_count", "followers", "fans", "fans_count")
    if not follower_found:
        follower_found, follower_value = _first(author, "follower_count", "followers", "fans", "fans_count")
    if follower_found:
        result["followers"] = parse_metric(follower_value)[0]
    return result


def _content(raw: dict[str, object], subject: dict[str, object], warnings: list[str], envelope: dict[str, object]) -> dict[str, object]:
    result: dict[str, object] = {}
    for target, keys in (("body", ("content", "desc", "summary")), ("ocr", ("ocr_cleaned_text", "ocr_raw_text"))):
        found, value = _first(raw, *keys)
        if found and _text(value):
            result[target] = _text(value)
        else:
            warnings.append(f"missing_content:{target}")
    transcription = _object(envelope.get("transcription"))
    found, value = _first(transcription, "transcript")
    transcript_source = "transcription.transcript" if found and _text(value) else ""
    if not found or not _text(value):
        found, value = _first(transcription, "cleaned_transcript")
        transcript_source = "transcription.cleaned_transcript" if found and _text(value) else ""
    if not found or not _text(value):
        found, value = _first(raw, "transcript", "video_transcript")
        transcript_source = "item.transcript" if found and _text(value) else ""
    if found and _text(value):
        result["transcript"] = _text(value)
        result["transcriptSource"] = transcript_source
    else:
        warnings.append("missing_content:transcript")
    public_author = {key: value for key, value in subject.items() if key in {"nickname", "accountId", "followers", "signature"} and value not in ("", None)}
    if public_author:
        result["author"] = public_author
    for target, keys in (("imageCount", ("image_count",)), ("videoDuration", ("duration",))):
        found, value = _first(raw, *keys)
        if found and isinstance(value, (int, float)) and not isinstance(value, bool):
            result[target] = int(value)
        elif not found:
            warnings.append(f"missing_content:{target}")
    return result


def _root_data(raw: dict[str, object]) -> dict[str, object]:
    return _object(raw.get("data")) or raw


def _account_source(platform_id: str, raw: dict[str, object], item_keys: tuple[str, ...]) -> dict[str, object]:
    data = _root_data(raw)
    profile = _object(data.get("profile")) or _object(data.get("user")) or _object(data.get("user_info"))
    raw_items: object = None
    for key in item_keys:
        if key in data:
            raw_items = data[key]
            break
    if raw_items is None:
        for key in item_keys:
            if key in raw:
                raw_items = raw[key]
                break
    items, missing_fields, warnings = _items(raw_items, platform_id)
    subject = _subject(profile, allow_item_id=True)
    if not subject.get("nickname") and not subject.get("accountId"):
        raise ValueError("missing_account_identity")
    return {
        "platformId": platform_id,
        "inputKind": "account",
        "reportType": "douyin-account" if platform_id == "douyin" else "xhs-account",
        "subject": subject,
        "account": subject,
        "items": items,
        "works": items,
        "fieldMap": {field: field for field in ("title", *_METRICS, "publishedAt", "url")},
        "missingFields": missing_fields,
        "warnings": warnings,
    }


def _content_source(platform_id: str, raw: dict[str, object], item_keys: tuple[str, ...]) -> dict[str, object]:
    data = _root_data(raw)
    item = data
    for key in item_keys:
        candidate = _object(data.get(key)) or _object(raw.get(key))
        if candidate:
            item = candidate
            break
    author = _object(data.get("author"))
    subject = _subject(author if author else item)
    normalized, missing_fields, warnings = _normalized_item(item, 1, platform_id)
    content = _content(item, subject, warnings, data)
    return {
        "platformId": platform_id,
        "inputKind": "content",
        "reportType": "douyin-content" if platform_id == "douyin" else "xhs-note",
        "subject": subject,
        "account": subject,
        "items": [normalized],
        "works": [normalized],
        "fieldMap": {field: field for field in ("title", *_METRICS, "publishedAt", "url")},
        "missingFields": sorted(set(missing_fields)),
        "warnings": sorted(set(warnings)),
        "content": content,
    }


def _read_douyin_account(raw: dict[str, object]) -> dict[str, object]:
    return _account_source("douyin", raw, ("videos", "aweme_list", "items"))


def _read_douyin_content(raw: dict[str, object]) -> dict[str, object]:
    return _content_source("douyin", raw, ("video", "aweme_detail"))


def _read_xhs_account(raw: dict[str, object]) -> dict[str, object]:
    return _account_source("xiaohongshu", raw, ("notes", "profile_notes", "note_list", "items"))


def _read_xhs_note(raw: dict[str, object]) -> dict[str, object]:
    return _content_source("xiaohongshu", raw, ("note", "data"))


def read_scrape_source(platform_id: str, input_kind: str, data_path: Path, excel_path: Path | None) -> dict[str, object]:
    """Read only task-scoped JSON/XLSX files and return the platform-neutral source contract."""
    dispatch: dict[tuple[str, str], Callable[[dict[str, object]], dict[str, object]]] = {
        ("douyin", "account"): _read_douyin_account,
        ("douyin", "content"): _read_douyin_content,
        ("xiaohongshu", "account"): _read_xhs_account,
        ("xiaohongshu", "content"): _read_xhs_note,
    }
    try:
        reader = dispatch[(platform_id, input_kind)]
    except KeyError:
        raise ValueError("unsupported_report_source") from None
    _validate_excel(excel_path)
    return reader(_load_json(data_path))
