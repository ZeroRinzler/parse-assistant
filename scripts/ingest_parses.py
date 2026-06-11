#!/usr/bin/env python3
"""
Ingest top WCL parse samples for one or all specs.

Used by:
  - GitHub Actions  (daily schedule — see .github/workflows/ingest-parses.yml)
  - Local dev       (python3 scripts/ingest_parses.py --spec SubtletyRogue)

WCL_CLIENT_ID and WCL_CLIENT_SECRET must be set (via .env or environment).
"""
import argparse
import asyncio
import re
import sys
from pathlib import Path

# Allow running from the repo root or from scripts/
sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv
load_dotenv()

import db
from parses_analyzer import get_encounters, fetch_top_rankings, analyze_parse
from wcl_client import WCLClient

_EXCLUDE = re.compile(r"beta|ptr|mythic\+|complete raids|delves|torghast", re.IGNORECASE)


async def ingest_spec(wcl: WCLClient, spec: str, top_n: int = 10) -> int:
    """Ingest all current-expansion bosses for one spec. Returns number of samples saved."""
    encounters = await get_encounters(wcl)
    live = [e for e in encounters if not _EXCLUDE.search(e.get("zone", ""))]
    current_exp = next((e["expansion"] for e in live if e.get("expansion")), None)
    if not current_exp:
        print(f"  [!] Could not determine current expansion", flush=True)
        return 0

    current = [e for e in live if e["expansion"] == current_exp]
    print(f"  Expansion: {current_exp}, bosses: {len(current)}", flush=True)

    total_saved = 0
    for enc in current:
        enc_id, enc_name = enc["id"], enc["name"]
        print(f"  Boss: {enc_name} (id={enc_id})", end="", flush=True)
        try:
            result = await fetch_top_rankings(wcl, spec, enc_id, top_n)
        except Exception as exc:
            print(f"  ERROR: {exc}", flush=True)
            continue

        rankings = result.get("rankings") or []
        await db.clear_parse_samples(spec, enc_id)
        boss_saved = 0
        for r in rankings:
            code = r.get("report_code")
            fight_id = r.get("fight_id")
            if not code or not fight_id:
                continue
            try:
                summary = await analyze_parse(
                    wcl, spec, code, fight_id,
                    player_name=r.get("player"),
                    combatant_info=r.get("combatant_info"),
                )
            except Exception as exc:
                print(f"\n    skip {r.get('player')}: {exc}", flush=True)
                continue
            if summary:
                await db.save_parse_sample(
                    spec=spec,
                    encounter_id=enc_id,
                    encounter_name=enc_name,
                    report_code=code,
                    fight_id=fight_id,
                    player_name=summary["player"],
                    cooldown_data=summary,
                )
                boss_saved += 1
        total_saved += boss_saved
        if boss_saved:
            await db.sync_encounter_file(spec, enc_id)
        print(f" → {boss_saved}/{len(rankings)} saved", flush=True)

    return total_saved


async def main(specs: list[str], top_n: int = 10):
    await db.init_db()
    wcl = WCLClient()

    if not specs:
        # Default: ingest all specs that currently have any parse samples
        all_samples = await db.list_specs_with_samples()
        specs = all_samples or []
        if not specs:
            print("No specs with existing samples found. Pass --spec <SpecName> to start.", flush=True)
            return

    for spec in specs:
        print(f"\n=== {spec} ===", flush=True)
        try:
            n = await ingest_spec(wcl, spec, top_n)
            print(f"  Total saved: {n}", flush=True)
        except Exception as exc:
            print(f"  FAILED: {exc}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Ingest WCL top parse samples")
    grp = parser.add_mutually_exclusive_group()
    grp.add_argument("--spec", help="Single spec to ingest, e.g. SubtletyRogue")
    grp.add_argument("--all", action="store_true", help="Ingest all specs with existing data")
    grp.add_argument("--list-specs", action="store_true", help="List specs with existing data")
    parser.add_argument("--top-n", type=int, default=10, help="Number of top parses per boss (default: 10)")
    args = parser.parse_args()

    async def _list():
        await db.init_db()
        specs = await db.list_specs_with_samples()
        for s in (specs or []):
            print(s)

    if args.list_specs:
        asyncio.run(_list())
    else:
        specs = [args.spec] if args.spec else []
        asyncio.run(main(specs, top_n=args.top_n))
