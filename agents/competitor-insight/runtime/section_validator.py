"""Validate model-authored report sections against deterministic evidence."""

from __future__ import annotations

from copy import deepcopy
import re
from typing import cast

from contracts import EvidenceBundle


STRENGTH_LABELS = {
    "direct": "",
    "weak": "基于标题和互动数据的弱判断",
    "hypothesis": "待验证假设",
}

_BATCH_KEYS = {
    "batchId",
    "claims",
    "topicDirections",
    "filmingTemplates",
    "conversionItems",
    "executionDays",
}
_CLAIM_KEYS = {
    "statement",
    "strength",
    "evidenceIds",
    "rationale",
    "verificationPlan",
    "complianceNotes",
}
_TOPIC_KEYS = {"title", "angle", "evidenceIds", "complianceNotes"}
_FILMING_KEYS = {"name", "hook", "structure", "evidenceIds", "complianceNotes"}
_CONVERSION_KEYS = {"action", "evidenceIds", "complianceNotes"}
_EXECUTION_KEYS = {"day", "action", "evidenceIds", "complianceNotes"}
_NUMERIC_PATTERN = re.compile(r"(?<![A-Za-z])\d+(?:[,.]\d+)*(?:%|万|w|W)?")
_ALLOWED_NUMERIC_STRUCTURES = (
    re.compile(r"(?<!\d)3\s*秒"),
    re.compile(r"(?<!\d)5\s*个"),
    re.compile(r"(?<!\d)7\s*天"),
    re.compile(r"(?<!\d)2\s*[-–—至]\s*3\s*条"),
    re.compile(r"(?<!\d)(?:19|20)\d{2}\s*年?(?!\d)"),
)
_MEDICAL_VIOLATIONS = (
    "根治",
    "治愈",
    "保证有效",
    "无副作用",
    "最安全",
    "唯一方案",
    "包治",
    "停药",
    "换药",
    "加量",
    "减量",
    "替代医生",
    "无需就医",
)


