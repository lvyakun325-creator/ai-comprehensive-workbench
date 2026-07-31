"""Deterministic value normalization for locally exported workbooks."""

from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
import math
import re

from openpyxl.utils.datetime import from_excel


_METRIC_PATTERN = re.compile(r"^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*([wW万]?)$")
_TIME_FORMATS = ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M")


def parse_metric(value: object) -> tuple[int, list[str]]:
    """Convert common Chinese social metric formats to a non-negative integer."""
    if value is None or isinstance(value, bool):
        return 0, []

    if isinstance(value, (int, float, Decimal)):
        if isinstance(value, float) and not math.isfinite(value):
            return 0, ["unrecognized_metric"]
        numeric = Decimal(str(value))
    elif isinstance(value, str):
        text = value.strip().replace(",", "")
        if not text:
            return 0, []
        match = _METRIC_PATTERN.fullmatch(text)
        if not match:
            return 0, ["unrecognized_metric"]
        try:
            numeric = Decimal(match.group(1))
        except InvalidOperation:
            return 0, ["unrecognized_metric"]
        if match.group(2):
            numeric *= Decimal(10_000)
    else:
        return 0, ["unrecognized_metric"]

    if not numeric.is_finite():
        return 0, ["unrecognized_metric"]
    if numeric < 0:
        return 0, ["negative_metric"]
    return int(numeric), []


def parse_publish_time(value: object) -> tuple[datetime | None, list[str]]:
    """Parse exported publish times without applying timezone conversion."""
    if isinstance(value, datetime):
        return value.replace(tzinfo=None), []
    if isinstance(value, str):
        text = value.strip()
        for time_format in _TIME_FORMATS:
            try:
                return datetime.strptime(text, time_format), []
            except ValueError:
                continue
        return None, ["invalid_publish_time"]
    if isinstance(value, bool) or value is None:
        return None, ["invalid_publish_time"]
    if not isinstance(value, (int, float, Decimal)):
        return None, ["invalid_publish_time"]

    try:
        numeric = float(value)
    except (TypeError, ValueError, OverflowError):
        return None, ["invalid_publish_time"]
    if not math.isfinite(numeric) or numeric < 0:
        return None, ["invalid_publish_time"]

    try:
        if numeric >= 100_000_000_000:
            return datetime.fromtimestamp(numeric / 1000, UTC).replace(tzinfo=None), []
        if numeric >= 100_000_000:
            return datetime.fromtimestamp(numeric, UTC).replace(tzinfo=None), []
        parsed = from_excel(numeric)
        return parsed.replace(tzinfo=None) if isinstance(parsed, datetime) else parsed, []
    except (OverflowError, OSError, ValueError, TypeError):
        return None, ["invalid_publish_time"]
