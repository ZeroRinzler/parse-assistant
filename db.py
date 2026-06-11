"""
SQLite persistence for guides, generated rulebooks, and parse samples.
Also owns the in-memory rulebook cache used by the analyzer at runtime.
"""
import json
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


