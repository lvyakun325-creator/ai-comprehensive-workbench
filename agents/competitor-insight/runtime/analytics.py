"""Deterministic rankings and summary metrics for parsed account works."""

from __future__ import annotations

from datetime import datetime
import math
from typing import Callable


_METRIC_FIELDS = ("likes", "comments", "collects", "shares")


def _integer(value: object) -> int:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0


def _published_timestamp(value: object) -> float:
    if not isinstance(value, str) or not value:
        return 0.0
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.timestamp()
    except ValueError:
        return 0.0


def _source_row(work: dict[str, object]) -> int:
    return _integer(work.get("sourceRow"))


def _total_interactions(work: dict[str, object]) -> int:
    total = sum(_integer(work.get(field)) for field in _METRIC_FIELDS)
    work["totalInteractions"] = total
    return total


def _ranked_rows(works: list[dict[str, object]], metric: Callable[[dict[str, object]], int], limit: int) -> list[int]:
    ordered = sorted(
        works,
        key=lambda work: (-metric(work), -_published_timestamp(work.get("publishedAt")), _source_row(work)),
    )
    return [_source_row(work) for work in ordered[:limit]]


def rank_works(works: list[dict[str, object]], availability: dict[str, bool]) -> dict[str, dict[str, object]]:
    """Rank works using source-row identifiers and deterministic tie breakers."""
    for work in works:
        _total_interactions(work)

    rankings: dict[str, dict[str, object]] = {
        "overall": {"status": "available", "rows": _ranked_rows(works, _total_interactions, 10)},
    }

    dated_works = [work for work in works if _published_timestamp(work.get("publishedAt")) > 0]
    startup_sample_size = 5 if len(works) < 20 else math.ceil(len(works) * 0.25)
    startup_sample = sorted(
        dated_works,
        key=lambda work: (_published_timestamp(work.get("publishedAt")), _source_row(work)),
    )[:startup_sample_size]
    average_total = sum(_total_interactions(work) for work in works) / len(works) if works else 0.0
    high_performers = [work for work in startup_sample if _total_interactions(work) > average_total * 2]
    selected_startup = _ranked_rows(high_performers, _total_interactions, 5)
    if len(selected_startup) < 5:
        selected_rows = set(selected_startup)
        selected_startup.extend(
            row
            for row in _ranked_rows(startup_sample, _total_interactions, len(startup_sample))
            if row not in selected_rows
        )
        selected_startup = selected_startup[:5]
    rankings["startup"] = {
        "status": "available",
        "rows": selected_startup,
        "sampleRows": [_source_row(work) for work in startup_sample],
    }

    for name, field in (("collect", "collects"), ("share", "shares"), ("comment", "comments")):
        if not availability.get(field, True):
            rankings[name] = {"status": "unavailable", "rows": []}
            continue
        rankings[name] = {"status": "available", "rows": _ranked_rows(works, lambda work, key=field: _integer(work.get(key)), 5)}
    return rankings


def calculate_metrics(works: list[dict[str, object]], rankings: dict[str, dict[str, object]]) -> dict[str, int | float | None]:
    """Calculate fixed data-summary metrics without representing undefined ratios as zero."""
    for work in works:
        _total_interactions(work)
    count = len(works)
    totals = {field: sum(_integer(work.get(field)) for work in works) for field in _METRIC_FIELDS}
    total_interactions = sum(_total_interactions(work) for work in works)
    max_interactions = max((_total_interactions(work) for work in works), default=0)
    average_interactions = total_interactions / count if count else None
    overall_rows = set(rankings.get("overall", {}).get("rows", []))
    top10_total = sum(_total_interactions(work) for work in works if _source_row(work) in overall_rows)

    return {
        "workCount": count,
        "averageLikes": totals["likes"] / count if count else None,
        "averageComments": totals["comments"] / count if count else None,
        "averageCollects": totals["collects"] / count if count else None,
        "averageShares": totals["shares"] / count if count else None,
        "averageInteractions": average_interactions,
        "maxInteractions": max_interactions,
        "aboveAverageInteractionCount": sum(
            1 for work in works if average_interactions is not None and _total_interactions(work) > average_interactions
        ),
        "top10InteractionShare": top10_total / total_interactions if total_interactions else None,
        "maxToAverageMultiple": max_interactions / average_interactions if average_interactions else None,
    }
