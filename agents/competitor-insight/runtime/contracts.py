from typing import Literal, NotRequired, TypedDict


AccountClaimSection = Literal["strategy", "business", "content", "traffic", "data"]
ContentClaimSection = Literal["content-overview", "content-structure", "interaction", "conversion"]
SectionBatchId = Literal["strategy", "performance", "execution", "content"]


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
    evidenceVersion: Literal["2.0"]
    evidenceId: str
    platformId: Literal["douyin", "xiaohongshu"]
    inputKind: Literal["account", "content"]
    reportType: Literal["douyin-account", "douyin-content", "xhs-account", "xhs-note"]
    subject: dict[str, object]
    completeness: dict[str, object]
    metrics: dict[str, int | float | None]
    rankings: dict[str, dict[str, object]]
    items: list[EvidenceItem]
    content: NotRequired[dict[str, object]]
    source: NotRequired[dict[str, object]]
    account: NotRequired[dict[str, object]]


class SectionClaim(TypedDict):
    section: AccountClaimSection | ContentClaimSection
    statement: str
    strength: Literal["direct", "weak", "hypothesis"]
    evidenceIds: list[str]
    rationale: str
    verificationPlan: NotRequired[str]
    complianceNotes: NotRequired[list[str]]


class SectionBatch(TypedDict):
    batchId: SectionBatchId
    claims: list[SectionClaim]
    topicDirections: list[dict[str, object]]
    filmingTemplates: list[dict[str, object]]
    conversionItems: list[dict[str, object]]
    executionDays: list[dict[str, object]]


class TrustedBatchContext(TypedDict):
    """Server-controlled evidence allowlist for one requested model batch."""

    batchId: SectionBatchId
    allowedEvidenceIds: list[str]


class ReportArtifact(TypedDict):
    reportVersion: Literal["1.0"]
    evidence: EvidenceBundle
    sections: list[SectionBatch]


class FinalReportValidationInput(TypedDict):
    markdown: str
    evidence: EvidenceBundle
    batches: list[SectionBatch]
    trustedBatchContexts: list[TrustedBatchContext]


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
