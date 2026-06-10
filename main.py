import json
import re
import statistics
from collections import Counter, defaultdict
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import db
from analyzer import analyze_player
from parses_analyzer import get_encounters, fetch_top_rankings, analyze_parse, SPEC_TO_WCL
from rulebook import BLOODLUST_SPELL_IDS
from scraper import scrape
from wcl_client import WCLClient

app = FastAPI(title="WoW Progression Analyzer")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

wcl = WCLClient()
STATIC_DIR   = Path(__file__).parent / "static"
PROMPTS_DIR  = Path(__file__).parent / "prompts"


@app.on_event("startup")
async def startup():
    await db.init_db()


# ── Utilities ─────────────────────────────────────────────────────────────────

def _extract_code(url_or_code: str) -> str:
    m = re.search(r"/reports/([a-zA-Z0-9]+)", url_or_code)
    return m.group(1) if m else url_or_code.strip()


def _build_spec_map(report: dict) -> dict[int, str]:
    """Build {actor_id: 'SubtletyRogue'} from playerDetails.
    WCL changed actor.subType to class-only in Midnight; playerDetails still has full spec info.
    Response shape: playerDetails → JSON string → {data: {playerDetails: {dps/healers/tanks: [...]}}}"""
    spec_map: dict[int, str] = {}
    raw = report.get("playerDetails")
    if not raw:
        return spec_map
    outer = json.loads(raw) if isinstance(raw, str) else raw
    # Unwrap the nested data.playerDetails layer
    details = (outer.get("data") or {}).get("playerDetails") or outer
    for role in ("dps", "healers", "tanks", "unknown"):
        for p in (details.get(role) or []):
            specs = p.get("specs") or []
            cls = (p.get("type") or "").replace(" ", "")
            if specs and cls:
                spec_name = (specs[0].get("spec") or "").replace(" ", "")
                if spec_name:
                    spec_map[p["id"]] = spec_name + cls
    return spec_map


# ── Frontend ──────────────────────────────────────────────────────────────────

@app.get("/", include_in_schema=False)
async def frontend():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/admin", include_in_schema=False)
async def admin_frontend():
    return FileResponse(STATIC_DIR / "admin.html")


@app.get("/pre", include_in_schema=False)
async def pre_frontend():
    return FileResponse(STATIC_DIR / "pre.html")


@app.get("/live", include_in_schema=False)
async def live_frontend():
    return FileResponse(STATIC_DIR / "live.html")


# ── Player analysis API ───────────────────────────────────────────────────────

@app.get("/api/debug/report/{code}/fight/{fight_id}")
async def debug_report(code: str, fight_id: int):
    """Return actor list + resolved spec map for a specific fight."""
    data = await wcl.get_report(_extract_code(code))
    report = data["reportData"]["report"]
    pd_data = await wcl.get_player_details(_extract_code(code), fight_id)
    spec_map = _build_spec_map(pd_data["reportData"]["report"])
    return {
        "actors": report["masterData"]["actors"],
        "spec_map": spec_map,
    }


@app.get("/api/report/{code}")
async def get_report(code: str):
    try:
        data = await wcl.get_report(_extract_code(code))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    report = data["reportData"]["report"]
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    # Add per-boss attempt numbering (chronological within each boss)
    boss_attempt: dict[int, int] = {}
    raw_fights = sorted(
        [f for f in report["fights"] if (f.get("encounterID") or 0) > 0],
        key=lambda x: x["startTime"],
    )
    fights = []
    for f in raw_fights:
        enc_id = f.get("encounterID") or 0
        boss_attempt[enc_id] = boss_attempt.get(enc_id, 0) + 1
        fights.append({
            "id": f["id"],
            "name": f["name"],
            "startTime": f["startTime"],
            "endTime": f["endTime"],
            "kill": f.get("kill"),
            "duration_s": round((f["endTime"] - f["startTime"]) / 1000, 1),
            "encounterID": enc_id,
            "attempt": boss_attempt[enc_id],
            "friendlyPlayers": f.get("friendlyPlayers") or [],
        })

    spec_map = _build_spec_map(report)
    all_actors = {
        a["id"]: {
            "id": a["id"],
            "name": a["name"],
            "spec": spec_map.get(a["id"]) or a.get("subType") or "Unknown",
            "server": a.get("server") or "",
        }
        for a in report["masterData"]["actors"]
    }
    players = sorted(all_actors.values(), key=lambda x: x["name"])
    return {"title": report.get("title", code), "fights": fights, "players": players}


