import asyncio
import json
import re
import statistics
from collections import Counter, defaultdict
from pathlib import Path
from typing import Optional

# WCL gear array indices (0-based positional, same order as WoW's paper doll)
_TRINKET_SLOTS = {12, 13}

# WCL gameData.classes { id name } — class field in encounterRankings is this numeric ID
_WCL_CLASS_NAMES = {
    1: "DeathKnight", 2: "Druid", 3: "Hunter", 4: "Mage", 5: "Monk",
    6: "Paladin", 7: "Priest", 8: "Rogue", 9: "Shaman", 10: "Warlock",
    11: "Warrior", 12: "DemonHunter", 13: "Evoker",
}

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import store
from analyzer import analyze_player
from parses_analyzer import (
    get_encounters, fetch_top_rankings, analyze_parse, SPEC_TO_WCL,
    _extract_combatant_info, _CHAR_ENC_RANKINGS_QUERY,
)
from rulebook import BLOODLUST_SPELL_IDS
from scraper import scrape
from wcl_client import WCLClient

app = FastAPI(title="WoW Progression Analyzer")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

wcl = WCLClient()
STATIC_DIR   = Path(__file__).parent / "static"
PROMPTS_DIR  = Path(__file__).parent / "prompts"
DATA_DIR     = Path(__file__).parent / "data"


@app.on_event("startup")
async def startup():
    store.init_store()


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
    return RedirectResponse(url="/static/index.html")


@app.get("/admin", include_in_schema=False)
@app.get("/contribute", include_in_schema=False)
async def admin_frontend():
    return RedirectResponse(url="/static/admin.html")


@app.get("/pre", include_in_schema=False)
async def pre_frontend():
    return RedirectResponse(url="/static/pre.html")


