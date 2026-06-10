"""
Fetch top WCL parses for a spec+encounter and extract cooldown timing patterns.
"""
import asyncio
import json
from typing import Optional

import db
from rulebook import BLOODLUST_SPELL_IDS, SPEC_COOLDOWNS
from wcl_client import WCLClient

# WCL uses separate className / specName strings
SPEC_TO_WCL = {
    "RetributionPaladin": ("Paladin", "Retribution"),
    "HolyPaladin": ("Paladin", "Holy"),
    "ProtectionPaladin": ("Paladin", "Protection"),
    "FireMage": ("Mage", "Fire"),
    "ArcaneMage": ("Mage", "Arcane"),
    "FrostMage": ("Mage", "Frost"),
    "HavocDemonHunter": ("DemonHunter", "Havoc"),
    "VengeanceDemonHunter": ("DemonHunter", "Vengeance"),
    "FuryWarrior": ("Warrior", "Fury"),
    "ArmsWarrior": ("Warrior", "Arms"),
    "ProtectionWarrior": ("Warrior", "Protection"),
    "UnholyDeathKnight": ("DeathKnight", "Unholy"),
    "FrostDeathKnight": ("DeathKnight", "Frost"),
    "BloodDeathKnight": ("DeathKnight", "Blood"),
    "BalanceDruid": ("Druid", "Balance"),
    "FeralDruid": ("Druid", "Feral"),
    "GuardianDruid": ("Druid", "Guardian"),
    "RestorationDruid": ("Druid", "Restoration"),
    "BeastMasteryHunter": ("Hunter", "BeastMastery"),
    "MarksmanshipHunter": ("Hunter", "Marksmanship"),
    "SurvivalHunter": ("Hunter", "Survival"),
    "BrewmasterMonk": ("Monk", "Brewmaster"),
    "WindwalkerMonk": ("Monk", "Windwalker"),
    "MistweaverMonk": ("Monk", "Mistweaver"),
    "DisciplinePriest": ("Priest", "Discipline"),
    "HolyPriest": ("Priest", "Holy"),
    "ShadowPriest": ("Priest", "Shadow"),
    "AssassinationRogue": ("Rogue", "Assassination"),
    "OutlawRogue": ("Rogue", "Outlaw"),
    "SubtletyRogue": ("Rogue", "Subtlety"),
    "ElementalShaman": ("Shaman", "Elemental"),
    "EnhancementShaman": ("Shaman", "Enhancement"),
    "RestorationShaman": ("Shaman", "Restoration"),
    "AfflictionWarlock": ("Warlock", "Affliction"),
    "DemonologyWarlock": ("Warlock", "Demonology"),
    "DestructionWarlock": ("Warlock", "Destruction"),
    "DevastationEvoker": ("Evoker", "Devastation"),
    "PreservationEvoker": ("Evoker", "Preservation"),
    "AugmentationEvoker": ("Evoker", "Augmentation"),
}

_RANKINGS_QUERY = """
query($encounterID: Int!, $className: String!, $specName: String!) {
  worldData {
    encounter(id: $encounterID) {
      name
      characterRankings(
        className: $className
        specName: $specName
        metric: dps
        includeCombatantInfo: true
      )
    }
  }
}
"""

_TRINKET_INDICES = {12, 13}

_CHAR_ENC_RANKINGS_QUERY = """
query($name: String!, $serverSlug: String!, $serverRegion: String!, $encID: Int!) {
  characterData {
    character(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
      encounterRankings(encounterID: $encID, includeCombatantInfo: true)
    }
  }
}
"""

_SERVER_BY_ID_QUERY = """
query($id: Int!) {
  worldData {
    server(id: $id) { slug region { slug } }
  }
}
"""

# Cache: server_id → (server_slug, region_slug)
_server_slug_cache: dict[int, tuple[str, str]] = {}


