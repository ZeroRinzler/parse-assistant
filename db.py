"""
SQLite persistence for guides, generated rulebooks, and parse samples.
Also owns the in-memory rulebook cache used by the analyzer at runtime.
"""
import json
import statistics
from collections import defaultdict
from pathlib import Path
from typing import Optional

import aiosqlite

from rulebook import SPEC_COOLDOWNS

DB_PATH   = Path(__file__).parent / "data" / "warcraft.db"
SPECS_DIR = Path(__file__).parent / "data" / "specs"


def _write_spec_file(spec: str, filename: str, data: object) -> None:
    """Write JSON to data/specs/{spec}/{filename}. Best-effort — never raises."""
    try:
        p = SPECS_DIR / spec
        p.mkdir(parents=True, exist_ok=True)
        (p / filename).write_text(json.dumps(data, indent=2, ensure_ascii=False))
    except Exception:
        pass

_DDL = """
CREATE TABLE IF NOT EXISTS guides (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    spec        TEXT NOT NULL,
    title       TEXT,
    url         TEXT NOT NULL,
    guide_type  TEXT NOT NULL DEFAULT 'web',   -- 'web' | 'youtube'
    content     TEXT,
    word_count  INTEGER,
    status      TEXT NOT NULL DEFAULT 'pending', -- pending | scraped | error
    error_msg   TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS generated_rulebooks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    spec          TEXT NOT NULL UNIQUE,
    rulebook      TEXT NOT NULL,           -- JSON blob
    guide_count   INTEGER DEFAULT 0,
    parse_count   INTEGER DEFAULT 0,
    generated_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS parse_samples (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    spec           TEXT NOT NULL,
    encounter_id   INTEGER NOT NULL,
    encounter_name TEXT,
    report_code    TEXT NOT NULL,
    fight_id       INTEGER NOT NULL,
    player_name    TEXT,
    cooldown_data  TEXT,                   -- JSON blob
    sampled_at     TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS spell_icons (
    spell_id  INTEGER PRIMARY KEY,
    icon      TEXT NOT NULL,
    name      TEXT,
    cached_at TEXT DEFAULT (datetime('now'))
);
"""

# ── In-memory rulebook cache ─────────────────────────────────────────────────
# Populated from DB on startup; updated when a new rulebook is generated.
_rulebook_cache: dict[str, dict] = {}


def get_spec_cooldowns(spec: str) -> Optional[list[dict]]:
    """Return major_cooldowns for spec.  Dynamic rulebook takes precedence."""
    if spec in _rulebook_cache:
        cds = _rulebook_cache[spec].get("major_cooldowns")
        if cds:
            return cds
    return SPEC_COOLDOWNS.get(spec)


def get_cached_rulebook(spec: str) -> Optional[dict]:
    return _rulebook_cache.get(spec)


def set_cached_rulebook(spec: str, rulebook: dict) -> None:
    _rulebook_cache[spec] = rulebook


# ── DB helpers ───────────────────────────────────────────────────────────────

def _conn() -> aiosqlite.Connection:
    return aiosqlite.connect(DB_PATH)


async def init_db() -> None:
    DB_PATH.parent.mkdir(exist_ok=True)
    async with _conn() as db:
        await db.executescript(_DDL)
        # Migration: add name column to spell_icons if it was created without it
        try:
            await db.execute("ALTER TABLE spell_icons ADD COLUMN name TEXT")
            await db.commit()
        except Exception:
            pass  # column already exists
        await db.commit()

    # Warm the in-memory cache from persisted rulebooks
    await _reload_cache()


async def _reload_cache() -> None:
    async with _conn() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT spec, rulebook FROM generated_rulebooks"
        ) as cur:
            async for row in cur:
                try:
                    _rulebook_cache[row["spec"]] = json.loads(row["rulebook"])
                except Exception:
                    pass


# ── Encounter file sync ───────────────────────────────────────────────────────

