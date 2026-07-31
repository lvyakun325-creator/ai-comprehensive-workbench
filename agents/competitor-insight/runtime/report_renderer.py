"""Render evidence-backed competitor reports without trusting model numbers."""

from __future__ import annotations

import html
import re
from typing import cast

from contracts import EvidenceBundle
from section_validator import (
    STRENGTH_LABELS,
    medical_compliance_violations,
    untrusted_numeric_claims,
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
_EVIDENCE_LINE_PATTERN = re.compile(
    r"^  - 证据 `(?P<evidence_id>DY-E\d{4,})`："
)
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


def _claims_for_section(
    batch: dict[str, object],
    section: str,
) -> list[dict[str, object]]:
    return [
        claim
        for claim in cast(list[dict[str, object]], batch["claims"])
        if claim.get("section") == section
    ]


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


def _special_rankings(bundle: EvidenceBundle) -> str:
    return (
        "### 高收藏 Top 5\n"
        + _ranking_table(bundle, "collect")
        + "\n\n### 高分享 Top 5\n"
        + _ranking_table(bundle, "share")
        + "\n\n### 高评论 Top 5\n"
        + _ranking_table(bundle, "comment")
    )


def _validated_batch_map(
    bundle: EvidenceBundle,
    batches: list[dict[str, object]],
) -> dict[str, dict[str, object]]:
    validated = [validate_section_batch(batch, bundle) for batch in batches]
    by_id: dict[str, dict[str, object]] = {}
    for batch in validated:
        batch_id = str(batch["batchId"])
        if batch_id in by_id:
            raise ValueError(f"duplicate_batch_id:{batch_id}")
        by_id[batch_id] = batch
    for batch_id in ("strategy", "performance", "execution"):
        if batch_id not in by_id:
            raise ValueError(f"missing_batch_id:{batch_id}")
    if len(by_id) != 3:
        raise ValueError("unexpected_report_batch_count")
    return by_id


def _expected_evidence_lines(
    bundle: EvidenceBundle,
    by_id: dict[str, dict[str, object]],
) -> list[str]:
    evidence_ids: list[str] = []

    def append_from(items: list[dict[str, object]]) -> None:
        for item in items:
            evidence_ids.extend(cast(list[str], item["evidenceIds"]))

    strategy = by_id["strategy"]
    performance = by_id["performance"]
    execution = by_id["execution"]
    for section in ("strategy", "business", "content"):
        append_from(_claims_for_section(strategy, section))
    for section in ("traffic", "data"):
        append_from(_claims_for_section(performance, section))
    append_from(cast(list[dict[str, object]], execution["topicDirections"]))
    append_from(cast(list[dict[str, object]], execution["filmingTemplates"]))
    append_from(cast(list[dict[str, object]], execution["conversionItems"]))
    append_from(
        sorted(
            cast(list[dict[str, object]], execution["executionDays"]),
            key=lambda item: _integer(item.get("day")),
        )
    )
    return [
        f"  - {render_evidence_reference(evidence_id, bundle)}"
        for evidence_id in evidence_ids
    ]


def assemble_report(
    bundle: EvidenceBundle,
    batches: list[dict[str, object]],
) -> str:
    """Assemble the fixed report using only validated model text and bundle numbers."""
    by_id = _validated_batch_map(bundle, batches)

    strategy = by_id["strategy"]
    performance = by_id["performance"]
    execution = by_id["execution"]
    account = bundle.get("account", {})
    nickname = _safe_text(account.get("nickname", "未命名账号"))

    sections = (
        (_SECTION_HEADINGS[0].format(nickname=nickname), ""),
        (_SECTION_HEADINGS[1], _account_overview(bundle)),
        (
            _SECTION_HEADINGS[2],
            _render_claims(_claims_for_section(strategy, "strategy"), bundle),
        ),
        (
            _SECTION_HEADINGS[3],
            _render_claims(_claims_for_section(strategy, "business"), bundle),
        ),
        (
            _SECTION_HEADINGS[4],
            _render_claims(_claims_for_section(strategy, "content"), bundle),
        ),
        (_SECTION_HEADINGS[5], _ranking_table(bundle, "overall")),
        (_SECTION_HEADINGS[6], _ranking_table(bundle, "startup")),
        (_SECTION_HEADINGS[7], _special_rankings(bundle)),
        (
            _SECTION_HEADINGS[8],
            _render_claims(_claims_for_section(performance, "traffic"), bundle),
        ),
        (
            _SECTION_HEADINGS[9],
            _render_claims(_claims_for_section(performance, "data"), bundle),
        ),
        (_SECTION_HEADINGS[10], _recommendations(execution, bundle)),
        (_SECTION_HEADINGS[11], _execution_plan(execution, bundle)),
    )
    return "\n\n".join(
        heading if not body else f"{heading}\n\n{body}"
        for heading, body in sections
    ) + "\n"


def _active_lines(markdown: str) -> tuple[list[str], set[int], bool]:
    lines = markdown.splitlines()
    active: set[int] = set()
    in_fence = False
    found_fence = False
    fence_marker = ""
    for index, line in enumerate(lines):
        stripped = line.strip()
        if not in_fence and (stripped.startswith("```") or stripped.startswith("~~~")):
            in_fence = True
            found_fence = True
            fence_marker = stripped[:3]
            continue
        if in_fence and stripped.startswith(fence_marker):
            in_fence = False
            continue
        if not in_fence:
            active.add(index)
    return lines, active, found_fence


def _section_body(lines: list[str], start: int, end: int) -> str:
    return "\n".join(lines[start + 1 : end]).strip()


def _append_once(errors: list[str], error: str) -> None:
    if error not in errors:
        errors.append(error)


def validate_final_report(
    markdown: str,
    bundle: EvidenceBundle,
    batches: list[dict[str, object]],
) -> list[str]:
    """Return stable final-report errors for structure, evidence, and numeric leaks."""
    errors: list[str] = []
    by_id = _validated_batch_map(bundle, batches)
    lines, active, found_fence = _active_lines(markdown)
    if found_fence:
        errors.append("forbidden_code_fence")
    account = bundle.get("account", {})
    nickname = _safe_text(account.get("nickname", "未命名账号"))
    expected_headings = [
        heading.format(nickname=nickname) if "{nickname}" in heading else heading
        for heading in _SECTION_HEADINGS
    ]
    heading_positions: dict[str, list[int]] = {
        heading: [
            index
            for index, line in enumerate(lines)
            if index in active and line == heading
        ]
        for heading in expected_headings
    }
    for heading in expected_headings:
        positions = heading_positions[heading]
        if not positions:
            label = heading.lstrip("# ")
            if label.startswith("抖音账号分析报告"):
                errors.append("missing_section:报告标题")
            else:
                errors.append(f"missing_section:{label}")
        elif len(positions) > 1:
            errors.append(f"duplicate_section:{heading.lstrip('# ')}")

    present_positions = [
        heading_positions[heading][0]
        for heading in expected_headings
        if heading_positions[heading]
    ]
    if present_positions != sorted(present_positions):
        errors.append("section_out_of_order")

    expected_heading_set = set(expected_headings)
    for index in sorted(active):
        line = lines[index]
        if (line.startswith("# ") or line.startswith("## ")) and line not in expected_heading_set:
            _append_once(errors, f"unexpected_heading:{line.lstrip('# ')}")

    subsection_headings = (
        "### 选题方向",
        "### 拍法模板",
        "### 转化与承接",
    )
    subsection_positions = {
        heading: [
            index
            for index, line in enumerate(lines)
            if index in active and line == heading
        ]
        for heading in subsection_headings
    }
    recommendation_start = (
        heading_positions[expected_headings[10]][0]
        if len(heading_positions[expected_headings[10]]) == 1
        else None
    )
    execution_start = (
        heading_positions[expected_headings[11]][0]
        if len(heading_positions[expected_headings[11]]) == 1
        else None
    )
    for heading in subsection_headings:
        label = heading.lstrip("# ")
        positions = subsection_positions[heading]
        if not positions:
            errors.append(f"missing_subsection:{label}")
        elif len(positions) > 1:
            errors.append(f"duplicate_subsection:{label}")
        if (
            recommendation_start is not None
            and execution_start is not None
            and any(
                not recommendation_start < position < execution_start
                for position in positions
            )
        ):
            _append_once(errors, f"subsection_outside_section:{label}")
    subsection_first_positions = [
        subsection_positions[heading][0]
        for heading in subsection_headings
        if subsection_positions[heading]
    ]
    if subsection_first_positions != sorted(subsection_first_positions):
        errors.append("subsection_out_of_order:对标建议")

    day_positions: dict[int, list[int]] = {
        day: [
            index
            for index, line in enumerate(lines)
            if index in active and line == f"### 第 {day} 天"
        ]
        for day in range(1, 8)
    }
    for day, positions in day_positions.items():
        if not positions:
            errors.append(f"missing_execution_day:{day}")
        elif len(positions) > 1:
            errors.append(f"duplicate_execution_day:{day}")
        if (
            execution_start is not None
            and any(position <= execution_start for position in positions)
        ):
            _append_once(errors, f"execution_day_outside_section:{day}")
    day_first_positions = [
        day_positions[day][0]
        for day in range(1, 8)
        if day_positions[day]
    ]
    if day_first_positions != sorted(day_first_positions):
        errors.append("execution_days_out_of_order")

    deterministic_bodies = {
        1: _account_overview(bundle),
        5: _ranking_table(bundle, "overall"),
        6: _ranking_table(bundle, "startup"),
        7: _special_rankings(bundle),
    }
    deterministic_lines: set[int] = set()
    for heading_index, expected_body in deterministic_bodies.items():
        heading = expected_headings[heading_index]
        next_heading = expected_headings[heading_index + 1]
        if len(heading_positions[heading]) != 1 or len(heading_positions[next_heading]) != 1:
            continue
        start = heading_positions[heading][0]
        end = heading_positions[next_heading][0]
        deterministic_lines.update(range(start, end))
        if _section_body(lines, start, end) != expected_body:
            errors.append(
                f"deterministic_block_mismatch:{heading.lstrip('# ')}"
            )

    known_ids = set(_items_by_id(bundle))
    evidence_lines: set[int] = set()
    actual_evidence_lines: list[str] = []
    for index in sorted(active):
        match = _EVIDENCE_LINE_PATTERN.match(lines[index])
        if match is None:
            continue
        evidence_lines.add(index)
        actual_evidence_lines.append(lines[index])
        evidence_id = match.group("evidence_id")
        if evidence_id not in known_ids:
            _append_once(errors, f"unknown_evidence_id:{evidence_id}")
            continue
        expected_line = f"  - {render_evidence_reference(evidence_id, bundle)}"
        if lines[index] != expected_line:
            _append_once(errors, f"evidence_reference_mismatch:{evidence_id}")
    if actual_evidence_lines != _expected_evidence_lines(bundle, by_id):
        errors.append("evidence_reference_sequence_mismatch")

    heading_line_indexes = {
        position
        for positions in heading_positions.values()
        for position in positions
    }
    execution_heading = re.compile(r"^### 第 [1-7] 天$")
    topic_position = subsection_positions["### 选题方向"]
    filming_position = subsection_positions["### 拍法模板"]
    conversion_position = subsection_positions["### 转化与承接"]
    for index in sorted(active):
        if (
            index in deterministic_lines
            or index in heading_line_indexes
            or index in evidence_lines
            or execution_heading.fullmatch(lines[index])
        ):
            continue
        model_line = lines[index]
        if (
            len(topic_position) == 1
            and len(filming_position) == 1
            and topic_position[0] < index < filming_position[0]
        ):
            model_line = re.sub(r"^[1-5]\. (?=\*\*)", "", model_line, count=1)
        elif (
            len(filming_position) == 1
            and len(conversion_position) == 1
            and filming_position[0] < index < conversion_position[0]
        ):
            model_line = re.sub(r"^[1-3]\. (?=\*\*)", "", model_line, count=1)
        for claim in untrusted_numeric_claims(model_line):
            _append_once(errors, f"untrusted_numeric_claim:{claim}")
        for phrase in medical_compliance_violations(model_line):
            _append_once(errors, f"medical_compliance_violation:{phrase}")
    return errors
