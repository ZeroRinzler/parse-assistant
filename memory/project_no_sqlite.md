---
name: project-no-sqlite
description: Storage is now 100% file-based (store.py); db.py and warcraft.db deleted in 2026-06-11 refactor
metadata:
  type: project
---

All SQLite/aiosqlite removed. `store.py` replaced `db.py` as the single storage layer.

**Why:** User wanted one clean path — no dual-write, no SQLite fallback, everything in git-tracked JSON files.

**How to apply:** Never suggest SQLite or aiosqlite. All persistent data lives under `data/specs/{spec}/`. Storage functions in `store.py` are synchronous (file I/O, no async needed). Encounter bench files are pre-computed at ingest time and read directly at analysis time — no on-the-fly aggregation from raw samples.

**New file structure:**
- `data/specs/{spec}/guides.json` — guide list WITH scraped content (previously stripped)
- `data/specs/{spec}/parse_samples/{enc_id}.json` — raw parse samples (source of truth)
- `data/specs/{spec}/encounters/{enc_id}.json` — pre-computed bench (expanded with `top_dtk_comparison`, `last_ingested`, `sample_count` per CD)
- `data/specs/{spec}/rulebook.json` — rulebook with `guide_count` + `saved_at` metadata

**Deleted:** `db.py`, `scripts/export_data_files.py`, `data/warcraft.db`

**Migration:** `scripts/migrate_db_to_files.py` was used once to export from SQLite; keep it for reference but it won't be needed again.