async def _resolve_server_slug(wcl: WCLClient, server_id: int) -> tuple[str, str]:
    """Return (server_slug, region_slug) for a WCL server ID, cached per process lifetime."""
    if server_id in _server_slug_cache:
        return _server_slug_cache[server_id]
    try:
        data = await wcl.query(_SERVER_BY_ID_QUERY, {"id": server_id})
        srv = (data.get("worldData") or {}).get("server") or {}
        result = (str(srv.get("slug") or "").lower(), str((srv.get("region") or {}).get("slug") or "").lower())
    except Exception:
        result = ("", "")
    _server_slug_cache[server_id] = result
    return result


async def _fetch_v2_talent(wcl: WCLClient, name: str, server_slug: str, server_region: str, encounter_id: int) -> str:
    """Fetch v2 talent key for a character from their encounterRankings (most recent kill)."""
    if not name or not server_slug or not server_region:
        return ""
    try:
        data = await wcl.query(_CHAR_ENC_RANKINGS_QUERY, {
            "name": name,
            "serverSlug": server_slug,
            "serverRegion": server_region,
            "encID": encounter_id,
        })
        raw = (data.get("characterData") or {}).get("character", {}).get("encounterRankings")
        if raw is None:
            return ""
        rankings_data = json.loads(raw) if isinstance(raw, str) else raw
        ranks = (rankings_data.get("ranks") or []) if isinstance(rankings_data, dict) else []
        if not ranks:
            return ""
        most_recent = max(ranks, key=lambda r: r.get("startTime", 0))
        return _extract_combatant_info(most_recent).get("talent_key", "")
    except Exception:
        return ""


def _extract_combatant_info(ranking_entry: dict) -> dict:
    """
    Extract talent fingerprint, trinkets, and enchants from a characterRankings entry.
    WCL returns gear as a positionally-ordered array (index 12/13 = trinkets).
    Talents use 'talentID' key. permanentEnchant is returned as a string.
    """
    if not ranking_entry:
        return {"talent_key": "", "trinkets": [], "enchants": []}

    gear = ranking_entry.get("gear") or []
    talents_raw = ranking_entry.get("talents") or []

    trinkets = []
    enchants = []
    for idx, item in enumerate(gear):
        if not item or not item.get("id"):
            continue
        item_id = int(item["id"]) if isinstance(item["id"], str) else item["id"]
        name = item.get("name") or ""

        if idx in _TRINKET_INDICES:
            trinkets.append({"slot": idx, "id": item_id, "name": name})

        enc_raw = item.get("permanentEnchant")
        if enc_raw:
            enc_id = int(enc_raw) if isinstance(enc_raw, str) else enc_raw
            enchants.append({"slot": idx, "id": enc_id, "name": item.get("permanentEnchantName") or ""})

    if isinstance(talents_raw, str):
        talent_key = talents_raw
    elif isinstance(talents_raw, list) and talents_raw:
        # Old WCL format: [{talentID: N, points: P}]
        ids = sorted(
            str(t.get("talentID") or t.get("id") or "")
            for t in talents_raw if t
        )
        talent_key = "v1:" + ",".join(x for x in ids if x)
    elif isinstance(talents_raw, dict) and talents_raw:
        # Midnight format: {class: {row: [{node: {nodeId: N}}]}, spec: {row: [...]}}
        node_ids = []
        for section_key in ("class", "spec"):
            section = talents_raw.get(section_key) or {}
            if isinstance(section, dict):
                for row_nodes in section.values():
                    if isinstance(row_nodes, list):
                        for entry in row_nodes:
                            nid = (entry.get("node") or {}).get("nodeId")
                            if nid:
                                node_ids.append(str(nid))
        talent_key = "v2:" + ",".join(sorted(node_ids))
    else:
        talent_key = ""

    return {"talent_key": talent_key, "trinkets": trinkets, "enchants": enchants}

_ENCOUNTERS_QUERY = """
query {
  worldData {
    expansions {
      id
      name
      zones {
        id
        name
        encounters { id  name }
      }
    }
  }
}
"""

_REPORT_META_QUERY = """
query($code: String!) {
  reportData {
    report(code: $code) {
      fights(killType: Kills) {
        id
        startTime
        endTime
        encounterID
      }
      masterData {
        actors(type: "Player") { id  name  subType }
      }
    }
  }
}
"""


