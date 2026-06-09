import math
from typing import Optional
from rulebook import BLOODLUST_SPELL_IDS, BLOODLUST_DURATION_S, SPEC_COOLDOWNS


def _fmt(seconds: float) -> str:
    m = int(seconds) // 60
    s = int(seconds) % 60
    return f"{m:02d}:{s:02d}"


def _evaluate_rules(
    rules: list[dict],
    completed_casts: list[dict],
    fight_start: float,
    fight_duration_s: float,
) -> list[dict]:
    """Evaluate machine-readable condition objects from rules[] against the cast timeline."""
    findings = []

    def t_s(ts: float) -> float:
        return (ts - fight_start) / 1000

    cast_times: dict[int, list[float]] = {}
    for c in completed_casts:
        if c.get("type") == "cast":
            sid = c.get("abilityGameID")
            if sid:
                cast_times.setdefault(sid, []).append(t_s(c["timestamp"]))

    for rule in rules:
        cond = rule.get("condition")
        if not cond:
            continue

        kind = cond.get("kind")
        priority = rule.get("priority", "medium")
        severity = "critical" if priority == "critical" else "warning"
        action = rule.get("action", "")

        if kind == "cast_without_prior":
            # Flag each cast of spell_id that has no paired required_spell_id within window_s.
            # Optional exception: skip if context_spell_id was cast within context_window_s before.
            sid = cond["spell_id"]
            req_sid = cond["required_spell_id"]
            spell_name = cond.get("spell_name", str(sid))
            req_name = cond.get("required_spell_name", str(req_sid))
            window = cond.get("window_s", 5)
            exception = cond.get("exception")

            primary = sorted(cast_times.get(sid, []))
            required = cast_times.get(req_sid, [])

            violations: list[float] = []
            for cast_t in primary:
                paired = any(abs(cast_t - rt) <= window for rt in required)
                if not paired:
                    if exception:
                        ctx_sid = exception["context_spell_id"]
                        ctx_window = exception.get("context_window_s", 20)
                        pos = exception.get("position", "before")
                        ctx_casts = cast_times.get(ctx_sid, [])
                        if pos == "before":
                            exempted = any(0 <= cast_t - ct <= ctx_window for ct in ctx_casts)
                        else:
                            exempted = any(0 <= ct - cast_t <= ctx_window for ct in ctx_casts)
                        # Also exempt if context spell is cast within look_ahead_s AFTER this cast
                        # (player is holding the required spell for an upcoming anchor window)
                        look_ahead = exception.get("also_look_ahead_s")
                        if look_ahead and not exempted:
                            exempted = any(0 < ct - cast_t <= look_ahead for ct in ctx_casts)
                        if exempted:
                            continue
                    violations.append(cast_t)

            if violations:
                findings.append({
                    "severity": severity,
                    "category": "rule_violation",
                    "timestamp_ms": int(violations[0] * 1000),
                    "message": (
                        f"{spell_name} without {req_name}: "
                        f"{len(violations)} of {len(primary)} cast(s) lacked "
                        f"a paired {req_name} within {window}s. "
                        f"Unpaired {spell_name} windows waste the burst amplification."
                    ),
                    "details": {"remedy": action} if action else None,
                })

        elif kind == "hold_cooldown_for_anchor":
            # Flag casts of spell_ids within hold_window_s before each non-opener anchor cast.
            spell_ids = cond.get("spell_ids", [])
            spell_names = cond.get("spell_names", [str(s) for s in spell_ids])
            anchor_sid = cond["anchor_spell_id"]
            anchor_name = cond.get("anchor_spell_name", str(anchor_sid))
            hold_window = cond.get("hold_window_s", 15)

            anchor_times = sorted(cast_times.get(anchor_sid, []))

            violations: list[tuple] = []
            first_violation_t: Optional[float] = None
            for anchor_t in anchor_times[1:]:  # skip opener cast
                for i, sid in enumerate(spell_ids):
                    sname = spell_names[i] if i < len(spell_names) else str(sid)
                    for ct in sorted(cast_times.get(sid, [])):
                        if anchor_t - hold_window <= ct < anchor_t:
                            violations.append((sname, _fmt(ct), _fmt(anchor_t)))
                            if first_violation_t is None:
                                first_violation_t = ct

            if violations:
                spell_list = " / ".join(sorted({v[0] for v in violations}))
                findings.append({
                    "severity": severity,
                    "category": "rule_violation",
                    "timestamp_ms": int(first_violation_t * 1000) if first_violation_t else None,
                    "message": (
                        f"{spell_list} spent in the {hold_window}s hold window before {anchor_name}: "
                        f"{len(violations)} charge(s) used just before the burst window, "
                        f"reducing {anchor_name}-amplified damage."
                    ),
                    "details": {"remedy": action} if action else None,
                })

    return findings


