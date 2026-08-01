"""Build and persist deterministic evidence bundles from parsed workbooks."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import cast

from analytics import calculate_metrics, rank_works
from contracts import EvidenceBundle


_REPORT_TYPES = {
    ("douyin", "account"): "douyin-account",
    ("douyin", "content"): "douyin-content",
    ("xiaohongshu", "account"): "xhs-account",
    ("xiaohongshu", "content"): "xhs-note",
}


def _source_row(work: dict[str, object]) -> int:
    value = work.get("sourceRow")
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0


def _availability(parsed: dict[str, object]) -> dict[str, bool]:
    missing = set(cast(list[str], parsed.get("missingFields", [])))
    return {field: field not in missing for field in ("comments", "collects", "shares")}


def _canonical_string_list(value: object) -> list[str]:
    values = cast(list[object], value) if isinstance(value, list) else []
    return sorted(str(item) for item in values)


def _canonical_parsed(parsed: dict[str, object]) -> dict[str, object]:
    raw_works = parsed.get("items", parsed.get("works", []))
    works = [dict(work) for work in cast(list[dict[str, object]], raw_works)]
    platform_id = str(parsed.get("platformId") or "douyin")
    input_kind = str(parsed.get("inputKind") or "account")
    try:
        report_type = _REPORT_TYPES[(platform_id, input_kind)]
    except KeyError:
        raise ValueError("unsupported_report_source") from None
    supplied_report_type = parsed.get("reportType")
    if supplied_report_type is not None and supplied_report_type != report_type:
        raise ValueError("unsupported_report_source")
    return {
        "platformId": platform_id,
        "inputKind": input_kind,
        "reportType": report_type,
        "subject": dict(cast(dict[str, object], parsed.get("subject", parsed.get("account", {})))),
        "fieldMap": dict(cast(dict[str, object], parsed.get("fieldMap", {}))),
        "missingFields": _canonical_string_list(parsed.get("missingFields", [])),
        "warnings": _canonical_string_list(parsed.get("warnings", [])),
        "works": sorted(works, key=_source_row),
        "content": dict(cast(dict[str, object], parsed.get("content", {}))),
    }


def _bundle_digest(parsed: dict[str, object], source: dict[str, object]) -> str:
    canonical_input = {"parsed": parsed, "source": source}
    payload = json.dumps(canonical_input, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def _rank_by_row(rankings: dict[str, dict[str, object]]) -> dict[str, dict[int, int]]:
    results: dict[str, dict[int, int]] = {}
    for name, ranking in rankings.items():
        rows = ranking.get("rows", [])
        results[name] = {int(row): position for position, row in enumerate(rows, start=1)}
    return results


def build_evidence_bundle(parsed: dict[str, object], source: dict[str, object]) -> EvidenceBundle:
    """Create a repeatable evidence bundle without relying on current time or input list order."""
    canonical_parsed = _canonical_parsed(parsed)
    works = cast(list[dict[str, object]], canonical_parsed["works"])
    input_kind = str(canonical_parsed["inputKind"])
    rankings = rank_works(works, _availability(canonical_parsed), account=input_kind == "account")
    metrics = calculate_metrics(works, rankings)
    rank_positions = _rank_by_row(rankings)
    items = []
    for number, work in enumerate(sorted(works, key=_source_row), start=1):
        source_row = _source_row(work)
        items.append(
            {
                "evidenceId": f"{'DY' if canonical_parsed['platformId'] == 'douyin' else 'XHS'}-E{number:04d}",
                "sourceRow": source_row,
                "title": str(work.get("title", "")),
                "likes": int(work.get("likes", 0)),
                "comments": int(work.get("comments", 0)),
                "collects": int(work.get("collects", 0)),
                "shares": int(work.get("shares", 0)),
                "totalInteractions": int(work.get("totalInteractions", 0)),
                "publishedAt": work.get("publishedAt") or "",
                "url": str(work.get("url", "")),
                "ranks": {name: positions.get(source_row) for name, positions in rank_positions.items()} if input_kind == "account" else {},
            }
        )

    return cast(
        EvidenceBundle,
        {
            "evidenceVersion": "2.0",
            "evidenceId": _bundle_digest(canonical_parsed, source),
            "platformId": canonical_parsed["platformId"],
            "inputKind": canonical_parsed["inputKind"],
            "reportType": canonical_parsed["reportType"],
            "source": dict(source),
            "subject": dict(cast(dict[str, object], canonical_parsed["subject"])),
            "account": dict(cast(dict[str, object], canonical_parsed["subject"])),
            "completeness": {
                "fieldMap": dict(cast(dict[str, object], canonical_parsed["fieldMap"])),
                "missingFields": list(cast(list[object], canonical_parsed["missingFields"])),
                "warnings": list(cast(list[object], canonical_parsed["warnings"])),
                "availability": _availability(canonical_parsed),
            },
            "metrics": metrics,
            "rankings": rankings,
            "items": items,
            **({"content": dict(cast(dict[str, object], canonical_parsed["content"]))} if canonical_parsed["content"] else {}),
        },
    )


def write_evidence_bundle(bundle: EvidenceBundle, output_dir: Path) -> Path:
    """Write canonical JSON using the account nickname in a deterministic filename."""
    output_dir.mkdir(parents=True, exist_ok=True)
    account = cast(dict[str, object], bundle.get("subject", bundle.get("account", {})))
    nickname = str(account.get("nickname") or "未命名账号").replace("/", "_").replace("\\", "_")
    path = output_dir / f"{nickname}_证据包.json"
    path.write_text(json.dumps(bundle, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    return path