async def get_encounters(wcl: WCLClient) -> list[dict]:
    data = await wcl.query(_ENCOUNTERS_QUERY)
    result = []
    for exp in data["worldData"]["expansions"]:
        for zone in exp.get("zones") or []:
            for enc in zone.get("encounters") or []:
                result.append(
                    {
                        "id": enc["id"],
                        "name": enc["name"],
                        "zone": zone["name"],
                        "expansion": exp["name"],
                    }
                )
    return result


async def fetch_top_rankings(
    wcl: WCLClient, spec: str, encounter_id: int, count: int = 10
) -> dict:
    """Return top `count` rankings for spec on encounter (WCL characterRankings)."""
    mapping = SPEC_TO_WCL.get(spec)
    if not mapping:
        raise ValueError(f"Unknown spec: {spec}")
    class_name, spec_name = mapping

    data = await wcl.query(
        _RANKINGS_QUERY,
        {"encounterID": encounter_id, "className": class_name, "specName": spec_name},
    )
    enc = data["worldData"]["encounter"]
    raw = enc["characterRankings"]
    rankings_data = json.loads(raw) if isinstance(raw, str) else raw
    rankings = (rankings_data.get("rankings") or [])[:count]

    # Resolve server slugs for all ranked players.
    # characterRankings gives only server.id (+ native name); slug lookup via worldData.server(id).
    # Deduplicate server IDs and fetch in parallel; results are cached for the process lifetime.
    unique_sids = {(r.get("server") or {}).get("id") for r in rankings} - {None}
    sid_to_slugs = dict(zip(
        unique_sids,
        await asyncio.gather(*[_resolve_server_slug(wcl, sid) for sid in unique_sids])
    ))

    def _slugs_for(r: dict) -> tuple[str, str]:
        sid = (r.get("server") or {}).get("id")
        return sid_to_slugs.get(sid, ("", ""))

    # Fetch v2 talent keys for all ranked players in parallel.
    talent_keys = await asyncio.gather(*[
        _fetch_v2_talent(wcl, r.get("name", ""), *_slugs_for(r), encounter_id)
        for r in rankings
    ])

    result_rankings = []
    for i, (r, tk) in enumerate(zip(rankings, talent_keys)):
        ci = dict(r)
        if tk:
            # Inject v2 string directly; _extract_combatant_info handles str talents unchanged
            ci["talents"] = tk
        result_rankings.append({
            "rank": i + 1,
            "player": r.get("name"),
            "amount": round(r.get("amount", 0)),
            "duration_s": round(r.get("duration", 0) / 1000, 1),
            "report_code": (r.get("report") or {}).get("code"),
            "fight_id": (r.get("report") or {}).get("fightID"),
            "server": (r.get("server") or {}).get("name"),
            "combatant_info": ci,
        })

    return {
        "encounter_id": encounter_id,
        "encounter_name": enc["name"],
        "spec": spec,
        "rankings": result_rankings,
    }


def _find_burst_windows(
    damage_events: list[dict],
    fight_start_ms: float,
    window_ms: int = 8000,
    top_n: int = 4,
) -> list[dict]:
    """
    Find top N non-overlapping 8s burst windows by total damage dealt.
    Returns [{time_s, pct_of_total, active_cds}] sorted by fight time.
    """
    hits = sorted(
        (e["timestamp"], e.get("amount", 0) + e.get("absorbed", 0), e.get("targetID", 0))
        for e in damage_events
        if e.get("type") == "damage" and (e.get("amount", 0) + e.get("absorbed", 0)) > 0
    )
    if not hits:
        return []
    total = sum(d for _, d, _ in hits)
    if not total:
        return []

    # Build a parallel list of targetIDs for the window target-count pass
    hit_ts   = [h[0] for h in hits]
    hit_dmg  = [h[1] for h in hits]
    hit_tids = [h[2] for h in hits]

    n = len(hits)
    j = 0
    window_sum = 0
    candidates: list[tuple[float, float]] = []
    for i in range(n):
        while j < n and hit_ts[j] <= hit_ts[i] + window_ms:
            window_sum += hit_dmg[j]
            j += 1
        candidates.append((hit_ts[i], window_sum))
        window_sum -= hit_dmg[i]

    candidates.sort(key=lambda x: -x[1])
    selected: list[dict] = []
    for ts, dmg in candidates:
        if not any(abs(ts - (fight_start_ms + s["time_s"] * 1000)) < window_ms for s in selected):
            # Count unique targets hit in this window
            t_end = ts + window_ms
            targets = {hit_tids[k] for k in range(n) if ts <= hit_ts[k] <= t_end and hit_tids[k]}
            selected.append({
                "time_s": round((ts - fight_start_ms) / 1000, 1),
                "pct_of_total": round(dmg / total, 3),
                "active_cds": [],
                "target_count": len(targets) if targets else 1,
            })
        if len(selected) >= top_n:
            break

    return sorted(selected, key=lambda s: s["time_s"])