@app.get("/live", include_in_schema=False)
async def live_frontend():
    return RedirectResponse(url="/static/live.html")


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

    _ability_map: dict[int, dict] = {
        a["gameID"]: {"name": a.get("name") or "", "icon": a.get("icon") or ""}
        for a in (report["masterData"].get("abilities") or [])
        if a.get("gameID")
    }
    _ability_names: dict[int, str] = {gid: v["name"] for gid, v in _ability_map.items() if v["name"]}

    start, end = fight["startTime"], fight["endTime"]
    try:
        cast_events, buff_events, damage_events, damage_taken_events = await asyncio.gather(
            wcl.get_all_events(code, req.fight_id, "Casts", start, end, source_id=req.player_id),
            wcl.get_all_events(code, req.fight_id, "Buffs", start, end, target_id=req.player_id),
            wcl.get_all_events(code, req.fight_id, "DamageDone", start, end, source_id=req.player_id),
            wcl.get_all_events(code, req.fight_id, "DamageTaken", start, end, target_id=req.player_id),
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Event fetch failed: {exc}")

    try:
        pd_data = await wcl.get_player_details(code, req.fight_id)
        spec_map = _build_spec_map(pd_data["reportData"]["report"])
    except Exception:
        spec_map = {}
    spec = spec_map.get(req.player_id) or player.get("subType", "Unknown")
    spec_cds = store.get_spec_cooldowns(spec)
    cached_rb = store.get_cached_rulebook(spec)
    spec_rules = (cached_rb or {}).get("rules", []) if cached_rb else []
    rulebook_source = "generated" if cached_rb else ("static" if spec_cds else "none")

    encounter_id = fight.get("encounterID")
    player_fight_dur_s = (end - start) / 1000

    # Load pre-computed bench data from encounter file
    enc_data = store.get_encounter_data(spec, encounter_id) if encounter_id else None
    top_avg_efficiency: Optional[float] = None
    top_efficiency_stddev: Optional[float] = None
    per_cd_benchmarks: dict = {}
    consistent_bw: list = []
    downtime_threshold_ms: float = 1500.0

    if enc_data:
        top_avg_efficiency = enc_data.get("top_avg_efficiency")
        top_efficiency_stddev = enc_data.get("top_efficiency_stddev")
        downtime_threshold_ms = float(enc_data.get("downtime_threshold_ms") or 1500.0)
        per_cd_benchmarks = enc_data.get("per_cd_benchmarks") or {}
        consistent_bw = enc_data.get("burst_windows") or []

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
    result["spec"] = spec
    result["rulebook_source"] = rulebook_source
    result["player_fight_duration_s"] = round(player_fight_dur_s, 1)
    result["cd_spell_ids"] = {cd["name"]: cd["spell_id"] for cd in (spec_cds or [])}

    # Build parse comparison table from pre-computed per-CD benchmarks
    if encounter_id and spec_cds and enc_data:
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
            bench = per_cd_benchmarks.get(cd["name"])
            if not bench:
                continue
            cd_casts = [
                c for c in cast_events
                if c.get("type") == "cast" and c.get("abilityGameID") == cd["spell_id"]
            ]
            player_first = round((cd_casts[0]["timestamp"] - start) / 1000, 1) if cd_casts else None
            player_upm = round(len(cd_casts) / player_dur_min, 2)

            player_bl_offset: Optional[float] = None
            if player_bl_s is not None and cd_casts:
                window_offsets = [
                    (c["timestamp"] - start) / 1000 - player_bl_s
                    for c in cd_casts
                    if player_bl_s - 30 <= (c["timestamp"] - start) / 1000 <= player_bl_s + 55
                ]
                if window_offsets:
                    player_bl_offset = round(min(window_offsets, key=abs), 1)

            upm = bench.get("uses_per_min") or {}
            comparison.append({
                "name": cd["name"],
                "player_uses": len(cd_casts),
                "player_uses_per_min": player_upm,
                "player_first_cast_s": player_first,
                "top_avg_uses": bench.get("avg_uses"),
                "top_avg_uses_per_min": upm.get("avg"),
                "top_stddev_uses_per_min": upm.get("stddev"),
                "top_avg_first_cast_s": bench.get("avg_first_cast_s"),
                "top_stddev_first_cast_s": bench.get("stddev_first_cast_s"),
                "top_bl_pct": bench.get("bl_pct"),
                "player_bl_offset_s": player_bl_offset,
                "top_avg_bl_offset_s": bench.get("avg_bl_offset_s"),
                "top_stddev_bl_offset_s": bench.get("stddev_bl_offset_s"),
                "sample_count": bench.get("sample_count", enc_data.get("sample_count", 0)),
            })
        result["parse_comparison"] = comparison
        result["downtime_threshold_ms"] = round(downtime_threshold_ms)
        if top_avg_efficiency is not None:
            result["top_efficiency_pct"] = top_avg_efficiency
        if top_efficiency_stddev is not None:
            result["top_efficiency_stddev"] = top_efficiency_stddev
        if consistent_bw:
            result["burst_windows"] = consistent_bw

        if enc_data.get("top_defensives_summary"):
            result["top_defensives_summary"] = enc_data["top_defensives_summary"]
        if enc_data.get("top_dtk_comparison"):
            result["top_dtk_comparison"] = enc_data["top_dtk_comparison"]
        if enc_data.get("top_dtk_segments"):
            result["top_dtk_segments"] = enc_data["top_dtk_segments"]

    # Player burst windows
    from parses_analyzer import _find_burst_windows as _player_find_bw
    player_bw = _player_find_bw(damage_events, start)
    for bw in player_bw:
        bw_t = bw["time_s"]
        active: list[str] = []
        for cd in (spec_cds or []):
            dur = cd.get("duration") or 0
            if dur > 0:
                cd_casts = [
                    c for c in cast_events
                    if c.get("type") == "cast" and c.get("abilityGameID") == cd["spell_id"]
                ]
                for c in cd_casts:
                    ct = (c["timestamp"] - start) / 1000
                    if ct <= bw_t <= ct + dur:
                        active.append(cd["name"])
                        break
        bw["active_cds"] = active
    result["player_burst_windows"] = player_bw

    # Player defensive analysis
    from rulebook import SPEC_DEFENSIVES as _SPEC_DEFENSIVES
    spec_defensives = _SPEC_DEFENSIVES.get(spec) or []
    player_defensive_usage: list[dict] = []

    buff_windows_by_sid: dict[int, list[list]] = {}
    for e in buff_events:
        sid = e.get("abilityGameID")
        t_s = (e["timestamp"] - start) / 1000
        if e.get("type") == "applybuff":
            buff_windows_by_sid.setdefault(sid, []).append([t_s, None])
        elif e.get("type") == "removebuff":
            for w in reversed(buff_windows_by_sid.get(sid, [])):
                if w[1] is None:
                    w[1] = t_s
                    break

    for defn in spec_defensives:
        sid = defn["spell_id"]
        duration = defn.get("duration") or 0
        windows: list[dict] = []
        for w in (buff_windows_by_sid.get(sid) or []):
            w_start = w[0]
            w_end = w[1] if w[1] is not None else (w_start + duration if duration else w_start + 5)
            dmg_during = sum(
                e.get("amount", 0) + e.get("absorbed", 0)
                for e in damage_taken_events
                if e.get("type") == "damage"
                and w_start <= (e["timestamp"] - start) / 1000 <= w_end
            )
            windows.append({"start_s": round(w_start, 1), "end_s": round(w_end, 1), "dmg_during": int(dmg_during)})

        if not windows:
            def_casts = [
                c for c in cast_events
                if c.get("type") == "cast" and c.get("abilityGameID") == sid
            ]
            for c in def_casts:
                t_s = (c["timestamp"] - start) / 1000
                w_end = t_s + (duration or 5)
                dmg_during = sum(
                    e.get("amount", 0) + e.get("absorbed", 0)
                    for e in damage_taken_events
                    if e.get("type") == "damage"
                    and t_s <= (e["timestamp"] - start) / 1000 <= w_end
                )
                windows.append({"start_s": round(t_s, 1), "end_s": round(w_end, 1), "dmg_during": int(dmg_during)})

        player_defensive_usage.append({
            "name": defn["name"],
            "spell_id": sid,
            "cooldown": defn.get("cooldown", 0),
            "uses": len(windows),
            "windows": windows,
        })

    result["player_defensives"] = player_defensive_usage

    # Player damage taken analysis
    fight_dur_s = player_fight_dur_s
    segment_size_s = 30
    n_segs = max(1, int(fight_dur_s / segment_size_s) + 1)
    dtk_segments: list[int] = [0] * n_segs
    ability_dtk: dict[int, int] = {}

    for e in damage_taken_events:
        amt = e.get("amount", 0) + e.get("absorbed", 0)
        if not amt:
            continue
        t_s = (e["timestamp"] - start) / 1000
        seg = min(int(t_s / segment_size_s), n_segs - 1)
        dtk_segments[seg] += amt
        sid = e.get("abilityGameID")
        if sid:
            ability_dtk[sid] = ability_dtk.get(sid, 0) + amt

    total_dtk = sum(dtk_segments)
    top_dtk = sorted(ability_dtk.items(), key=lambda x: -x[1])[:10]
    result["player_dmg_taken_segments"] = dtk_segments
    result["player_dmg_taken_segment_pcts"] = [
        round(seg / total_dtk, 4) if total_dtk else 0.0 for seg in dtk_segments
    ]
    result["player_dmg_taken_by_ability"] = [
        {"spell_id": sid, "name": _ability_names.get(sid, ""), "damage": dmg,
         "pct": round(dmg / total_dtk, 3) if total_dtk else 0}
        for sid, dmg in top_dtk
    ]
    result["player_total_dmg_taken"] = total_dtk
    result["dmg_segment_size_s"] = segment_size_s

    result["ability_icons"] = {
        str(gid): v for gid, v in _ability_map.items() if v.get("icon") or v.get("name")
    }

    return result


# ── Spell icons (legacy stub) ─────────────────────────────────────────────────

@app.get("/api/spell-icons")
async def spell_icons_endpoint(ids: str = ""):
    """Legacy endpoint stub — gameData.spell() was removed from WCL; icons come from ability_icons in the analyze response."""
    return {}


# ── Pre-fight brief API ───────────────────────────────────────────────────────

@app.get("/api/pre/specs")
async def pre_specs():
    return {"specs": sorted(SPEC_TO_WCL.keys())}


@app.get("/api/pre/brief/{spec}/{encounter_id}")
async def pre_fight_brief(spec: str, encounter_id: int):
    enc_data = store.get_encounter_data(spec, encounter_id)
    if not enc_data:
        return {"sample_count": 0, "spec": spec, "encounter_id": encounter_id}

    cached_rb = store.get_cached_rulebook(spec)
    rb_cds = {cd["name"]: cd for cd in ((cached_rb or {}).get("major_cooldowns") or [])}
    rb_rules = [
        r for r in ((cached_rb or {}).get("rules") or [])
        if r.get("priority") in ("critical", "high")
    ]

    # Enrich per-CD benchmarks with rulebook usage guidance
    cd_briefs: dict = {}
    for cd_name, bench in (enc_data.get("per_cd_benchmarks") or {}).items():
        cd_briefs[cd_name] = {
            **bench,
            "usage_rule": rb_cds.get(cd_name, {}).get("usage_rule"),
            "align_with_bloodlust": rb_cds.get(cd_name, {}).get("align_with_bloodlust", False),
        }

    return {
        "sample_count": enc_data.get("sample_count", 0),
        "spec": spec,
        "encounter_id": encounter_id,
        "encounter_name": enc_data.get("encounter_name"),
        "avg_duration_s": enc_data.get("avg_duration_s"),
        "cooldowns": cd_briefs,
        "burst_windows": enc_data.get("burst_windows", []),
        "source_summary": (cached_rb or {}).get("source_summary"),
        "top_rules": rb_rules[:5],
    }


# ── Gear helpers ─────────────────────────────────────────────────────────────

def _parse_char_url(url_or_input: str) -> tuple[str, str, str]:
    """Return (name, server_slug, region) from a WCL or armory character URL."""
    s = url_or_input.strip()
    m = re.search(r"warcraftlogs\.com/character/([a-z]+)/([a-zA-Z0-9\-]+)/([^\s/?#]+)", s, re.I)
    if m:
        return m.group(3).lower(), m.group(2).lower(), m.group(1).lower()
    m = re.search(r"worldofwarcraft\.blizzard\.com/[a-z\-]+/character/([a-z]+)/([a-zA-Z0-9\-]+)/([^\s/?#]+)", s, re.I)
    if m:
        return m.group(3).lower(), m.group(2).lower(), m.group(1).lower()
    raise ValueError(
        f"Could not parse character URL. Use a WCL or Armory character page URL: {s!r}"
    )


def _find_player_in_pd(report: dict, player_name: str) -> tuple[Optional[dict], Optional[str]]:
    spec_map = _build_spec_map(report)
    raw = report.get("playerDetails")
    if not raw:
        return None, None
    outer = json.loads(raw) if isinstance(raw, str) else raw
    details = (outer.get("data") or {}).get("playerDetails") or outer
    name_lower = player_name.lower()
    for role in ("dps", "healers", "tanks", "unknown"):
        for p in (details.get(role) or []):
            if (p.get("name") or "").lower() == name_lower:
                return p, spec_map.get(p.get("id"))
    return None, None


@app.get("/api/pre/char-lookup")
async def char_lookup(url: str):
    try:
        name, server_slug, region = _parse_char_url(url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    try:
        char_data = await wcl.get_character(name, server_slug, region)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"WCL character lookup failed: {exc}")

    char = (char_data.get("characterData") or {}).get("character")
    if not char:
        raise HTTPException(status_code=404, detail=f"Character not found: {name}-{server_slug} ({region})")

    reports = ((char.get("recentReports") or {}).get("data")) or []
    if not reports:
        raise HTTPException(status_code=404, detail="No recent WCL reports found for this character.")

    spec = None
    source_report = reports[0]["code"]
    for rep in reports[:3]:
        try:
            rd = await wcl.get_report(rep["code"])
        except Exception:
            continue
        fights = (rd.get("reportData") or {}).get("report", {}).get("fights") or []
        if not fights:
            continue
        try:
            pd_data = await wcl.get_player_details(rep["code"], fights[0]["id"])
        except Exception:
            continue
        pd_report = (pd_data.get("reportData") or {}).get("report") or {}
        _, detected = _find_player_in_pd(pd_report, char["name"])
        if detected:
            spec = detected
            source_report = rep["code"]
            break

    return {
        "name": char["name"],
        "spec": spec,
        "server": server_slug,
        "region": region,
        "source_report": source_report,
    }


@app.get("/api/pre/char-gear")
async def char_gear(name: str, server: str, region: str, encounter_id: int):
    try:
        data = await wcl.query(_CHAR_ENC_RANKINGS_QUERY, {
            "name": name, "serverSlug": server, "serverRegion": region, "encID": encounter_id,
        })
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"WCL query failed: {exc}")

    raw = (data.get("characterData") or {}).get("character", {}).get("encounterRankings")
    if raw is None:
        raise HTTPException(status_code=404, detail=f"Character not found: {name}-{server} ({region})")

    rankings_data = json.loads(raw) if isinstance(raw, str) else raw
    ranks = (rankings_data.get("ranks") or []) if isinstance(rankings_data, dict) else []
    if not ranks:
        return {"found": False, "message": "No ranked kills found. Enable advanced combat logging and upload a recent raid log."}

    most_recent = max(ranks, key=lambda r: r.get("startTime", 0))
    gear = _extract_combatant_info(most_recent)

    enchant_ids = list({e["id"] for e in gear.get("enchants", []) if e.get("id")})
    if enchant_ids:
        try:
            names = await wcl.get_enchant_names(enchant_ids)
            for e in gear["enchants"]:
                if not e.get("name"):
                    e["name"] = names.get(e["id"], "")
        except Exception:
            pass

    spec_part = most_recent.get("spec") or ""
    class_id = most_recent.get("class")
    class_name = _WCL_CLASS_NAMES.get(class_id, "") if isinstance(class_id, int) else ""
    full_spec = f"{spec_part}{class_name}" if spec_part and class_name else spec_part
    return {
        "found": True,
        "spec": full_spec,
        "source_report": (most_recent.get("report") or {}).get("code"),
        "source_time": most_recent.get("startTime"),
        **gear,
    }


