"""Render evidence-backed competitor reports without trusting model numbers."""

from __future__ import annotations

import html
import re
from typing import cast

from contracts import EvidenceBundle
from section_validator import (
    STRENGTH_LABELS,
    medical_compliance_violations,
    validate_section_batch,
)


_SECTION_HEADINGS = (
    "# 抖音账号分析报告 - @{nickname}",
    "## 账号概览",
    "## 战略层：账号定位与人设分析",
    "## 业务层：转化路径与商业价值分析",
    "## 内容层：选题策略与爆款内容分析",
    "## Top 10 高表现作品",
    "## 起号期 Top 5",
    "## 高收藏、高分享、高评论作品",
    "## 流量层：传播与互动表现分析",
    "## 数据层：关键指标与账号健康度分析",
    "## 对标建议：拍什么、怎么拍、怎么承接",
    "## 7 天对标执行清单",
)
_TABLE_HEADER = "| 排名 | 标题 | 点赞 | 评论 | 收藏 | 分享 | 综合互动量 |"
_TABLE_DIVIDER = "| ---: | --- | ---: | ---: | ---: | ---: | ---: |"
_EVIDENCE_ID_PATTERN = re.compile(r"\bDY-E\d{4,}\b")
_NUMERIC_TOKEN_PATTERN = re.compile(r"(?<![A-Za-z])\d[\d,]*(?:\.\d+)?%?")
_MARKDOWN_SPECIAL = re.compile(r"([\\`*_{}\[\]()#+|>])")


def _safe_text(value: object) -> str:
    text = html.escape(str(value or ""), quote=False)
    text = " ".join(text.replace("\r", "\n").splitlines())
    return _MARKDOWN_SPECIAL.sub(r"\\\1", text)


def _integer(value: object) -> int:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0


def _format_count(value: object) -> str:
    return f"{_integer(value):,}"


def _items_by_id(bundle: EvidenceBundle) -> dict[str, dict[str, object]]:
    return {
        str(item["evidenceId"]): cast(dict[str, object], item)
        for item in bundle.get("items", [])
        if isinstance(item, dict) and item.get("evidenceId")
    }


def _items_by_row(bundle: EvidenceBundle) -> dict[int, dict[str, object]]:
    return {
        _integer(item.get("sourceRow")): cast(dict[str, object], item)
        for item in bundle.get("items", [])
        if isinstance(item, dict)
    }


def _rank_text(item: dict[str, object]) -> str:
    ranks = item.get("ranks", {})
    ranks = ranks if isinstance(ranks, dict) else {}
    labels = (
        ("overall", "综合排名"),
        ("startup", "起号期排名"),
        ("collect", "收藏排名"),
        ("share", "分享排名"),
        ("comment", "评论排名"),
    )
    rendered = []
    for key, label in labels:
        value = ranks.get(key)
        if isinstance(value, int) and not isinstance(value, bool):
            rendered.append(f"{label}：{value}")
    return "；".join(rendered) if rendered else "榜单排名：未进入固定榜单"


def render_evidence_reference(evidence_id: str, bundle: EvidenceBundle) -> str:
    """Expand one evidence identifier using bundle fields only."""
    item = _items_by_id(bundle).get(evidence_id)
    if item is None:
        raise ValueError(f"unknown_evidence_id:{evidence_id}")
    return (
        f"证据 `{_safe_text(evidence_id)}`：{_safe_text(item.get('title'))}；"
        f"{_rank_text(item)}；"
        f"点赞：{_format_count(item.get('likes'))}；"
        f"评论：{_format_count(item.get('comments'))}；"
        f"收藏：{_format_count(item.get('collects'))}；"
        f"分享：{_format_count(item.get('shares'))}；"
        f"综合互动量：{_format_count(item.get('totalInteractions'))}；"
        f"发布时间：{_safe_text(item.get('publishedAt') or '缺失')}"
    )