async def analyze_parse(
    wcl: WCLClient,
    spec: str,
    report_code: str,
    fight_id: int,
    player_name: Optional[str] = None,
    combatant_info: Optional[dict] = None,
) -> Optional[dict]:
    """
    For a single top-parse entry, fetch the player's cast events and return
    cooldown timing summary (first cast, BL alignment, total uses).
    """
    # Get fight info + player actor
    try:
        meta = await wcl.query(_REPORT_META_QUERY, {"code": report_code})
    except Exception:
        return None

    report = meta["reportData"]["report"]
    fight = next(
        (f for f in report["fights"] if f["id"] == fight_id), None
    )
    if not fight:
        return None

    actors = report["masterData"]["actors"]
    # Match by name first (rankings give us the exact player name), fall back to first subType match
    if player_name:
        player = next((a for a in actors if a.get("name") == player_name), None)
        if player is None:
            player = next((a for a in actors if a.get("subType") == spec), None)
    else:
        player = next((a for a in actors if a.get("subType") == spec), None)
    if not player:
        return None

    start, end = fight["startTime"], fight["endTime"]
    fight_dur_s = (end - start) / 1000

    # Fetch cast events for this player
    try:
        cast_events = await wcl.get_all_events(
            report_code, fight_id, "Casts", start, end, source_id=player["id"]
        )
        buff_events = await wcl.get_all_events(
            report_code, fight_id, "Buffs", start, end, target_id=player["id"]
        )
        damage_events = await wcl.get_all_events(
            report_code, fight_id, "DamageDone", start, end, source_id=player["id"]
        )
    except Exception:
        return None

    # Detect Bloodlust
    bl_time_s: Optional[float] = None
    for e in buff_events:
        if e.get("type") == "applybuff" and e.get("abilityGameID") in BLOODLUST_SPELL_IDS:
            bl_time_s = (e["timestamp"] - start) / 1000
            break

    spec_cds = db.get_spec_cooldowns(spec) or []
    cd_summary: list[dict] = []

    for cd in spec_cds:
        cd_casts = [
            c for c in cast_events
            if c.get("type") == "cast" and c.get("abilityGameID") == cd["spell_id"]
        ]
        cd_casts.sort(key=lambda e: e["timestamp"])

        cast_times_s = [(c["timestamp"] - start) / 1000 for c in cd_casts]
        first_cast_s = cast_times_s[0] if cast_times_s else None
        bl_aligned = False
        bl_offset_s = None
        if bl_time_s is not None and cast_times_s:
            for t in cast_times_s:
                if bl_time_s - 30 <= t <= bl_time_s + 55:
                    bl_aligned = True
                    break
            # Record offset of the BL-window cast closest to BL start (negative = before BL)
            window_offsets = [t - bl_time_s for t in cast_times_s if bl_time_s - 30 <= t <= bl_time_s + 55]
            if window_offsets:
                bl_offset_s = round(min(window_offsets, key=abs), 1)

        # Hold pattern: compare actual cast times to expected on-cooldown times
        hold_windows: list[dict] = []
        if len(cast_times_s) > 1:
            cd_seconds = cd.get("cooldown", 90)
            expected_t = cast_times_s[0]
            for k in range(1, len(cast_times_s)):
                expected_t += cd_seconds
                actual = cast_times_s[k]
                hold_amount = actual - expected_t
                if hold_amount > 8.0:
                    hold_windows.append({
                        "cast_index": k + 1,
                        "expected_s": round(expected_t, 1),
                        "actual_s": round(actual, 1),
                        "hold_amount_s": round(hold_amount, 1),
                    })
        cast_pattern = "hold" if hold_windows else "on_cooldown"

        cd_summary.append(
            {
                "name": cd["name"],
                "spell_id": cd["spell_id"],
                "total_uses": len(cd_casts),
                "first_cast_s": round(first_cast_s, 1) if first_cast_s is not None else None,
                "bl_aligned": bl_aligned,
                "bl_offset_s": bl_offset_s,
                "cast_times_s": [round(t, 2) for t in cast_times_s],
                "hold_windows": hold_windows,
                "cast_pattern": cast_pattern,
            }
        )

    # Cast efficiency — store full sorted gap list so main.py can derive the threshold
    completed = sorted(
        [e for e in cast_events if e.get("type") == "cast"],
        key=lambda e: e["timestamp"],
    )
    cast_eff_pct: Optional[float] = None
    cast_gap_list_ms: list[int] = []
    if len(completed) >= 2 and fight_dur_s > 0:
        cast_gap_list_ms = sorted([
            int(completed[i]["timestamp"] - completed[i - 1]["timestamp"])
            for i in range(1, len(completed))
        ])
        # Keep stored efficiency at 1500ms for backward-compatibility;
        # main.py recomputes it at the derived threshold when cast_gap_list_ms is present.
        downtime_ms = sum(g for g in cast_gap_list_ms if g > 1500)
        cast_eff_pct = round(max(0.0, (1 - downtime_ms / 1000 / fight_dur_s) * 100), 1)

    # Burst windows — top non-overlapping 8s damage peaks
    burst_windows = _find_burst_windows(damage_events, start)
    for bw in burst_windows:
        bw_t = bw["time_s"]
        active: list[str] = []
        for cd_entry in cd_summary:
            cd_def = next((c for c in spec_cds if c["name"] == cd_entry["name"]), {})
            dur = cd_def.get("duration") or 0
            if dur > 0:
                for t in cd_entry["cast_times_s"]:
                    if t <= bw_t <= t + dur:
                        active.append(cd_entry["name"])
                        break
        bw["active_cds"] = active

    gear_data = _extract_combatant_info(combatant_info) if combatant_info else {}

    return {
        "player": player["name"],
        "spec": spec,
        "fight_duration_s": round(fight_dur_s, 1),
        "bloodlust_s": round(bl_time_s, 1) if bl_time_s is not None else None,
        "cast_efficiency_pct": cast_eff_pct,
        "cast_gap_list_ms": cast_gap_list_ms,
        "cooldowns": cd_summary,
        "burst_windows": burst_windows,
        "talent_key": gear_data.get("talent_key", ""),
        "trinkets": gear_data.get("trinkets", []),
        "enchants": gear_data.get("enchants", []),
    }