@app.get("/api/pre/gear-stats/{spec}/{encounter_id}")
async def gear_stats(spec: str, encounter_id: int):
    """Return aggregated gear (talents, trinkets, enchants) from pre-computed encounter data."""
    enc_data = store.get_encounter_data(spec, encounter_id)
    if not enc_data:
        return {}
    result = enc_data.get("gear") or {}

    all_enc_ids = list({
        item["id"]
        for slot_data in (result.get("enchants") or {}).values()
        for item in slot_data
        if item.get("id")
    })
    if all_enc_ids:
        try:
            names = await wcl.get_enchant_names(all_enc_ids)
            for slot_data in result.get("enchants", {}).values():
                for item in slot_data:
                    if not item.get("name") and item.get("id"):
                        item["name"] = names.get(item["id"], "")
        except Exception:
            pass

    return result


# ── Admin — Guides ────────────────────────────────────────────────────────────

class AddGuideRequest(BaseModel):
    spec: str
    url: str
    guide_type: str = "web"


@app.get("/api/admin/guides/{spec}")
async def list_guides(spec: str):
    guides = store.get_guides(spec)
    return {"guides": guides}


@app.post("/api/admin/guides")
async def add_guide(req: AddGuideRequest):
    guide_id = store.add_guide(req.spec, req.url, req.guide_type)
    return {"id": guide_id, "message": "Guide added"}


