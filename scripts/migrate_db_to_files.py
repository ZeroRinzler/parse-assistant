#!/usr/bin/env python3
"""
One-time migration: extract SQLite data to file-based storage.

Exports:
  - guides WITH content  → data/specs/{spec}/guides.json
  - parse_samples        → data/specs/{spec}/parse_samples/{enc_id}.json
  - encounter bench files (re-synced with new top_dtk_comparison + sample_count per CD)

Run once before deploying the file-based storage:
    python3 scripts/migrate_db_to_files.py
"""
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

DB_PATH = ROOT / "data" / "warcraft.db"
SPECS_DIR = ROOT / "data" / "specs"


def main():
    if not DB_PATH.exists():
        print(f"DB not found: {DB_PATH}")
        return

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    # Export guides WITH content
    rows = conn.execute(
        "SELECT id, spec, title, url, guide_type, content, word_count, "
        "status, error_msg, created_at, updated_at FROM guides ORDER BY spec, created_at DESC"
    ).fetchall()
    guides_by_spec: dict = {}
    for row in rows:
        d = dict(row)
        guides_by_spec.setdefault(d["spec"], []).append(d)

    for spec, guides in guides_by_spec.items():
        out = SPECS_DIR / spec / "guides.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(guides, indent=2, ensure_ascii=False))
        print(f"  guides -> {out.relative_to(ROOT)} ({len(guides)} guides, content included)")

    # Export parse samples
    rows = conn.execute(
        "SELECT spec, encounter_id, encounter_name, report_code, fight_id, player_name, "
        "cooldown_data, sampled_at FROM parse_samples ORDER BY spec, encounter_id"
    ).fetchall()
    samples_by_enc: dict = {}
    for row in rows:
        d = dict(row)
        try:
            d["cooldown_data"] = json.loads(d["cooldown_data"] or "{}")
        except Exception:
            d["cooldown_data"] = {}
        key = (d["spec"], d["encounter_id"])
        samples_by_enc.setdefault(key, []).append(d)

    for (spec, enc_id), samples in sorted(samples_by_enc.items()):
        out_dir = SPECS_DIR / spec / "parse_samples"
        out_dir.mkdir(parents=True, exist_ok=True)
        out = out_dir / f"{enc_id}.json"
        out.write_text(json.dumps(samples, indent=2, ensure_ascii=False))
        print(f"  samples -> {out.relative_to(ROOT)} ({len(samples)} samples)")

    conn.close()

    # Re-sync all encounter files using the new store module
    # (adds top_dtk_comparison and sample_count per CD to encounter files)
    import store
    store.init_store()
    for spec_dir in sorted(SPECS_DIR.iterdir()):
        if not spec_dir.is_dir():
            continue
        samples_dir = spec_dir / "parse_samples"
        if not samples_dir.exists():
            continue
        for sf in sorted(samples_dir.glob("*.json")):
            enc_id = int(sf.stem)
            store.sync_encounter_file(spec_dir.name, enc_id)
            print(f"  encounter -> {spec_dir.name}/encounters/{enc_id}.json (re-synced)")

    print("\nMigration complete.")
    print("You can now delete data/warcraft.db and db.py after verifying the server works.")


if __name__ == "__main__":
    main()