def _ranking_rows(bundle: EvidenceBundle, ranking_name: str) -> list[dict[str, object]]:
    ranking = bundle.get("rankings", {}).get(ranking_name, {})
    if not isinstance(ranking, dict) or ranking.get("status") == "unavailable":
        return []
    rows = ranking.get("rows", [])
    if not isinstance(rows, list):
        return []
    by_row = _items_by_row(bundle)
    return [by_row[_integer(row)] for row in rows if _integer(row) in by_row]


def _ranking_table(bundle: EvidenceBundle, ranking_name: str) -> str:
    ranking = bundle.get("rankings", {}).get(ranking_name, {})
    if isinstance(ranking, dict) and ranking.get("status") == "unavailable":
        return "该指标在源数据中不可用，未生成榜单。"
    rows = _ranking_rows(bundle, ranking_name)
    lines = [_TABLE_HEADER, _TABLE_DIVIDER]
    for position, item in enumerate(rows, start=1):
        lines.append(
            "| "
            + " | ".join(
                (
                    str(position),
                    _safe_text(item.get("title")),
                    _format_count(item.get("likes")),
                    _format_count(item.get("comments")),
                    _format_count(item.get("collects")),
                    _format_count(item.get("shares")),
                    _format_count(item.get("totalInteractions")),
                )
            )
            + " |"
        )
    return "\n".join(lines)


def _evidence_lines(evidence_ids: object, bundle: EvidenceBundle) -> list[str]:
    ids = cast(list[str], evidence_ids) if isinstance(evidence_ids, list) else []
    return [f"  - {render_evidence_reference(evidence_id, bundle)}" for evidence_id in ids]


def _render_claims(claims: list[dict[str, object]], bundle: EvidenceBundle) -> str:
    if not claims:
        return "本批未提供独立判断。"
    lines: list[str] = []
    for claim in claims:
        strength = str(claim.get("strength"))
        label = STRENGTH_LABELS.get(strength, "")
        prefix = f"**{label}**：" if label else ""
        lines.append(f"- {prefix}{_safe_text(claim.get('statement'))}")
        lines.append(f"  - 判断依据：{_safe_text(claim.get('rationale'))}")
        if claim.get("verificationPlan"):
            lines.append(f"  - 验证方式：{_safe_text(claim.get('verificationPlan'))}")
        lines.extend(_evidence_lines(claim.get("evidenceIds"), bundle))
    return "\n".join(lines)


def _partition(values: list[dict[str, object]], count: int) -> list[list[dict[str, object]]]:
    result = [[] for _ in range(count)]
    for index, value in enumerate(values):
        result[min(index, count - 1)].append(value)
    return result


def _format_metric(name: str, value: object) -> str:
    if value is None:
        return "数据不足"
    if name == "top10InteractionShare":
        return f"{float(cast(float, value)):.1%}"
    if isinstance(value, float):
        return f"{value:,.2f}"
    if isinstance(value, int) and not isinstance(value, bool):
        return f"{value:,}"
    return _safe_text(value)


def _account_overview(bundle: EvidenceBundle) -> str:
    account = bundle.get("account", {})
    metrics = bundle.get("metrics", {})
    nickname = _safe_text(account.get("nickname", "未命名账号"))
    lines = [f"- 账号昵称：@{nickname}"]
    followers = account.get("followers")
    if isinstance(followers, (int, float)) and not isinstance(followers, bool):
        lines.append(f"- 粉丝数：{_format_count(followers)}")
    metric_labels = (
        ("workCount", "作品数"),
        ("averageLikes", "平均点赞"),
        ("averageComments", "平均评论"),
        ("averageCollects", "平均收藏"),
        ("averageShares", "平均分享"),
        ("averageInteractions", "平均综合互动量"),
        ("maxInteractions", "最高综合互动量"),
        ("aboveAverageInteractionCount", "高于平均互动作品数"),
        ("top10InteractionShare", "Top 10 综合互动量占比"),
        ("maxToAverageMultiple", "最高值与平均值倍数"),
    )
    for key, label in metric_labels:
        lines.append(f"- {label}：{_format_metric(key, metrics.get(key))}")
    completeness = bundle.get("completeness", {})
    missing = completeness.get("missingFields", []) if isinstance(completeness, dict) else []
    warnings = completeness.get("warnings", []) if isinstance(completeness, dict) else []
    lines.append(f"- 缺失字段：{_safe_text('、'.join(map(str, missing)) if missing else '无')}")
    lines.append(f"- 数据警告：{_safe_text('；'.join(map(str, warnings)) if warnings else '无')}")
    return "\n".join(lines)