class AnalyzeRequest(BaseModel):
    report_url: str
    fight_id: int
    player_id: int


@app.post("/api/analyze")
async def analyze(req: AnalyzeRequest):
    code = _extract_code(req.report_url)

    try:
        report_data = await wcl.get_report(code)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    report = report_data["reportData"]["report"]
    fight = next((f for f in report["fights"] if f["id"] == req.fight_id), None)
    if not fight:
        raise HTTPException(status_code=404, detail="Fight not found")

    player = next(
        (a for a in report["masterData"]["actors"] if a["id"] == req.player_id), None
    )
    if not player:
        raise HTTPException(status_code=404, detail="Player not found")

    start, end = fight["startTime"], fight["endTime"]
    try:
        cast_events = await wcl.get_all_events(code, req.fight_id, "Casts", start, end, source_id=req.player_id)
        buff_events = await wcl.get_all_events(code, req.fight_id, "Buffs", start, end, target_id=req.player_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Event fetch failed: {exc}")

    # playerDetails gives proper spec+class (WCL changed subType to class-only in Midnight)
    try:
        pd_data = await wcl.get_player_details(code, req.fight_id)
        spec_map = _build_spec_map(pd_data["reportData"]["report"])
    except Exception:
        spec_map = {}
    spec = spec_map.get(req.player_id) or player.get("subType", "Unknown")
    spec_cds = db.get_spec_cooldowns(spec)
    cached_rb = db.get_cached_rulebook(spec)
    spec_rules = (cached_rb or {}).get("rules", []) if cached_rb else []
    rulebook_source = "generated" if cached_rb else ("static" if spec_cds else "none")

    # Pre-fetch parse samples; compute benchmarks before calling the analyzer
    encounter_id = fight.get("encounterID")
    player_fight_dur_s = (end - start) / 1000
    samples = []
    top_avg_efficiency: Optional[float] = None
    top_efficiency_stddev: Optional[float] = None
    per_cd_benchmarks: dict = {}
    agg: dict[str, list] = {}
    consistent_bw: list = []
    downtime_threshold_ms: float = 1500.0  # fallback when no parse data available

    if encounter_id:
        samples = await db.get_parse_samples(spec, encounter_id)
        if samples:
            # Aggregate per-CD data across all parse samples
            agg = defaultdict(list)
            for s in samples:
                cd_data = s.get("cooldown_data") or {}
                fight_dur = cd_data.get("fight_duration_s", 0)
                for cd in cd_data.get("cooldowns", []):
                    agg[cd["name"]].append({**cd, "fight_duration_s": fight_dur})

            # Derive downtime threshold from the p90 of all top-parse inter-cast gaps.
            # A gap that top parsers commonly produce is their natural rotation — not downtime.
            all_top_gaps_ms: list[int] = []
            for s in samples:
                all_top_gaps_ms.extend((s.get("cooldown_data") or {}).get("cast_gap_list_ms") or [])
            if all_top_gaps_ms:
                all_top_gaps_ms.sort()
                p90_idx = max(0, int(0.90 * len(all_top_gaps_ms)) - 1)
                downtime_threshold_ms = float(all_top_gaps_ms[p90_idx])

            # Recompute top-parse efficiency at the derived threshold for a consistent baseline.
            # Falls back to the stored 1500ms value for old samples that lack cast_gap_list_ms.
            eff_vals: list[float] = []
            for s in samples:
                cd_data = s.get("cooldown_data") or {}
                gap_list = cd_data.get("cast_gap_list_ms") or []
                dur_s = cd_data.get("fight_duration_s") or 0
                if gap_list and dur_s > 0:
                    dt_s = sum(g for g in gap_list if g > downtime_threshold_ms) / 1000
                    eff_vals.append(round(max(0.0, (1 - dt_s / dur_s) * 100), 1))
            if not eff_vals:
                eff_vals = [
                    (s.get("cooldown_data") or {}).get("cast_efficiency_pct")
                    for s in samples
                ]
                eff_vals = [v for v in eff_vals if v is not None]
            if eff_vals:
                top_avg_efficiency = round(statistics.mean(eff_vals), 1)
                if len(eff_vals) > 1:
                    top_efficiency_stddev = round(statistics.stdev(eff_vals), 1)

            # Per-CD benchmark stats for data-driven thresholds
            for cd_name, entries in agg.items():
                top_first_casts = [e["first_cast_s"] for e in entries if e.get("first_cast_s") is not None]
                all_gaps: list[float] = []
                for e in entries:
                    times = e.get("cast_times_s", [])
                    for j in range(1, len(times)):
                        all_gaps.append(times[j] - times[j - 1])
                bl_offsets = [e["bl_offset_s"] for e in entries if e.get("bl_offset_s") is not None]

                # Hold targets — cast indices where top parsers consistently delay past on-cooldown time
                hold_by_cast_idx: dict[int, list[float]] = defaultdict(list)
                for e in entries:
                    for hw in e.get("hold_windows", []):
                        hold_by_cast_idx[hw["cast_index"]].append(hw["actual_s"])
                hold_targets: dict[int, dict] = {}
                for cast_idx, times in hold_by_cast_idx.items():
                    if len(times) >= max(2, len(entries) * 0.4):
                        hold_targets[cast_idx] = {
                            "target_s": round(statistics.median(times), 1),
                            "stddev_s": round(statistics.stdev(times) if len(times) > 1 else 20.0, 1),
                            "count": len(times),
                            "total_samples": len(entries),
                        }

                per_cd_benchmarks[cd_name] = {
                    "avg_first_cast_s": round(statistics.mean(top_first_casts), 1) if top_first_casts else None,
                    "stddev_first_cast_s": round(statistics.stdev(top_first_casts), 1) if len(top_first_casts) > 1 else None,
                    "avg_gap_s": round(statistics.mean(all_gaps), 1) if all_gaps else None,
                    "stddev_gap_s": round(statistics.stdev(all_gaps), 1) if len(all_gaps) > 1 else None,
                    "avg_bl_offset_s": round(statistics.mean(bl_offsets), 1) if bl_offsets else None,
                    "stddev_bl_offset_s": round(statistics.stdev(bl_offsets), 1) if len(bl_offsets) > 1 else None,
                    "hold_targets": hold_targets,
                }

            # Aggregate burst windows across all parse samples
            all_bw: list[dict] = []
            for s in samples:
                for bw in (s.get("cooldown_data") or {}).get("burst_windows", []):
                    all_bw.append(bw)
            consistent_bw = _cluster_burst_windows(all_bw, len(samples)) if all_bw else []

    result = analyze_player(
        player=player,
        fight_start=start,
        fight_end=end,
        cast_events=cast_events,
        buff_events=buff_events,
        spec_cds_override=spec_cds,
        rules_override=spec_rules,
        top_efficiency_pct=top_avg_efficiency,
        top_efficiency_stddev=top_efficiency_stddev,
        per_cd_benchmarks=per_cd_benchmarks or None,
        downtime_threshold_ms=downtime_threshold_ms,
    )
    result["spec"] = spec  # override actor.subType with properly resolved spec
    result["rulebook_source"] = rulebook_source
    result["player_fight_duration_s"] = round(player_fight_dur_s, 1)

    # Attach parse comparison
    if encounter_id and spec_cds and samples and agg:
        # Resolve player BL time for per-CD BL offset comparison in the table
        player_bl_s: Optional[float] = None
        for e in buff_events:
            if (
                e.get("type") == "applybuff"
                and e.get("abilityGameID") in BLOODLUST_SPELL_IDS
                and start <= e["timestamp"] <= end
            ):
                player_bl_s = (e["timestamp"] - start) / 1000
                break

        comparison = []
        player_dur_min = player_fight_dur_s / 60 if player_fight_dur_s > 0 else 1
        for cd in spec_cds:
            cd_casts = [
                c for c in cast_events
                if c.get("type") == "cast" and c.get("abilityGameID") == cd["spell_id"]
            ]
            player_first = round((cd_casts[0]["timestamp"] - start) / 1000, 1) if cd_casts else None
            top = agg.get(cd["name"], [])
            if not top:
                continue

            top_uses = [e["total_uses"] for e in top]
            top_first = [e["first_cast_s"] for e in top if e.get("first_cast_s") is not None]
            top_bl = sum(1 for e in top if e.get("bl_aligned"))

            # Uses per minute — normalizes for kill-time differences
            player_upm = round(len(cd_casts) / player_dur_min, 2)
            top_upm_list = [
                e["total_uses"] / (e["fight_duration_s"] / 60)
                for e in top if e.get("fight_duration_s")
            ]
            top_avg_upm = round(statistics.mean(top_upm_list), 2) if top_upm_list else None
            top_stddev_upm = round(statistics.stdev(top_upm_list), 3) if len(top_upm_list) > 1 else None
            top_avg_first = round(statistics.mean(top_first), 1) if top_first else None
            top_stddev_first = round(statistics.stdev(top_first), 1) if len(top_first) > 1 else None

            # BL offset: when (relative to BL start) did the player use this CD during BL?
            player_bl_offset: Optional[float] = None
            if player_bl_s is not None and cd_casts:
                window_offsets = [
                    (c["timestamp"] - start) / 1000 - player_bl_s
                    for c in cd_casts
                    if player_bl_s - 30 <= (c["timestamp"] - start) / 1000 <= player_bl_s + 55
                ]
                if window_offsets:
                    player_bl_offset = round(min(window_offsets, key=abs), 1)

            bench_cd = per_cd_benchmarks.get(cd["name"], {})
            comparison.append({
                "name": cd["name"],
                "player_uses": len(cd_casts),
                "player_uses_per_min": player_upm,
                "player_first_cast_s": player_first,
                "top_avg_uses": round(statistics.mean(top_uses), 1) if top_uses else None,
                "top_avg_uses_per_min": top_avg_upm,
                "top_stddev_uses_per_min": top_stddev_upm,
                "top_avg_first_cast_s": top_avg_first,
                "top_stddev_first_cast_s": top_stddev_first,
                "top_bl_pct": round(top_bl / len(top) * 100),
                "player_bl_offset_s": player_bl_offset,
                "top_avg_bl_offset_s": bench_cd.get("avg_bl_offset_s"),
                "top_stddev_bl_offset_s": bench_cd.get("stddev_bl_offset_s"),
                "sample_count": len(top),
            })
        result["parse_comparison"] = comparison
        result["downtime_threshold_ms"] = round(downtime_threshold_ms)
        if top_avg_efficiency is not None:
            result["top_efficiency_pct"] = top_avg_efficiency
        if top_efficiency_stddev is not None:
            result["top_efficiency_stddev"] = top_efficiency_stddev
        if consistent_bw:
            result["burst_windows"] = consistent_bw

    return result


# ── Pre-fight brief API ───────────────────────────────────────────────────────

@app.get("/api/pre/specs")
async def pre_specs():
    return {"specs": sorted(SPEC_TO_WCL.keys())}


@app.get("/api/pre/brief/{spec}/{encounter_id}")
async def pre_fight_brief(spec: str, encounter_id: int):
    samples = await db.get_parse_samples(spec, encounter_id)
    if not samples:
        return {"sample_count": 0, "spec": spec, "encounter_id": encounter_id}

    encounter_name = samples[0].get("encounter_name", "Unknown")
    durations = [
        (s.get("cooldown_data") or {}).get("fight_duration_s")
        for s in samples
    ]
    durations = [d for d in durations if d]

    agg: dict[str, list] = defaultdict(list)
    for s in samples:
        cd_data = s.get("cooldown_data") or {}
        fight_dur = cd_data.get("fight_duration_s", 0)
        for cd in cd_data.get("cooldowns", []):
            agg[cd["name"]].append({**cd, "fight_duration_s": fight_dur})

    cached_rb = db.get_cached_rulebook(spec)
    rb_cds = {cd["name"]: cd for cd in ((cached_rb or {}).get("major_cooldowns") or [])}
    rb_rules = [
        r for r in ((cached_rb or {}).get("rules") or [])
        if r.get("priority") in ("critical", "high")
    ]

    cd_briefs: dict = {}
    for cd_name, entries in agg.items():
        first_casts = [e["first_cast_s"] for e in entries if e.get("first_cast_s") is not None]
        upm_list = [
            e["total_uses"] / (e["fight_duration_s"] / 60)
            for e in entries if e.get("fight_duration_s")
        ]
        bl_count = sum(1 for e in entries if e.get("bl_aligned"))
        bl_offsets = [e["bl_offset_s"] for e in entries if e.get("bl_offset_s") is not None]

        hold_by_cast_idx: dict[int, list[float]] = defaultdict(list)
        for e in entries:
            for hw in e.get("hold_windows", []):
                hold_by_cast_idx[hw["cast_index"]].append(hw["actual_s"])
        hold_targets: dict[int, dict] = {}
        for cast_idx, times in hold_by_cast_idx.items():
            if len(times) >= max(2, len(entries) * 0.35):
                hold_targets[cast_idx] = {
                    "target_s": round(statistics.median(times), 1),
                    "stddev_s": round(statistics.stdev(times) if len(times) > 1 else 20.0, 1),
                    "count": len(times),
                    "total_samples": len(entries),
                }

        cd_briefs[cd_name] = {
            "avg_first_cast_s": round(statistics.mean(first_casts), 1) if first_casts else None,
            "stddev_first_cast_s": round(statistics.stdev(first_casts), 1) if len(first_casts) > 1 else None,
            "avg_uses_per_min": round(statistics.mean(upm_list), 2) if upm_list else None,
            "avg_uses": round(statistics.mean([e["total_uses"] for e in entries]), 1) if entries else 0,
            "bl_pct": round(bl_count / len(entries) * 100) if entries else 0,
            "avg_bl_offset_s": round(statistics.mean(bl_offsets), 1) if bl_offsets else None,
            "hold_targets": hold_targets,
            "majority_hold": sum(1 for e in entries if e.get("cast_pattern") == "hold") > len(entries) * 0.5,
            "usage_rule": rb_cds.get(cd_name, {}).get("usage_rule"),
            "align_with_bloodlust": rb_cds.get(cd_name, {}).get("align_with_bloodlust", False),
        }

    all_bw: list[dict] = []
    for s in samples:
        for bw in (s.get("cooldown_data") or {}).get("burst_windows", []):
            all_bw.append(bw)
    burst_windows = _cluster_burst_windows(all_bw, len(samples)) if all_bw else []

    return {
        "sample_count": len(samples),
        "spec": spec,
        "encounter_id": encounter_id,
        "encounter_name": encounter_name,
        "avg_duration_s": round(statistics.mean(durations), 1) if durations else None,
        "cooldowns": cd_briefs,
        "burst_windows": burst_windows,
        "source_summary": (cached_rb or {}).get("source_summary"),
        "top_rules": rb_rules[:5],
    }


# ── Admin — Guides ────────────────────────────────────────────────────────────

class AddGuideRequest(BaseModel):
    spec: str
    url: str
    guide_type: str = "web"  # 'web' | 'youtube'


@app.get("/api/admin/guides/{spec}")
async def list_guides(spec: str):
    guides = await db.get_guides(spec)
    return {"guides": guides}


@app.post("/api/admin/guides")
async def add_guide(req: AddGuideRequest):
    guide_id = await db.add_guide(req.spec, req.url, req.guide_type)
    return {"id": guide_id, "message": "Guide added"}


@app.delete("/api/admin/guides/{guide_id}")
async def delete_guide(guide_id: int):
    guide = await db.get_guide(guide_id)
    if not guide:
        raise HTTPException(status_code=404, detail="Guide not found")
    await db.delete_guide(guide_id)
    return {"message": "Deleted"}


@app.post("/api/admin/guides/{guide_id}/scrape")
async def scrape_guide(guide_id: int):
    guide = await db.get_guide(guide_id)
    if not guide:
        raise HTTPException(status_code=404, detail="Guide not found")

    try:
        title, content = await scrape(guide["url"], guide["guide_type"])
        word_count = len(content.split())
        await db.update_guide_content(guide_id, title, content, word_count)
        return {"status": "scraped", "title": title, "word_count": word_count}
    except Exception as exc:
        await db.update_guide_error(guide_id, str(exc))
        raise HTTPException(status_code=422, detail=str(exc))


@app.get("/api/admin/guides/spec/{spec}/scrape-stream")
async def scrape_all_stream(spec: str):
    """SSE stream — yields one event per guide as it is scraped."""
    def _evt(payload: dict) -> str:
        return f"data: {json.dumps(payload)}\n\n"

    async def generate():
        guides = await db.get_guides(spec)
        total = len(guides)
        yield _evt({"type": "start", "total": total})
        scraped = errors = 0
        for i, g in enumerate(guides):
            yield _evt({"type": "progress", "step": i + 1, "total": total,
                        "url": g["url"], "guide_type": g["guide_type"]})
            try:
                title, content = await scrape(g["url"], g["guide_type"])
                word_count = len(content.split())
                await db.update_guide_content(g["id"], title, content, word_count)
                scraped += 1
                yield _evt({"type": "done", "step": i + 1, "total": total,
                            "id": g["id"], "title": title, "word_count": word_count})
            except Exception as exc:
                await db.update_guide_error(g["id"], str(exc))
                errors += 1
                yield _evt({"type": "error", "step": i + 1, "total": total,
                            "id": g["id"], "error": str(exc)})
        yield _evt({"type": "complete", "scraped": scraped, "errors": errors})

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Admin — Rulebook prompt assembly ─────────────────────────────────────────

@app.get("/api/admin/guides/{spec}/prompt")
async def get_rulebook_prompt(spec: str):
    """Assemble the AI prompt (skill file + scraped guides) ready to copy-paste."""
    guides = await db.get_guides(spec)
    scraped = [g for g in guides if g["status"] == "scraped" and g.get("content")]
    if not scraped:
        raise HTTPException(
            status_code=400,
            detail="No scraped guides. Add and scrape at least one guide first.",
        )

    skill_path = PROMPTS_DIR / "rulebook_skill.md"
    if not skill_path.exists():
        raise HTTPException(status_code=500, detail="Skill file missing: prompts/rulebook_skill.md")
    template = skill_path.read_text(encoding="utf-8")

    sections = []
    for i, g in enumerate(scraped, 1):
        title = g.get("title") or g["url"]
        sections.append(f"### Source {i}: {title}\n\n{g['content'][:60_000]}")
    guide_content = "\n\n---\n\n".join(sections)

    prompt = (template
              .replace("{{spec}}", spec)
              .replace("{{guide_count}}", str(len(scraped)))
              .replace("{{guide_content}}", guide_content))

    return {"prompt": prompt, "guide_count": len(scraped), "spec": spec}


class ManualRulebookRequest(BaseModel):
    rulebook: dict


@app.put("/api/admin/rulebook/{spec}")
async def save_manual_rulebook(spec: str, req: ManualRulebookRequest):
    """Persist a hand-crafted rulebook JSON directly, bypassing the LLM."""
    rb = req.rulebook
    if "major_cooldowns" not in rb:
        raise HTTPException(
            status_code=422,
            detail="JSON must contain a 'major_cooldowns' array.",
        )
    rb.setdefault("spec", spec)
    rb.setdefault("source_summary", "Manually defined")
    await db.save_rulebook(spec, rb, guide_count=0)
    return {"message": "Rulebook saved", "rulebook": rb}


@app.get("/api/admin/rulebook/{spec}")
async def get_rulebook(spec: str):
    row = await db.get_rulebook_row(spec)
    if row:
        import json
        return {
            "source": "generated",
            "spec": spec,
            "generated_at": row["generated_at"],
            "guide_count": row["guide_count"],
            "rulebook": json.loads(row["rulebook"]),
        }
    from rulebook import SPEC_COOLDOWNS
    static_cds = SPEC_COOLDOWNS.get(spec)
    if static_cds:
        return {"source": "static", "spec": spec, "cooldowns": static_cds}
    return {"source": "none", "spec": spec}


# ── Admin — Top parses ────────────────────────────────────────────────────────

@app.get("/api/admin/encounters")
async def list_encounters():
    try:
        encounters = await get_encounters(wcl)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return {"encounters": encounters}


class FetchParsesRequest(BaseModel):
    spec: str
    encounter_id: int
    count: int = 10
    analyze: bool = False  # if True, also fetch + analyze each parse's events


@app.post("/api/admin/parses/fetch")
async def fetch_parses(req: FetchParsesRequest):
    """Non-streaming rankings fetch (no deep analysis)."""
    try:
        result = await fetch_top_rankings(wcl, req.spec, req.encounter_id, req.count)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return result


@app.post("/api/admin/parses/analyze-stream")
async def analyze_parses_stream(req: FetchParsesRequest):
    """SSE stream — fetches rankings then deep-analyzes each parse one by one."""
    def _evt(payload: dict) -> str:
        return f"data: {json.dumps(payload)}\n\n"

    async def generate():
        # Step 1: rankings
        yield _evt({"type": "rankings_start"})
        try:
            result = await fetch_top_rankings(wcl, req.spec, req.encounter_id, req.count)
        except Exception as exc:
            yield _evt({"type": "error", "error": str(exc)})
            return
        yield _evt({"type": "rankings_done", "rankings": result["rankings"],
                    "encounter_name": result["encounter_name"]})

        # Step 2: per-parse event analysis
        rankings = result["rankings"]
        total = len(rankings)
        analyzed = []
        for i, ranking in enumerate(rankings):
            code = ranking.get("report_code")
            fight_id = ranking.get("fight_id")
            yield _evt({"type": "parse_progress", "step": i + 1, "total": total,
                        "player": ranking.get("player")})
            if not code or not fight_id:
                yield _evt({"type": "parse_skip", "step": i + 1, "player": ranking.get("player")})
                continue
            summary = await analyze_parse(wcl, req.spec, code, fight_id, player_name=ranking.get("player"))
            if summary:
                await db.save_parse_sample(
                    spec=req.spec,
                    encounter_id=req.encounter_id,
                    encounter_name=result["encounter_name"],
                    report_code=code,
                    fight_id=fight_id,
                    player_name=summary["player"],
                    cooldown_data=summary,
                )
                analyzed.append(summary)
                yield _evt({"type": "parse_done", "step": i + 1, "total": total,
                            "summary": summary})
            else:
                yield _evt({"type": "parse_skip", "step": i + 1, "player": ranking.get("player")})

        yield _evt({"type": "complete", "analyzed": len(analyzed)})

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


_INGEST_EXCLUDE = re.compile(r"beta|ptr|mythic\+|complete raids|delves|torghast", re.IGNORECASE)


@app.get("/api/admin/parses/stats/{spec}")
async def parse_stats(spec: str):
    return {"stats": await db.get_parse_stats(spec)}


@app.get("/api/admin/parses/samples/{spec}/{encounter_id}")
async def parse_samples_endpoint(spec: str, encounter_id: int):
    samples = await db.get_parse_samples(spec, encounter_id)
    for s in samples:
        cd = s.get("cooldown_data") or {}
        cd.pop("cast_gap_list_ms", None)
        for c in cd.get("cooldowns", []):
            c.pop("cast_times_s", None)
    return {"samples": samples}


@app.get("/api/admin/parses/ingest-all-stream/{spec}")
async def ingest_all_stream(spec: str):
    """SSE — ingests top 10 parses for every current-expansion boss sequentially."""
    def _evt(payload: dict) -> str:
        return f"data: {json.dumps(payload)}\n\n"

    async def generate():
        try:
            encounters = await get_encounters(wcl)
        except Exception as exc:
            yield _evt({"type": "error", "error": str(exc)})
            return

        live = [e for e in encounters if not _INGEST_EXCLUDE.search(e.get("zone", ""))]
        current_exp = next((e["expansion"] for e in live if e.get("expansion")), None)
        if not current_exp:
            yield _evt({"type": "error", "error": "Could not determine current expansion."})
            return

        current = [e for e in live if e["expansion"] == current_exp]
        total_bosses = len(current)
        yield _evt({"type": "start", "total": total_bosses, "expansion": current_exp})

        total_analyzed = 0
        for idx, enc in enumerate(current):
            enc_id, enc_name = enc["id"], enc["name"]
            yield _evt({"type": "boss_start", "encounter_id": enc_id,
                        "encounter_name": enc_name, "index": idx, "total": total_bosses})
            try:
                result = await fetch_top_rankings(wcl, spec, enc_id, 10)
            except Exception as exc:
                yield _evt({"type": "boss_error", "encounter_id": enc_id,
                            "encounter_name": enc_name, "error": str(exc)})
                continue

            rankings = result["rankings"]
            await db.clear_parse_samples(spec, enc_id)
            boss_done = 0
            for step, r in enumerate(rankings):
                code = r.get("report_code")
                fight_id = r.get("fight_id")
                yield _evt({"type": "parse_progress", "encounter_id": enc_id,
                            "step": step + 1, "total": len(rankings), "player": r.get("player")})
                if not code or not fight_id:
                    yield _evt({"type": "parse_skip", "encounter_id": enc_id,
                                "player": r.get("player")})
                    continue
                summary = await analyze_parse(wcl, spec, code, fight_id,
                                              player_name=r.get("player"))
                if summary:
                    await db.save_parse_sample(
                        spec=spec, encounter_id=enc_id, encounter_name=enc_name,
                        report_code=code, fight_id=fight_id,
                        player_name=summary["player"], cooldown_data=summary,
                    )
                    boss_done += 1
                    yield _evt({"type": "parse_done", "encounter_id": enc_id,
                                "step": step + 1, "player": summary["player"]})
                else:
                    yield _evt({"type": "parse_skip", "encounter_id": enc_id,
                                "player": r.get("player")})

            total_analyzed += boss_done
            yield _evt({"type": "boss_done", "encounter_id": enc_id, "encounter_name": enc_name,
                        "analyzed": boss_done, "index": idx, "total": total_bosses})

        yield _evt({"type": "complete", "total_analyzed": total_analyzed})

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _cluster_burst_windows(windows: list[dict], total_samples: int, merge_s: float = 15.0) -> list[dict]:
    """Cluster burst windows from multiple parses by fight time and return consistent ones."""
    if not windows:
        return []
    sorted_w = sorted(windows, key=lambda w: w["time_s"])
    clusters: list[list[dict]] = []
    for w in sorted_w:
        placed = False
        for cl in clusters:
            center = statistics.median(c["time_s"] for c in cl)
            if abs(w["time_s"] - center) <= merge_s:
                cl.append(w)
                placed = True
                break
        if not placed:
            clusters.append([w])

    result = []
    for cl in clusters:
        if len(cl) < max(2, total_samples * 0.35):
            continue
        times = [c["time_s"] for c in cl]
        pcts = [c["pct_of_total"] for c in cl]
        cd_counts: Counter = Counter()
        for c in cl:
            for name in c.get("active_cds", []):
                cd_counts[name] += 1
        common_cds = [name for name, cnt in cd_counts.most_common() if cnt >= len(cl) * 0.5]
        result.append({
            "time_s": round(statistics.median(times), 1),
            "stddev_s": round(statistics.stdev(times) if len(times) > 1 else 0.0, 1),
            "count": len(cl),
            "total_samples": total_samples,
            "pct_avg": round(statistics.mean(pcts), 3),
            "common_cds": common_cds,
        })
    return sorted(result, key=lambda r: r["time_s"])


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