async def sync_encounter_file(spec: str, encounter_id: int) -> None:
    """
    Read fresh samples for this encounter from the DB and write a pre-computed
    data/specs/{spec}/encounters/{encounter_id}.json.

    The file contains bench stats (per-CD thresholds, burst windows, gear) so
    the server can serve them directly and they can be committed to the repo.
    """
    samples = await get_parse_samples(spec, encounter_id)
    if not samples:
        return

    enc_name = samples[0].get("encounter_name", "")

    # ── Efficiency ────────────────────────────────────────────────────────────
    all_gaps_ms: list[int] = []
    for s in samples:
        all_gaps_ms.extend((s.get("cooldown_data") or {}).get("cast_gap_list_ms") or [])
    downtime_threshold_ms = 1500.0
    if all_gaps_ms:
        all_gaps_ms.sort()
        p90_idx = max(0, int(0.90 * len(all_gaps_ms)) - 1)
        downtime_threshold_ms = float(all_gaps_ms[p90_idx])

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
            if (s.get("cooldown_data") or {}).get("cast_efficiency_pct") is not None
        ]
    top_avg_efficiency = round(statistics.mean(eff_vals), 1) if eff_vals else None
    top_efficiency_stddev = round(statistics.stdev(eff_vals), 1) if len(eff_vals) > 1 else None

    # ── Per-CD benchmarks ─────────────────────────────────────────────────────
    agg: dict[str, list] = defaultdict(list)
    for s in samples:
        cd_data = s.get("cooldown_data") or {}
        fight_dur = cd_data.get("fight_duration_s", 0)
        for cd in cd_data.get("cooldowns", []):
            agg[cd["name"]].append({**cd, "fight_duration_s": fight_dur})

    per_cd_benchmarks: dict = {}
    for cd_name, entries in agg.items():
        top_first_casts = [e["first_cast_s"] for e in entries if e.get("first_cast_s") is not None]
        all_cd_gaps: list[float] = []
        for e in entries:
            times = e.get("cast_times_s", [])
            for j in range(1, len(times)):
                all_cd_gaps.append(times[j] - times[j - 1])
        bl_offsets = [e["bl_offset_s"] for e in entries if e.get("bl_offset_s") is not None]

        hold_by_cast_idx: dict[int, list[float]] = defaultdict(list)
        for e in entries:
            for hw in e.get("hold_windows", []):
                hold_by_cast_idx[hw["cast_index"]].append(hw["actual_s"])
        hold_targets: dict = {}
        for cast_idx, times in hold_by_cast_idx.items():
            if len(times) >= max(2, len(entries) * 0.4):
                hold_targets[str(cast_idx)] = {
                    "target_s": round(statistics.median(times), 1),
                    "stddev_s": round(statistics.stdev(times) if len(times) > 1 else 20.0, 1),
                    "count": len(times),
                    "total_samples": len(entries),
                }

        upm_list = [
            e["total_uses"] / (e["fight_duration_s"] / 60)
            for e in entries if e.get("fight_duration_s")
        ]
        bl_count = sum(1 for e in entries if e.get("bl_aligned"))

        per_cd_benchmarks[cd_name] = {
            "avg_first_cast_s": round(statistics.mean(top_first_casts), 1) if top_first_casts else None,
            "stddev_first_cast_s": round(statistics.stdev(top_first_casts), 1) if len(top_first_casts) > 1 else None,
            "avg_gap_s": round(statistics.mean(all_cd_gaps), 1) if all_cd_gaps else None,
            "stddev_gap_s": round(statistics.stdev(all_cd_gaps), 1) if len(all_cd_gaps) > 1 else None,
            "avg_bl_offset_s": round(statistics.mean(bl_offsets), 1) if bl_offsets else None,
            "stddev_bl_offset_s": round(statistics.stdev(bl_offsets), 1) if len(bl_offsets) > 1 else None,
            "hold_targets": hold_targets,
            "uses_per_min": _bench_uses_per_min(entries),
            # Brief display fields
            "avg_uses": round(statistics.mean([e.get("total_uses", 0) for e in entries]), 1) if entries else 0,
            "avg_uses_per_min": round(statistics.mean(upm_list), 2) if upm_list else None,
            "bl_pct": round(bl_count / len(entries) * 100) if entries else 0,
            "majority_hold": sum(1 for e in entries if e.get("cast_pattern") == "hold") > len(entries) * 0.5,
        }

    # ── Duration ──────────────────────────────────────────────────────────────
    durations = [
        (s.get("cooldown_data") or {}).get("fight_duration_s")
        for s in samples
    ]
    durations = [d for d in durations if d]
    avg_duration_s = round(statistics.mean(durations), 1) if durations else None

    # ── Burst windows ─────────────────────────────────────────────────────────
    from analysis_utils import cluster_burst_windows, aggregate_gear
    all_bw: list[dict] = []
    for s in samples:
        for bw in (s.get("cooldown_data") or {}).get("burst_windows", []):
            all_bw.append(bw)
    burst_windows = cluster_burst_windows(all_bw, len(samples)) if all_bw else []

    # ── Gear ──────────────────────────────────────────────────────────────────
    gear = aggregate_gear(samples)

    out = {
        "spec": spec,
        "encounter_id": encounter_id,
        "encounter_name": enc_name,
        "sample_count": len(samples),
        "avg_duration_s": avg_duration_s,
        "downtime_threshold_ms": round(downtime_threshold_ms),
        "top_avg_efficiency": top_avg_efficiency,
        "top_efficiency_stddev": top_efficiency_stddev,
        "per_cd_benchmarks": per_cd_benchmarks,
        "burst_windows": burst_windows,
        "gear": gear,
    }
    enc_dir = SPECS_DIR / spec / "encounters"
    try:
        enc_dir.mkdir(parents=True, exist_ok=True)
        (enc_dir / f"{encounter_id}.json").write_text(
            json.dumps(out, indent=2, ensure_ascii=False)
        )
        # Keep a per-spec index of which encounters have data for static clients
        _sync_encounters_index(spec, enc_dir)
    except Exception:
        pass