def analyze_player(
    player: dict,
    fight_start: float,
    fight_end: float,
    cast_events: list[dict],
    buff_events: list[dict],
    spec_cds_override: Optional[list[dict]] = None,
    rules_override: Optional[list[dict]] = None,
) -> dict:
    spec = player.get("subType", "Unknown")
    fight_duration_ms = fight_end - fight_start
    fight_duration_s = fight_duration_ms / 1000

    def rel(ts: float) -> float:
        return ts - fight_start

    completed_casts = [
        e for e in cast_events
        if e.get("type") == "cast" and fight_start <= e["timestamp"] <= fight_end
    ]
    completed_casts.sort(key=lambda e: e["timestamp"])

    findings: list[dict] = []

    # ── Bloodlust detection ───────────────────────────────────────────────────
    bl_time_s: float | None = None
    for e in buff_events:
        if (
            e.get("type") == "applybuff"
            and e.get("abilityGameID") in BLOODLUST_SPELL_IDS
            and fight_start <= e["timestamp"] <= fight_end
        ):
            bl_time_s = rel(e["timestamp"]) / 1000
            break

    # ── Spec cooldown analysis ────────────────────────────────────────────────
    spec_cds = spec_cds_override if spec_cds_override is not None else SPEC_COOLDOWNS.get(spec)

    if spec_cds is None:
        findings.append({
            "severity": "info",
            "category": "unsupported_spec",
            "timestamp_ms": None,
            "message": (
                f"{spec} is not yet in the rulebook — cooldown rules will be added soon. "
                "Cast efficiency analysis still applies."
            ),
        })
    else:
        for cd in spec_cds:
            spell_id = cd["spell_id"]
            cd_name = cd["name"]
            cooldown_s = cd["cooldown"]
            wants_bl = cd.get("align_with_bloodlust", True)

            cd_casts = [
                c for c in completed_casts if c.get("abilityGameID") == spell_id
            ]
            actual_uses = len(cd_casts)
            expected_uses = 1 + math.floor(fight_duration_s / cooldown_s)

            cd_issues: list[dict] = []

            # Lost casts
            if actual_uses == 0:
                cd_issues.append({
                    "severity": "critical",
                    "category": "lost_cooldown",
                    "timestamp_ms": None,
                    "message": (
                        f"{cd_name} was never used. "
                        f"In a {_fmt(fight_duration_s)} fight with a {cooldown_s}s cooldown "
                        f"you should have {expected_uses} cast(s). "
                        f"Use it at pull and on cooldown every {cooldown_s}s."
                    ),
                })
            elif actual_uses < expected_uses:
                lost = expected_uses - actual_uses
                pct = round(lost / expected_uses * 100)
                cd_issues.append({
                    "severity": "critical",
                    "category": "lost_cooldown",
                    "timestamp_ms": None,
                    "message": (
                        f"{cd_name} — {actual_uses} of {expected_uses} expected casts. "
                        f"Lost {lost} use(s) in a {_fmt(fight_duration_s)} fight "
                        f"({cooldown_s}s cooldown) — roughly {pct}% of this CD's potential."
                    ),
                })

            # First-cast delay
            if cd_casts:
                first_s = rel(cd_casts[0]["timestamp"]) / 1000
                if first_s > 30:
                    cd_issues.append({
                        "severity": "warning",
                        "category": "cooldown_delay",
                        "timestamp_ms": int(rel(cd_casts[0]["timestamp"])),
                        "message": (
                            f"{cd_name} first cast at {_fmt(first_s)} ({first_s:.0f}s into the fight). "
                            f"A late opener on a {cooldown_s}s cooldown risks losing a full use later."
                        ),
                    })

            # Bloodlust alignment
            bl_aligned = False
            if bl_time_s is not None and cd_casts:
                bl_window_start_s = bl_time_s - 30
                bl_window_end_s = bl_time_s + BLOODLUST_DURATION_S + 15
                bl_aligned = any(
                    bl_window_start_s <= rel(c["timestamp"]) / 1000 <= bl_window_end_s
                    for c in cd_casts
                )
                if not bl_aligned and wants_bl:
                    first_cast_s = rel(cd_casts[0]["timestamp"]) / 1000
                    delta = abs(first_cast_s - bl_time_s)
                    cd_issues.append({
                        "severity": "critical",
                        "category": "cooldown_alignment",
                        "timestamp_ms": int(rel(cd_casts[0]["timestamp"])),
                        "message": (
                            f"{cd_name} missed Bloodlust (BL at {_fmt(bl_time_s)}, "
                            f"first cast at {_fmt(first_cast_s)} — {delta:.0f}s apart). "
                            f"Stacking all major CDs inside BL multiplies their value by ~30%."
                        ),
                    })

            # Gaps between consecutive CD casts
            for i in range(1, len(cd_casts)):
                prev_s = rel(cd_casts[i - 1]["timestamp"]) / 1000
                curr_s = rel(cd_casts[i]["timestamp"]) / 1000
                actual_gap = curr_s - prev_s
                if actual_gap > cooldown_s * 1.2:
                    delay = actual_gap - cooldown_s
                    cd_issues.append({
                        "severity": "warning",
                        "category": "cooldown_delay",
                        "timestamp_ms": int(rel(cd_casts[i]["timestamp"])),
                        "message": (
                            f"{cd_name} held {delay:.0f}s past reset at {_fmt(curr_s)} "
                            f"({actual_gap:.0f}s gap vs {cooldown_s}s cooldown). "
                            f"Each second held past reset is direct throughput loss."
                        ),
                    })

            if cd_issues:
                findings.extend(cd_issues)
            elif actual_uses > 0:
                if actual_uses <= expected_uses:
                    uses_str = f"{actual_uses}/{expected_uses} casts on cooldown"
                else:
                    uses_str = f"{actual_uses} casts"
                parts = [uses_str]
                if bl_time_s is not None and wants_bl:
                    parts.append("BL-aligned" if bl_aligned else "note: no BL overlap")
                findings.append({
                    "severity": "success",
                    "category": "cooldown_usage",
                    "timestamp_ms": None,
                    "message": f"{cd_name} — {', '.join(parts)}.",
                })

    # ── Rule engine ───────────────────────────────────────────────────────────
    if rules_override:
        rule_findings = _evaluate_rules(
            rules_override, completed_casts, fight_start, fight_duration_s
        )
        findings.extend(rule_findings)

    # ── Cast efficiency ───────────────────────────────────────────────────────
    if len(completed_casts) >= 2:
        gaps: list[dict] = []
        for i in range(1, len(completed_casts)):
            gap_ms = rel(completed_casts[i]["timestamp"]) - rel(completed_casts[i - 1]["timestamp"])
            if gap_ms > 1500:
                gaps.append({
                    "start_ms": int(rel(completed_casts[i - 1]["timestamp"])),
                    "duration_ms": int(gap_ms),
                })

        total_downtime_s = sum(g["duration_ms"] for g in gaps) / 1000
        efficiency_pct = max(0.0, (1 - total_downtime_s / fight_duration_s) * 100)

        if total_downtime_s > 5:
            severity = "critical" if efficiency_pct < 88 else "warning"
            worst = sorted(gaps, key=lambda g: -g["duration_ms"])[:3]
            worst_str = ", ".join(
                f"{_fmt(g['start_ms']/1000)} ({g['duration_ms']/1000:.1f}s gap)" for g in worst
            )
            findings.append({
                "severity": severity,
                "category": "cast_efficiency",
                "timestamp_ms": None,
                "message": (
                    f"Cast efficiency: {efficiency_pct:.1f}% — "
                    f"{len(gaps)} gaps >1.5s totalling {total_downtime_s:.1f}s of downtime. "
                    f"Elite target is 95%+. "
                    f"Worst gaps: {worst_str}."
                ),
                "details": {
                    "efficiency_pct": round(efficiency_pct, 1),
                    "total_downtime_s": round(total_downtime_s, 1),
                    "gap_count": len(gaps),
                },
            })

    # Sort: critical → warning → info → success
    order = {"critical": 0, "warning": 1, "info": 2, "success": 3}
    findings.sort(key=lambda f: order.get(f["severity"], 4))

    return {
        "player": player["name"],
        "spec": spec,
        "fight_duration_s": round(fight_duration_s, 1),
        "bloodlust_time": _fmt(bl_time_s) if bl_time_s is not None else None,
        "total_casts": len(completed_casts),
        "findings": findings,
    }