def _recommendations(batch: dict[str, object], bundle: EvidenceBundle) -> str:
    lines = ["### 选题方向"]
    for index, topic in enumerate(cast(list[dict[str, object]], batch["topicDirections"]), start=1):
        lines.append(
            f"{index}. **{_safe_text(topic.get('title'))}**：{_safe_text(topic.get('angle'))}"
        )
        lines.extend(_evidence_lines(topic.get("evidenceIds"), bundle))
        notes = cast(list[str], topic.get("complianceNotes", []))
        lines.append(f"   - 合规提示：{_safe_text('；'.join(notes))}")

    lines.append("\n### 拍法模板")
    for index, template in enumerate(cast(list[dict[str, object]], batch["filmingTemplates"]), start=1):
        structure = " → ".join(
            _safe_text(item) for item in cast(list[str], template.get("structure", []))
        )
        lines.append(
            f"{index}. **{_safe_text(template.get('name'))}**："
            f"开场 {_safe_text(template.get('hook'))}；结构 {structure}"
        )
        lines.extend(_evidence_lines(template.get("evidenceIds"), bundle))
        notes = cast(list[str], template.get("complianceNotes", []))
        lines.append(f"   - 合规提示：{_safe_text('；'.join(notes))}")

    lines.append("\n### 转化与承接")
    conversions = cast(list[dict[str, object]], batch["conversionItems"])
    if not conversions:
        lines.append("本批未提供转化与承接动作。")
    for item in conversions:
        lines.append(f"- {_safe_text(item.get('action'))}")
        lines.extend(_evidence_lines(item.get("evidenceIds"), bundle))
        notes = cast(list[str], item.get("complianceNotes", []))
        lines.append(f"  - 合规提示：{_safe_text('；'.join(notes))}")

    claims = cast(list[dict[str, object]], batch.get("claims", []))
    if claims:
        lines.append("\n### 转化假设")
        lines.append(_render_claims(claims, bundle))
    return "\n".join(lines)


def _execution_plan(batch: dict[str, object], bundle: EvidenceBundle) -> str:
    lines = []
    days = sorted(
        cast(list[dict[str, object]], batch["executionDays"]),
        key=lambda item: _integer(item.get("day")),
    )
    for item in days:
        lines.append(f"### 第 {_integer(item.get('day'))} 天")
        lines.append(f"- 动作：{_safe_text(item.get('action'))}")
        lines.extend(_evidence_lines(item.get("evidenceIds"), bundle))
        notes = cast(list[str], item.get("complianceNotes", []))
        lines.append(f"  - 合规提示：{_safe_text('；'.join(notes))}")
    return "\n".join(lines)


