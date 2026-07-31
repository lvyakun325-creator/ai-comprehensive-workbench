"""Build and persist deterministic evidence bundles from parsed workbooks."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import cast

from analytics import calculate_metrics, rank_works
from contracts import EvidenceBundle


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
    works = [dict(work) for work in cast(list[dict[str, object]], parsed.get("works", []))]
    return {
        "account": dict(cast(dict[str, object], parsed.get("account", {}))),
        "fieldMap": dict(cast(dict[str, object], parsed.get("fieldMap", {}))),
        "missingFields": _canonical_string_list(parsed.get("missingFields", [])),
        "warnings": _canonical_string_list(parsed.get("warnings", [])),
        "works": sorted(works, key=_source_row),
    }


def _bundle_digest(parsed: dict[str, object], source: dict[str, str]) -> str:
    canonical_input = {"parsed": parsed, "source": source}
    payload = json.dumps(canonical_input, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def _rank_by_row(rankings: dict[str, dict[str, object]]) -> dict[str, dict[int, int]]:
    results: dict[str, dict[int, int]] = {}
    for name, ranking in rankings.items():
        rows = ranking.get("rows", [])
        results[name] = {int(row): position for position, row in enumerate(rows, start=1)}
    return results


def build_evidence_bundle(parsed: dict[str, object], source: dict[str, str]) -> EvidenceBundle:
    """Create a repeatable evidence bundle without relying on current time or input list order."""
    canonical_parsed = _canonical_parsed(parsed)
    works = cast(list[dict[str, object]], canonical_parsed["works"])
    rankings = rank_works(works, _availability(canonical_parsed))
    metrics = calculate_metrics(works, rankings)
    rank_positions = _rank_by_row(rankings)
    items = []
    for number, work in enumerate(sorted(works, key=_source_row), start=1):
        source_row = _source_row(work)
        items.append(
            {
                "evidenceId": f"DY-E{number:04d}",
                "sourceRow": source_row,
                "title": str(work.get("title", "")),
                "likes": int(work.get("likes", 0)),
                "comments": int(work.get("comments", 0)),
                "collects": int(work.get("collects", 0)),
                "shares": int(work.get("shares", 0)),
                "totalInteractions": int(work.get("totalInteractions", 0)),
                "publishedAt": work.get("publishedAt") or "",
                "url": str(work.get("url", "")),
                "ranks": {name: positions.get(source_row) for name, positions in rank_positions.items()},
            }
        )

    return cast(
        EvidenceBundle,
        {
            "evidenceVersion": "1.0",
            "evidenceId": _bundle_digest(canonical_parsed, source),
            "source": dict(source),
            "account": dict(cast(dict[str, object], canonical_parsed["account"])),
            "completeness": {
                "fieldMap": dict(cast(dict[str, object], canonical_parsed["fieldMap"])),
                "missingFields": list(cast(list[object], canonical_parsed["missingFields"])),
                "warnings": list(cast(list[object], canonical_parsed["warnings"])),
                "availability": _availability(canonical_parsed),
            },
            "metrics": metrics,
            "rankings": rankings,
            "items": items,
        },
    )


def write_evidence_bundle(bundle: EvidenceBundle, output_dir: Path) -> Path:
    """Write canonical JSON using the account nickname in a deterministic filename."""
    output_dir.mkdir(parents=True, exist_ok=True)
    account = cast(dict[str, object], bundle.get("account", {}))
    nickname = str(account.get("nickname") or "未命名账号").replace("/", "_").replace("\\", "_")
    path = output_dir / f"{nickname}_证据包.json"
    path.write_text(json.dumps(bundle, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    return path
