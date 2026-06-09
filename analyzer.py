import math
from typing import Optional
from rulebook import BLOODLUST_SPELL_IDS, BLOODLUST_DURATION_S, SPEC_COOLDOWNS


def _fmt(seconds: float) -> str:
    m = int(seconds) // 60
    s = int(seconds) % 60
    return f"{m:02d}:{s:02d}"


def analyze_player(
    player: dict,
    fight_start: float,
    fight_end: float,
    cast_events: list[dict],
    buff_events: list[dict],
    spec_cds_override: Optional[list[dict]] = None,
) -> dict:
    spec = player.get("subType", "Unknown")
    fight_duration_ms = fight_end - fight_start
    fight_duration_s = fight_duration_ms / 1000

    # Normalise timestamps to fight-relative milliseconds
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
                        f"{cd_name} was never cast. You should have used it "
                        f"{expected_uses}x in a {_fmt(fight_duration_s)} fight "
                        f"(every {cooldown_s}s)."
                    ),
                })
            elif actual_uses < expected_uses:
                lost = expected_uses - actual_uses
                cd_issues.append({
                    "severity": "critical",
                    "category": "lost_cooldown",
                    "timestamp_ms": None,
                    "message": (
                        f"You lost {lost} cast(s) of {cd_name}. "
                        f"In a {_fmt(fight_duration_s)} fight with a {cooldown_s}s cooldown "
                        f"you should use it {expected_uses}x, but only used it {actual_uses}x."
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
                            "Casting it earlier lets you fit in more total uses."
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
                    cd_issues.append({
                        "severity": "critical",
                        "category": "cooldown_alignment",
                        "timestamp_ms": int(rel(cd_casts[0]["timestamp"])),
                        "message": (
                            f"{cd_name} was not cast during Bloodlust ({_fmt(bl_time_s)}). "
                            f"Your first cast was at {_fmt(first_cast_s)}. "
                            "Stack major cooldowns with Bloodlust to maximise burst damage."
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
                            f"{cd_name} cast at {_fmt(curr_s)} was {delay:.0f}s late "
                            f"(gap: {actual_gap:.0f}s, cooldown: {cooldown_s}s). "
                            "Holding cooldowns unnecessarily loses damage."
                        ),
                    })

            if cd_issues:
                findings.extend(cd_issues)
            elif actual_uses > 0:
                parts = [f"{actual_uses}/{expected_uses} casts on cooldown"]
                if bl_time_s is not None and wants_bl:
                    parts.append("BL-aligned" if bl_aligned else "note: no BL overlap")
                findings.append({
                    "severity": "success",
                    "category": "cooldown_usage",
                    "timestamp_ms": None,
                    "message": f"{cd_name} — {', '.join(parts)}.",
                })

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
                    f"Top players sustain 95%+. "
                    f"Worst gaps: {worst_str}."
                ),
                "details": {
                    "efficiency_pct": round(efficiency_pct, 1),
                    "total_downtime_s": round(total_downtime_s, 1),
                    "gap_count": len(gaps),
                },
            })

    # Sort: critical → warning → info
    order = {"critical": 0, "warning": 1, "info": 2}
    findings.sort(key=lambda f: order.get(f["severity"], 3))

    return {
        "player": player["name"],
        "spec": spec,
        "fight_duration_s": round(fight_duration_s, 1),
        "bloodlust_time": _fmt(bl_time_s) if bl_time_s is not None else None,
        "total_casts": len(completed_casts),
        "findings": findings,
    }