@app.delete("/api/admin/guides/{guide_id}")
async def delete_guide(guide_id: int):
    guide = store.get_guide(guide_id)
    if not guide:
        raise HTTPException(status_code=404, detail="Guide not found")
    store.delete_guide(guide_id, spec=guide.get("spec", ""))
    return {"message": "Deleted"}


@app.post("/api/admin/guides/{guide_id}/scrape")
async def scrape_guide(guide_id: int):
    guide = store.get_guide(guide_id)
    if not guide:
        raise HTTPException(status_code=404, detail="Guide not found")

    try:
        title, content = await scrape(guide["url"], guide["guide_type"])
        word_count = len(content.split())
        store.update_guide_content(guide_id, title, content, word_count, spec=guide.get("spec", ""))
        return {"status": "scraped", "title": title, "word_count": word_count}
    except Exception as exc:
        store.update_guide_error(guide_id, str(exc), spec=guide.get("spec", ""))
        raise HTTPException(status_code=422, detail=str(exc))


@app.get("/api/admin/guides/spec/{spec}/scrape-stream")
async def scrape_all_stream(spec: str):
    """SSE stream — yields one event per guide as it is scraped."""
    def _evt(payload: dict) -> str:
        return f"data: {json.dumps(payload)}\n\n"

    async def generate():
        guides = store.get_guides(spec)
        total = len(guides)
        yield _evt({"type": "start", "total": total})
        scraped = errors = 0
        for i, g in enumerate(guides):
            yield _evt({"type": "progress", "step": i + 1, "total": total,
                        "url": g["url"], "guide_type": g["guide_type"]})
            try:
                title, content = await scrape(g["url"], g["guide_type"])
                word_count = len(content.split())
                store.update_guide_content(g["id"], title, content, word_count, spec=spec)
                scraped += 1
                yield _evt({"type": "done", "step": i + 1, "total": total,
                            "id": g["id"], "title": title, "word_count": word_count})
            except Exception as exc:
                store.update_guide_error(g["id"], str(exc), spec=spec)
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
    guides = store.get_guides(spec)
    scraped = [g for g in guides if g.get("status") == "scraped" and g.get("content")]
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
    rb = req.rulebook
    if "major_cooldowns" not in rb:
        raise HTTPException(
            status_code=422,
            detail="JSON must contain a 'major_cooldowns' array.",
        )
    rb.setdefault("spec", spec)
    rb.setdefault("source_summary", "Manually defined")
    store.save_rulebook(spec, rb, guide_count=0)
    return {"message": "Rulebook saved", "rulebook": rb}


