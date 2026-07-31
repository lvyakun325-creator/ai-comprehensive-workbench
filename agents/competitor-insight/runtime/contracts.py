from typing import Literal, NotRequired, TypedDict


class EvidenceItem(TypedDict):
    evidenceId: str
    sourceRow: int
    title: str
    likes: int
    comments: int
    collects: int
    shares: int
    totalInteractions: int
    publishedAt: str
    url: str
    ranks: dict[str, int | None]


class EvidenceBundle(TypedDict):
    evidenceVersion: Literal["1.0"]
    evidenceId: str
    account: dict[str, object]
    completeness: dict[str, object]
    metrics: dict[str, int | float | None]
    rankings: dict[str, dict[str, object]]
    items: list[EvidenceItem]


class SectionClaim(TypedDict):
    section: Literal["strategy", "business", "content", "traffic", "data"]
    statement: str
    strength: Literal["direct", "weak", "hypothesis"]
    evidenceIds: list[str]
    rationale: str
    verificationPlan: NotRequired[str]
    complianceNotes: NotRequired[list[str]]


class SectionBatch(TypedDict):
    batchId: Literal["strategy", "performance", "execution"]
    claims: list[SectionClaim]
    topicDirections: list[dict[str, object]]
    filmingTemplates: list[dict[str, object]]
    conversionItems: list[dict[str, object]]
    executionDays: list[dict[str, object]]


class ReportArtifact(TypedDict):
    reportVersion: Literal["1.0"]
    evidence: EvidenceBundle
    sections: list[SectionBatch]


class FinalReportValidationInput(TypedDict):
    markdown: str
    evidence: EvidenceBundle
    batches: list[SectionBatch]


def validate_contract_shape(
    value: object,
    required_keys: set[str],
) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ValueError("expected_object")
    missing = sorted(required_keys - value.keys())
    if missing:
        raise ValueError(f"missing_keys:{','.join(missing)}")
    return value