def assemble_report(
    bundle: EvidenceBundle,
    batches: list[dict[str, object]],
) -> str:
    """Assemble the fixed report using only validated model text and bundle numbers."""
    validated = [validate_section_batch(batch, bundle) for batch in batches]
    by_id = {str(batch["batchId"]): batch for batch in validated}
    strategy = by_id.get("strategy", validated[0] if validated else None)
    traffic = by_id.get("traffic", validated[1] if len(validated) > 1 else None)
    recommendation = by_id.get("recommendations")
    if strategy is None or traffic is None or recommendation is None:
        raise ValueError("required_report_batches_missing")

    strategy_parts = _partition(cast(list[dict[str, object]], strategy["claims"]), 3)
    traffic_parts = _partition(cast(list[dict[str, object]], traffic["claims"]), 2)
    account = bundle.get("account", {})
    nickname = _safe_text(account.get("nickname", "未命名账号"))

    sections = (
        (_SECTION_HEADINGS[0].format(nickname=nickname), ""),
        (_SECTION_HEADINGS[1], _account_overview(bundle)),
        (_SECTION_HEADINGS[2], _render_claims(strategy_parts[0], bundle)),
        (_SECTION_HEADINGS[3], _render_claims(strategy_parts[1], bundle)),
        (_SECTION_HEADINGS[4], _render_claims(strategy_parts[2], bundle)),
        (_SECTION_HEADINGS[5], _ranking_table(bundle, "overall")),
        (_SECTION_HEADINGS[6], _ranking_table(bundle, "startup")),
        (
            _SECTION_HEADINGS[7],
            "### 高收藏 Top 5\n"
            + _ranking_table(bundle, "collect")
            + "\n\n### 高分享 Top 5\n"
            + _ranking_table(bundle, "share")
            + "\n\n### 高评论 Top 5\n"
            + _ranking_table(bundle, "comment"),
        ),
        (_SECTION_HEADINGS[8], _render_claims(traffic_parts[0], bundle)),
        (_SECTION_HEADINGS[9], _render_claims(traffic_parts[1], bundle)),
        (_SECTION_HEADINGS[10], _recommendations(recommendation, bundle)),
        (_SECTION_HEADINGS[11], _execution_plan(recommendation, bundle)),
    )
    return "\n\n".join(
        heading if not body else f"{heading}\n\n{body}"
        for heading, body in sections
    ) + "\n"


def _allowed_numeric_tokens(bundle: EvidenceBundle) -> set[str]:
    allowed = {str(value) for value in range(1, 11)}

    def add(value: object) -> None:
        if isinstance(value, bool) or value is None:
            return
        if isinstance(value, int):
            allowed.update((str(value), f"{value:,}"))
        elif isinstance(value, float):
            allowed.update(
                (
                    str(value),
                    f"{value:,.2f}",
                    f"{value:.1%}",
                )
            )
        elif isinstance(value, str):
            allowed.update(_NUMERIC_TOKEN_PATTERN.findall(value))
        elif isinstance(value, dict):
            for nested in value.values():
                add(nested)
        elif isinstance(value, list):
            for nested in value:
                add(nested)

    add(bundle)
    return allowed


def validate_final_report(markdown: str, bundle: EvidenceBundle) -> list[str]:
    """Return stable final-report errors for structure, evidence, and numeric leaks."""
    errors: list[str] = []
    account = bundle.get("account", {})
    nickname = _safe_text(account.get("nickname", "未命名账号"))
    expected_headings = [
        heading.format(nickname=nickname) if "{nickname}" in heading else heading
        for heading in _SECTION_HEADINGS
    ]
    cursor = -1
    for heading in expected_headings:
        position = markdown.find(heading)
        if position < 0:
            label = heading.lstrip("# ")
            if label.startswith("抖音账号分析报告"):
                errors.append("missing_section:报告标题")
            else:
                errors.append(f"missing_section:{label}")
        elif position <= cursor:
            errors.append(f"section_out_of_order:{heading.lstrip('# ')}")
        else:
            cursor = position

    if markdown.count(_TABLE_HEADER) < 5:
        errors.append("missing_ranking_table")

    known_ids = set(_items_by_id(bundle))
    for evidence_id in sorted(set(_EVIDENCE_ID_PATTERN.findall(markdown))):
        if evidence_id not in known_ids:
            errors.append(f"unknown_evidence_id:{evidence_id}")

    allowed_numbers = _allowed_numeric_tokens(bundle)
    for token in _NUMERIC_TOKEN_PATTERN.findall(markdown):
        if token not in allowed_numbers:
            error = f"untrusted_numeric_claim:{token}"
            if error not in errors:
                errors.append(error)
    for phrase in medical_compliance_violations(markdown):
        errors.append(f"medical_compliance_violation:{phrase}")
    return errors
