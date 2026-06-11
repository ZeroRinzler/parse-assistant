#!/usr/bin/env python3
"""
Export existing SQLite rulebooks and guide metadata to data/specs/ JSON files.
Run once to bootstrap the file-based storage from an existing warcraft.db.

    python3 scripts/export_data_files.py
"""
import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

import aiosqlite

DB_PATH   = ROOT / "data" / "warcraft.db"
SPECS_DIR = ROOT / "data" / "specs"


async def main() -> None:
    if not DB_PATH.exists():
        print(f"DB not found: {DB_PATH}")
        return

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        # Export rulebooks
        async with db.execute("SELECT spec, rulebook FROM generated_rulebooks") as cur:
            rows = await cur.fetchall()

        for row in rows:
            spec = row["spec"]
            try:
                rulebook = json.loads(row["rulebook"])
            except Exception as e:
                print(f"  SKIP {spec} rulebook (parse error): {e}")
                continue
            out = SPECS_DIR / spec / "rulebook.json"
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(json.dumps(rulebook, indent=2, ensure_ascii=False))
            print(f"  rulebook -> {out.relative_to(ROOT)}")

        # Export guide metadata (no content)
        async with db.execute(
            "SELECT DISTINCT spec FROM guides ORDER BY spec"
        ) as cur:
            specs = [r[0] async for r in cur]

        for spec in specs:
            async with db.execute(
                "SELECT id, spec, title, url, guide_type, word_count, status, error_msg, created_at, updated_at "
                "FROM guides WHERE spec=? ORDER BY created_at DESC",
                (spec,),
            ) as cur:
                guides = [dict(r) async for r in cur]
            out = SPECS_DIR / spec / "guides.json"
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(json.dumps(guides, indent=2, ensure_ascii=False))
            print(f"  guides   -> {out.relative_to(ROOT)}")

    print("Done.")


if __name__ == "__main__":
    asyncio.run(main())