@app.get("/api/admin/rulebook/{spec}")
async def get_rulebook(spec: str):
    rb = store.get_rulebook(spec)
    if rb:
        return {
            "source": "generated",
            "spec": spec,
            "generated_at": rb.get("saved_at"),
            "guide_count": rb.get("guide_count", 0),
            "rulebook": rb,
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


@app.post("/api/admin/parses/fetch")
async def fetch_parses(req: FetchParsesRequest):
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
        yield _evt({"type": "rankings_start"})
        try:
            result = await fetch_top_rankings(wcl, req.spec, req.encounter_id, req.count)
        except Exception as exc:
            yield _evt({"type": "error", "error": str(exc)})
            return
        yield _evt({"type": "rankings_done", "rankings": result["rankings"],
                    "encounter_name": result["encounter_name"]})

        rankings = result["rankings"]
        enc_name = result["encounter_name"]
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
            summary = await analyze_parse(wcl, req.spec, code, fight_id,
                                          player_name=ranking.get("player"),
                                          combatant_info=ranking.get("combatant_info"))
            if summary:
                store.save_parse_sample(
                    spec=req.spec, encounter_id=req.encounter_id, encounter_name=enc_name,
                    report_code=code, fight_id=fight_id, player_name=summary["player"],
                    cooldown_data=summary,
                )
                analyzed.append(summary)
                yield _evt({"type": "parse_done", "step": i + 1, "total": total,
                            "summary": summary})
            else:
                yield _evt({"type": "parse_skip", "step": i + 1, "player": ranking.get("player")})

        if analyzed:
            store.sync_encounter_file(req.spec, req.encounter_id)
        yield _evt({"type": "complete", "analyzed": len(analyzed)})

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


_INGEST_EXCLUDE = re.compile(r"beta|ptr|mythic\+|complete raids|delves|torghast", re.IGNORECASE)


@app.get("/api/admin/parses/stats/{spec}")
async def parse_stats(spec: str):
    return {"stats": store.get_parse_stats(spec)}


@app.get("/api/admin/parses/samples/{spec}/{encounter_id}")
async def parse_samples_endpoint(spec: str, encounter_id: int):
    samples = store.get_parse_samples(spec, encounter_id)
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
            store.clear_parse_samples(spec, enc_id)
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
                                              player_name=r.get("player"),
                                              combatant_info=r.get("combatant_info"))
                if summary:
                    store.save_parse_sample(
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
            if boss_done:
                store.sync_encounter_file(spec, enc_id)
            yield _evt({"type": "boss_done", "encounter_id": enc_id, "encounter_name": enc_name,
                        "analyzed": boss_done, "index": idx, "total": total_bosses})

        yield _evt({"type": "complete", "total_analyzed": total_analyzed})

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
app.mount("/data",   StaticFiles(directory=str(DATA_DIR)),   name="data")