def _object(value: object, error: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ValueError(error)
    return cast(dict[str, object], value)


def _list(value: object, error: str) -> list[object]:
    if not isinstance(value, list):
        raise ValueError(error)
    return cast(list[object], value)


def _text(value: object, error: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(error)
    return value.strip()


def _keys(value: dict[str, object], required: set[str], allowed: set[str], name: str) -> None:
    missing = sorted(required - value.keys())
    if missing:
        raise ValueError(f"missing_{name}_keys:{','.join(missing)}")
    extras = sorted(value.keys() - allowed)
    if extras:
        raise ValueError(f"unknown_{name}_keys:{','.join(extras)}")


def medical_compliance_violations(text: str) -> list[str]:
    """Return prohibited medical-marketing phrases that are not explicit warnings."""
    violations = []
    for phrase in _MEDICAL_VIOLATIONS:
        position = 0
        while True:
            position = text.find(phrase, position)
            if position < 0:
                break
            prefix = text[max(0, position - 8) : position]
            explicitly_prohibited = re.search(
                r"(?:不|不得|不能|避免|禁止|切勿|严禁)[^，。；！？]{0,6}$",
                prefix,
            )
            if not explicitly_prohibited and phrase not in violations:
                violations.append(phrase)
            position += len(phrase)
    return violations


def _check_model_text(text: str) -> None:
    violations = medical_compliance_violations(text)
    if violations:
        raise ValueError(f"medical_compliance_violation:{violations[0]}")
    without_allowed = text
    for pattern in _ALLOWED_NUMERIC_STRUCTURES:
        without_allowed = pattern.sub("", without_allowed)
    match = _NUMERIC_PATTERN.search(without_allowed)
    if match:
        raise ValueError(f"untrusted_numeric_claim:{match.group(0)}")


def _text_list(value: object, error: str, *, allow_empty: bool = True) -> list[str]:
    values = _list(value, error)
    if not allow_empty and not values:
        raise ValueError(error)
    result = []
    for item in values:
        text = _text(item, error)
        _check_model_text(text)
        result.append(text)
    return result


def _known_evidence(bundle: EvidenceBundle) -> dict[str, dict[str, object]]:
    items = bundle.get("items", [])
    if not isinstance(items, list):
        raise ValueError("invalid_evidence_bundle")
    known: dict[str, dict[str, object]] = {}
    for raw_item in items:
        if not isinstance(raw_item, dict):
            raise ValueError("invalid_evidence_bundle")
        item = cast(dict[str, object], raw_item)
        evidence_id = item.get("evidenceId")
        if not isinstance(evidence_id, str) or not evidence_id:
            raise ValueError("invalid_evidence_bundle")
        known[evidence_id] = item
    return known


def _evidence_ids(value: object, known: dict[str, dict[str, object]]) -> list[str]:
    raw_ids = _list(value, "invalid_evidence_ids")
    if not raw_ids:
        raise ValueError("evidence_ids_required")
    evidence_ids = []
    for raw_id in raw_ids:
        evidence_id = _text(raw_id, "invalid_evidence_id")
        if evidence_id not in known:
            raise ValueError(f"unknown_evidence_id:{evidence_id}")
        evidence_ids.append(evidence_id)
    return evidence_ids


def _optional_compliance_notes(
    value: dict[str, object],
    *,
    required: bool,
) -> list[str] | None:
    if "complianceNotes" not in value:
        if required:
            raise ValueError("missing_compliance_notes")
        return None
    return _text_list(value["complianceNotes"], "invalid_compliance_notes")


def _validate_claim(raw: object, known: dict[str, dict[str, object]]) -> dict[str, object]:
    claim = _object(raw, "invalid_claim")
    _keys(claim, {"statement", "strength", "evidenceIds"}, _CLAIM_KEYS, "claim")
    statement = _text(claim["statement"], "invalid_claim_statement")
    _check_model_text(statement)
    strength = _text(claim["strength"], "invalid_claim_strength")
    if strength not in STRENGTH_LABELS:
        raise ValueError(f"invalid_claim_strength:{strength}")
    _evidence_ids(claim["evidenceIds"], known)

    rationale = claim.get("rationale")
    if not isinstance(rationale, str) or not rationale.strip():
        if strength == "weak":
            raise ValueError("weak_claim_requires_label")
        if strength == "hypothesis":
            raise ValueError("hypothesis_claim_requires_label")
        raise ValueError("direct_claim_requires_rationale")
    _check_model_text(rationale)

    if strength in {"weak", "hypothesis"}:
        verification = claim.get("verificationPlan")
        if not isinstance(verification, str) or not verification.strip():
            raise ValueError(f"{strength}_claim_requires_label")
        _check_model_text(verification)
    elif "verificationPlan" in claim:
        verification = _text(claim["verificationPlan"], "invalid_verification_plan")
        _check_model_text(verification)
    _optional_compliance_notes(claim, required=False)
    return claim


def _validate_topic(raw: object, known: dict[str, dict[str, object]]) -> dict[str, object]:
    topic = _object(raw, "invalid_topic_direction")
    _keys(topic, _TOPIC_KEYS, _TOPIC_KEYS, "topic_direction")
    for field in ("title", "angle"):
        _check_model_text(_text(topic[field], f"invalid_topic_{field}"))
    _evidence_ids(topic["evidenceIds"], known)
    _optional_compliance_notes(topic, required=True)
    return topic


def _validate_filming(raw: object, known: dict[str, dict[str, object]]) -> dict[str, object]:
    template = _object(raw, "invalid_filming_template")
    _keys(template, _FILMING_KEYS, _FILMING_KEYS, "filming_template")
    for field in ("name", "hook"):
        _check_model_text(_text(template[field], f"invalid_filming_{field}"))
    _text_list(template["structure"], "invalid_filming_structure", allow_empty=False)
    _evidence_ids(template["evidenceIds"], known)
    _optional_compliance_notes(template, required=True)
    return template


def _validate_conversion(raw: object, known: dict[str, dict[str, object]]) -> dict[str, object]:
    item = _object(raw, "invalid_conversion_item")
    _keys(item, _CONVERSION_KEYS, _CONVERSION_KEYS, "conversion_item")
    _check_model_text(_text(item["action"], "invalid_conversion_action"))
    _evidence_ids(item["evidenceIds"], known)
    _optional_compliance_notes(item, required=True)
    return item


def _validate_execution(raw: object, known: dict[str, dict[str, object]]) -> dict[str, object]:
    item = _object(raw, "invalid_execution_day")
    _keys(item, _EXECUTION_KEYS, _EXECUTION_KEYS, "execution_day")
    day = item["day"]
    if isinstance(day, bool) or not isinstance(day, int) or not 1 <= day <= 7:
        raise ValueError("invalid_execution_day_number")
    _check_model_text(_text(item["action"], "invalid_execution_action"))
    _evidence_ids(item["evidenceIds"], known)
    _optional_compliance_notes(item, required=True)
    return item


def _ranked_evidence_ids(
    bundle: EvidenceBundle,
    known: dict[str, dict[str, object]],
) -> set[str]:
    ranked_rows: set[int] = set()
    rankings = bundle.get("rankings", {})
    if not isinstance(rankings, dict):
        return set()
    for name in ("overall", "startup"):
        ranking = rankings.get(name, {})
        if isinstance(ranking, dict):
            rows = ranking.get("rows", [])
            if isinstance(rows, list):
                ranked_rows.update(
                    int(row)
                    for row in rows
                    if isinstance(row, (int, float)) and not isinstance(row, bool)
                )
    return {
        evidence_id
        for evidence_id, item in known.items()
        if item.get("sourceRow") in ranked_rows
    }


def _validate_recommendation_contract(
    batch: dict[str, object],
    bundle: EvidenceBundle,
    known: dict[str, dict[str, object]],
) -> None:
    topics = cast(list[dict[str, object]], batch["topicDirections"])
    filming = cast(list[dict[str, object]], batch["filmingTemplates"])
    execution = cast(list[dict[str, object]], batch["executionDays"])
    if len(topics) != 5:
        raise ValueError("topic_directions_must_equal_5")
    if len(filming) != 3:
        raise ValueError("filming_templates_must_equal_3")
    days = [item.get("day") for item in execution]
    if len(days) != 7 or sorted(days) != list(range(1, 8)):
        raise ValueError("execution_days_must_cover_1_to_7")

    ranked_ids = _ranked_evidence_ids(bundle, known)
    recommendation_items = [
        *topics,
        *filming,
        *cast(list[dict[str, object]], batch["conversionItems"]),
        *execution,
    ]
    for item in recommendation_items:
        evidence_ids = cast(list[str], item["evidenceIds"])
        if not ranked_ids.intersection(evidence_ids):
            raise ValueError("recommendation_requires_ranked_evidence")


def validate_section_batch(batch: object, bundle: EvidenceBundle) -> dict[str, object]:
    """Return a detached validated batch or raise a stable validation error."""
    normalized = deepcopy(_object(batch, "expected_section_batch_object"))
    _keys(normalized, _BATCH_KEYS, _BATCH_KEYS, "batch")
    batch_id = _text(normalized["batchId"], "invalid_batch_id")
    known = _known_evidence(bundle)

    claims = _list(normalized["claims"], "invalid_claims")
    topics = _list(normalized["topicDirections"], "invalid_topic_directions")
    filming = _list(normalized["filmingTemplates"], "invalid_filming_templates")
    conversions = _list(normalized["conversionItems"], "invalid_conversion_items")
    execution = _list(normalized["executionDays"], "invalid_execution_days")

    normalized["batchId"] = batch_id
    normalized["claims"] = [_validate_claim(item, known) for item in claims]
    normalized["topicDirections"] = [_validate_topic(item, known) for item in topics]
    normalized["filmingTemplates"] = [_validate_filming(item, known) for item in filming]
    normalized["conversionItems"] = [_validate_conversion(item, known) for item in conversions]
    normalized["executionDays"] = [_validate_execution(item, known) for item in execution]

    if batch_id == "recommendations":
        _validate_recommendation_contract(normalized, bundle, known)
    return normalized