def _sync_encounters_index(spec: str, enc_dir) -> None:
    """Write data/specs/{spec}/encounters.json — a list of {id, name, sample_count}."""
    entries = []
    for p in sorted(enc_dir.glob("*.json")):
        try:
            d = json.loads(p.read_text())
            entries.append({
                "id": d.get("encounter_id", int(p.stem)),
                "name": d.get("encounter_name", p.stem),
                "sample_count": d.get("sample_count", 0),
            })
        except Exception:
            pass
    try:
        (enc_dir.parent / "encounters.json").write_text(
            json.dumps(entries, indent=2, ensure_ascii=False)
        )
    except Exception:
        pass


def _bench_uses_per_min(entries: list[dict]) -> dict:
    """Compute avg/stddev uses-per-minute for a CD across parse entries."""
    upms = []
    for e in entries:
        dur = e.get("fight_duration_s") or 0
        times = e.get("cast_times_s") or []
        if dur > 0 and times:
            upms.append(round(len(times) / dur * 60, 3))
    if not upms:
        return {}
    return {
        "avg": round(statistics.mean(upms), 3),
        "stddev": round(statistics.stdev(upms), 3) if len(upms) > 1 else 0.0,
        "min": min(upms),
        "max": max(upms),
    }


# ── Guide CRUD ────────────────────────────────────────────────────────────────

async def _sync_guides_file(spec: str) -> None:
    """Rewrite data/specs/{spec}/guides.json from DB (no content field — keeps file readable)."""
    guides = await get_guides(spec)
    slim = [{k: v for k, v in g.items() if k != "content"} for g in guides]
    _write_spec_file(spec, "guides.json", slim)


async def add_guide(spec: str, url: str, guide_type: str) -> int:
    async with _conn() as db:
        cur = await db.execute(
            "INSERT OR IGNORE INTO guides (spec, url, guide_type) VALUES (?,?,?)",
            (spec, url, guide_type),
        )
        await db.commit()
        if cur.lastrowid:
            await _sync_guides_file(spec)
            return cur.lastrowid
        # Already exists — return existing id
        async with db.execute(
            "SELECT id FROM guides WHERE url=?", (url,)
        ) as c:
            row = await c.fetchone()
            return row[0]


async def get_guides(spec: str) -> list[dict]:
    async with _conn() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM guides WHERE spec=? ORDER BY created_at DESC", (spec,)
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def get_guide(guide_id: int) -> Optional[dict]:
    async with _conn() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM guides WHERE id=?", (guide_id,)
        ) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def update_guide_content(
    guide_id: int, title: str, content: str, word_count: int, spec: str = ""
) -> None:
    async with _conn() as db:
        await db.execute(
            """UPDATE guides SET title=?, content=?, word_count=?,
               status='scraped', error_msg=NULL,
               updated_at=datetime('now')
               WHERE id=?""",
            (title, content, word_count, guide_id),
        )
        await db.commit()
    if spec:
        await _sync_guides_file(spec)


