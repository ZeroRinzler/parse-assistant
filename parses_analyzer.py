"""
Fetch top WCL parses for a spec+encounter and extract cooldown timing patterns.
"""
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
        includeCombatantInfo: false
      )
    }
  }
}
"""

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

    return {
        "encounter_id": encounter_id,
        "encounter_name": enc["name"],
        "spec": spec,
        "rankings": [
            {
                "rank": i + 1,
                "player": r.get("name"),
                "amount": round(r.get("amount", 0)),
                "duration_s": round(r.get("duration", 0) / 1000, 1),
                "report_code": (r.get("report") or {}).get("code"),
                "fight_id": (r.get("report") or {}).get("fightID"),
                "server": (r.get("server") or {}).get("name"),
            }
            for i, r in enumerate(rankings)
        ],
    }


async def analyze_parse(
    wcl: WCLClient,
    spec: str,
    report_code: str,
    fight_id: int,
    player_name: Optional[str] = None,
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

        first_cast_s = (cd_casts[0]["timestamp"] - start) / 1000 if cd_casts else None
        bl_aligned = False
        if bl_time_s is not None and cd_casts:
            for c in cd_casts:
                t = (c["timestamp"] - start) / 1000
                if bl_time_s - 30 <= t <= bl_time_s + 55:
                    bl_aligned = True
                    break

        cd_summary.append(
            {
                "name": cd["name"],
                "spell_id": cd["spell_id"],
                "total_uses": len(cd_casts),
                "first_cast_s": round(first_cast_s, 1) if first_cast_s is not None else None,
                "bl_aligned": bl_aligned,
            }
        )

    return {
        "player": player["name"],
        "spec": spec,
        "fight_duration_s": round(fight_dur_s, 1),
        "bloodlust_s": round(bl_time_s, 1) if bl_time_s is not None else None,
        "cooldowns": cd_summary,
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