def build_parse_context(parse_results: list[dict]) -> str:
    """
    Convert a list of per-parse cooldown summaries into a human-readable
    text block suitable for inclusion in the LLM guide-ingestion prompt.
    """
    if not parse_results:
        return ""

    lines = [f"Top {len(parse_results)} parse analysis:"]

    # Aggregate per cooldown
    from collections import defaultdict
    agg: dict[str, list] = defaultdict(list)
    for pr in parse_results:
        for cd in pr.get("cooldowns", []):
            agg[cd["name"]].append(cd)

    for cd_name, entries in agg.items():
        first_casts = [e["first_cast_s"] for e in entries if e.get("first_cast_s") is not None]
        bl_count = sum(1 for e in entries if e.get("bl_aligned"))
        uses = [e["total_uses"] for e in entries]
        avg_first = round(sum(first_casts) / len(first_casts), 1) if first_casts else "n/a"
        avg_uses = round(sum(uses) / len(uses), 1) if uses else "n/a"
        bl_pct = round(bl_count / len(entries) * 100) if entries else 0

        lines.append(
            f"- {cd_name}: avg first cast at {avg_first}s | "
            f"avg {avg_uses} uses/fight | "
            f"{bl_pct}% BL-aligned"
        )

    return "\n".join(lines)