async def update_guide_error(guide_id: int, error_msg: str, spec: str = "") -> None:
    async with _conn() as db:
        await db.execute(
            """UPDATE guides SET status='error', error_msg=?,
               updated_at=datetime('now') WHERE id=?""",
            (error_msg, guide_id),
        )
        await db.commit()
    if spec:
        await _sync_guides_file(spec)


async def delete_guide(guide_id: int, spec: str = "") -> None:
    async with _conn() as db:
        await db.execute("DELETE FROM guides WHERE id=?", (guide_id,))
        await db.commit()
    if spec:
        await _sync_guides_file(spec)


# ── Rulebook CRUD ─────────────────────────────────────────────────────────────

async def save_rulebook(
    spec: str, rulebook: dict, guide_count: int, parse_count: int = 0
) -> None:
    blob = json.dumps(rulebook)
    async with _conn() as db:
        await db.execute(
            """INSERT INTO generated_rulebooks (spec, rulebook, guide_count, parse_count)
               VALUES (?,?,?,?)
               ON CONFLICT(spec) DO UPDATE SET
                 rulebook=excluded.rulebook,
                 guide_count=excluded.guide_count,
                 parse_count=excluded.parse_count,
                 generated_at=datetime('now')""",
            (spec, blob, guide_count, parse_count),
        )
        await db.commit()
    set_cached_rulebook(spec, rulebook)
    _write_spec_file(spec, "rulebook.json", rulebook)


async def get_rulebook_row(spec: str) -> Optional[dict]:
    async with _conn() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM generated_rulebooks WHERE spec=?", (spec,)
        ) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


# ── Parse samples CRUD ────────────────────────────────────────────────────────

async def clear_parse_samples(spec: str, encounter_id: int) -> None:
    async with _conn() as db:
        await db.execute(
            "DELETE FROM parse_samples WHERE spec=? AND encounter_id=?",
            (spec, encounter_id),
        )
        await db.commit()


async def save_parse_sample(
    spec: str,
    encounter_id: int,
    encounter_name: str,
    report_code: str,
    fight_id: int,
    player_name: str,
    cooldown_data: dict,
) -> None:
    async with _conn() as db:
        await db.execute(
            """INSERT OR REPLACE INTO parse_samples
               (spec, encounter_id, encounter_name, report_code,
                fight_id, player_name, cooldown_data)
               VALUES (?,?,?,?,?,?,?)""",
            (
                spec, encounter_id, encounter_name, report_code,
                fight_id, player_name, json.dumps(cooldown_data),
            ),
        )
        await db.commit()


async def get_parse_stats(spec: str) -> dict:
    """Per-encounter sample count and last ingested timestamp for a spec."""
    async with _conn() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT encounter_id, encounter_name,
                      COUNT(*) AS sample_count,
                      MAX(sampled_at) AS last_ingested
               FROM parse_samples WHERE spec=?
               GROUP BY encounter_id""",
            (spec,),
        ) as cur:
            result: dict = {}
            async for row in cur:
                result[row["encounter_id"]] = {
                    "encounter_name": row["encounter_name"],
                    "sample_count": row["sample_count"],
                    "last_ingested": row["last_ingested"],
                }
            return result


async def get_parse_samples(spec: str, encounter_id: int) -> list[dict]:
    async with _conn() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT * FROM parse_samples
               WHERE spec=? AND encounter_id=?
               ORDER BY sampled_at DESC""",
            (spec, encounter_id),
        ) as cur:
            rows = await cur.fetchall()
            result = []
            for r in rows:
                d = dict(r)
                d["cooldown_data"] = json.loads(d["cooldown_data"] or "{}")
                result.append(d)
            return result


async def list_specs_with_samples() -> list[str]:
    """Return distinct spec names that have at least one parse sample."""
    async with _conn() as db:
        async with db.execute(
            "SELECT DISTINCT spec FROM parse_samples ORDER BY spec"
        ) as cur:
            return [row[0] async for row in cur]


# ── Spell icon cache ──────────────────────────────────────────────────────────

async def get_cached_spell_icons(spell_ids: list[int]) -> dict[int, dict]:
    """Return {spell_id: {icon, name}} for cached entries."""
    if not spell_ids:
        return {}
    placeholders = ",".join("?" * len(spell_ids))
    async with _conn() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            f"SELECT spell_id, icon, name FROM spell_icons WHERE spell_id IN ({placeholders})",
            spell_ids,
        ) as cur:
            return {row["spell_id"]: {"icon": row["icon"], "name": row["name"] or ""} async for row in cur}


