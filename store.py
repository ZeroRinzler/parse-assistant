"""
File-based storage for guides, rulebooks, and parse samples.
Owns the in-memory rulebook cache used by the analyzer at runtime.
No SQLite dependency - all data lives under data/specs/.
"""
import json
import statistics
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from rulebook import SPEC_COOLDOWNS, SPEC_DEFENSIVES

SPECS_DIR = Path(__file__).parent / "data" / "specs"

# ── In-memory rulebook cache ──────────────────────────────────────────────────
_rulebook_cache: dict[str, dict] = {}


def init_store() -> None:
    """Load all rulebooks from files into memory cache on startup."""
    if not SPECS_DIR.exists():
        return
    for spec_dir in SPECS_DIR.iterdir():
        if not spec_dir.is_dir():
            continue
        rb_file = spec_dir / "rulebook.json"
        if rb_file.exists():
            try:
                _rulebook_cache[spec_dir.name] = json.loads(rb_file.read_text())
            except Exception:
                pass


# ── Rulebook ──────────────────────────────────────────────────────────────────

def get_spec_cooldowns(spec: str) -> Optional[list[dict]]:
    """Dynamic rulebook takes precedence over static fallback."""
    if spec in _rulebook_cache:
        cds = _rulebook_cache[spec].get("major_cooldowns")
        if cds:
            return cds
    return SPEC_COOLDOWNS.get(spec)


def get_cached_rulebook(spec: str) -> Optional[dict]:
    return _rulebook_cache.get(spec)


def set_cached_rulebook(spec: str, rulebook: dict) -> None:
    _rulebook_cache[spec] = rulebook


def save_rulebook(spec: str, rulebook: dict, guide_count: int = 0) -> None:
    rulebook = {**rulebook, "guide_count": guide_count, "saved_at": _now()}
    set_cached_rulebook(spec, rulebook)
    _write_spec_file(spec, "rulebook.json", rulebook)


def get_rulebook(spec: str) -> Optional[dict]:
    """Return stored rulebook dict including metadata fields (guide_count, saved_at)."""
    p = SPECS_DIR / spec / "rulebook.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


# ── Guides ────────────────────────────────────────────────────────────────────

def _guides_path(spec: str) -> Path:
    return SPECS_DIR / spec / "guides.json"


def get_guides(spec: str) -> list[dict]:
    p = _guides_path(spec)
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text())
    except Exception:
        return []


def get_guide(guide_id: int) -> Optional[dict]:
    """Find a guide by ID, searching across all spec directories."""
    if not SPECS_DIR.exists():
        return None
    for spec_dir in sorted(SPECS_DIR.iterdir()):
        if not spec_dir.is_dir():
            continue
        for g in get_guides(spec_dir.name):
            if g["id"] == guide_id:
                return g
    return None


def _save_guides(spec: str, guides: list[dict]) -> None:
    p = _guides_path(spec)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(guides, indent=2, ensure_ascii=False))


def add_guide(spec: str, url: str, guide_type: str) -> int:
    guides = get_guides(spec)
    existing = next((g for g in guides if g["url"] == url), None)
    if existing:
        return existing["id"]
    new_id = max((g["id"] for g in guides), default=0) + 1
    now = _now()
    guides.insert(0, {
        "id": new_id, "spec": spec, "title": None, "url": url,
        "guide_type": guide_type, "content": None, "word_count": None,
        "status": "pending", "error_msg": None,
        "created_at": now, "updated_at": now,
    })
    _save_guides(spec, guides)
    return new_id


def update_guide_content(guide_id: int, title: str, content: str, word_count: int, spec: str = "") -> None:
    if not spec:
        g = get_guide(guide_id)
        spec = g["spec"] if g else ""
    guides = get_guides(spec)
    for g in guides:
        if g["id"] == guide_id:
            g.update({
                "title": title, "content": content, "word_count": word_count,
                "status": "scraped", "error_msg": None, "updated_at": _now(),
            })
            break
    _save_guides(spec, guides)


def update_guide_error(guide_id: int, error_msg: str, spec: str = "") -> None:
    if not spec:
        g = get_guide(guide_id)
        spec = g["spec"] if g else ""
    guides = get_guides(spec)
    for g in guides:
        if g["id"] == guide_id:
            g.update({"status": "error", "error_msg": error_msg, "updated_at": _now()})
            break
    _save_guides(spec, guides)


def delete_guide(guide_id: int, spec: str = "") -> None:
    if not spec:
        g = get_guide(guide_id)
        spec = g["spec"] if g else ""
    guides = get_guides(spec)
    guides = [g for g in guides if g["id"] != guide_id]
    _save_guides(spec, guides)


# ── Parse samples ─────────────────────────────────────────────────────────────

def _samples_path(spec: str, encounter_id: int) -> Path:
    return SPECS_DIR / spec / "parse_samples" / f"{encounter_id}.json"


def clear_parse_samples(spec: str, encounter_id: int) -> None:
    p = _samples_path(spec, encounter_id)
    if p.exists():
        p.unlink()


def save_parse_sample(
    spec: str, encounter_id: int, encounter_name: str,
    report_code: str, fight_id: int, player_name: str, cooldown_data: dict,
) -> None:
    samples = get_parse_samples(spec, encounter_id)
    samples = [s for s in samples if not (s["report_code"] == report_code and s["fight_id"] == fight_id)]
    samples.append({
        "spec": spec, "encounter_id": encounter_id, "encounter_name": encounter_name,
        "report_code": report_code, "fight_id": fight_id, "player_name": player_name,
        "sampled_at": _now(), "cooldown_data": cooldown_data,
    })
    p = _samples_path(spec, encounter_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(samples, indent=2, ensure_ascii=False))


def get_parse_samples(spec: str, encounter_id: int) -> list[dict]:
    p = _samples_path(spec, encounter_id)
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text())
    except Exception:
        return []


def get_parse_stats(spec: str) -> dict:
    """Per-encounter sample count and last ingested timestamp."""
    result: dict = {}
    samples_dir = SPECS_DIR / spec / "parse_samples"
    if not samples_dir.exists():
        return result
    for p in sorted(samples_dir.glob("*.json")):
        try:
            enc_id = int(p.stem)
            samples = json.loads(p.read_text())
            last = max((s.get("sampled_at", "") for s in samples), default="")
            enc_name = samples[0].get("encounter_name", "") if samples else ""
            result[enc_id] = {
                "encounter_name": enc_name,
                "sample_count": len(samples),
                "last_ingested": last,
            }
        except Exception:
            pass
    return result


def list_specs_with_samples() -> list[str]:
    if not SPECS_DIR.exists():
        return []
    specs = []
    for spec_dir in sorted(SPECS_DIR.iterdir()):
        if not spec_dir.is_dir():
            continue
        samples_dir = spec_dir / "parse_samples"
        if samples_dir.exists() and any(samples_dir.glob("*.json")):
            specs.append(spec_dir.name)
    return specs


# ── Encounter data ────────────────────────────────────────────────────────────

def get_encounter_data(spec: str, encounter_id: int) -> Optional[dict]:
    p = SPECS_DIR / spec / "encounters" / f"{encounter_id}.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


def sync_encounter_file(spec: str, encounter_id: int) -> None:
    """Read raw samples, compute bench stats, write encounters/{id}.json."""
    samples = get_parse_samples(spec, encounter_id)
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
            "sample_count": len(entries),
            "avg_first_cast_s": round(statistics.mean(top_first_casts), 1) if top_first_casts else None,
            "stddev_first_cast_s": round(statistics.stdev(top_first_casts), 1) if len(top_first_casts) > 1 else None,
            "avg_gap_s": round(statistics.mean(all_cd_gaps), 1) if all_cd_gaps else None,
            "stddev_gap_s": round(statistics.stdev(all_cd_gaps), 1) if len(all_cd_gaps) > 1 else None,
            "avg_bl_offset_s": round(statistics.mean(bl_offsets), 1) if bl_offsets else None,
            "stddev_bl_offset_s": round(statistics.stdev(bl_offsets), 1) if len(bl_offsets) > 1 else None,
            "hold_targets": hold_targets,
            "uses_per_min": _bench_uses_per_min(entries),
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

    # ── Defensive benchmark ───────────────────────────────────────────────────
    spec_defensives = SPEC_DEFENSIVES.get(spec) or []
    agg_def_uses: dict[str, list[int]] = {}
    for s in samples:
        for d in (s.get("cooldown_data") or {}).get("defensives") or []:
            agg_def_uses.setdefault(d["name"], []).append(d["uses"])

    top_defensives_summary = []
    for defn in spec_defensives:
        uses = agg_def_uses.get(defn["name"])
        if not uses:
            continue
        top_defensives_summary.append({
            "name": defn["name"],
            "spell_id": defn["spell_id"],
            "avg_uses": round(statistics.mean(uses), 1),
            "min_uses": min(uses),
            "max_uses": max(uses),
            "sample_count": len(uses),
        })

    # ── Damage taken comparison ───────────────────────────────────────────────
    agg_dtk: dict[int, list[float]] = {}
    for s in samples:
        for ab in (s.get("cooldown_data") or {}).get("dmg_taken_by_ability") or []:
            agg_dtk.setdefault(ab["spell_id"], []).append(ab.get("pct") or 0.0)

    min_parses = max(2, len(samples) * 0.4)
    top_dtk_comparison = []
    for sid, pcts in agg_dtk.items():
        if len(pcts) < min_parses:
            continue
        avg = statistics.mean(pcts)
        sd = round(statistics.stdev(pcts), 4) if len(pcts) > 1 else 0.0
        top_dtk_comparison.append({
            "spell_id": sid,
            "avg_pct": round(avg, 4),
            "min_pct": round(min(pcts), 4),
            "max_pct": round(max(pcts), 4),
            "stddev_pct": sd,
            "sample_count": len(pcts),
        })
    top_dtk_comparison.sort(key=lambda x: -x["avg_pct"])
    top_dtk_comparison = top_dtk_comparison[:12]

    # ── Per-segment damage taken comparison ──────────────────────────────────
    seg_pct_lists: list[list[float]] = []
    for s in samples:
        cd = s.get("cooldown_data") or {}
        segs = cd.get("dmg_taken_segments") or []
        total = cd.get("total_dmg_taken") or sum(segs) or 0
        if total > 0:
            seg_pct_lists.append([seg / total for seg in segs])

    top_dtk_segments: list[dict] = []
    if seg_pct_lists:
        max_segs = max(len(s) for s in seg_pct_lists)
        for i in range(max_segs):
            vals = [s[i] for s in seg_pct_lists if i < len(s)]
            if not vals:
                continue
            avg = statistics.mean(vals)
            sd = round(statistics.stdev(vals), 4) if len(vals) > 1 else 0.0
            top_dtk_segments.append({
                "seg_index": i,
                "avg_pct": round(avg, 4),
                "stddev_pct": sd,
                "sample_count": len(vals),
            })

    out = {
        "spec": spec,
        "encounter_id": encounter_id,
        "encounter_name": enc_name,
        "sample_count": len(samples),
        "avg_duration_s": avg_duration_s,
        "last_ingested": _now(),
        "downtime_threshold_ms": round(downtime_threshold_ms),
        "top_avg_efficiency": top_avg_efficiency,
        "top_efficiency_stddev": top_efficiency_stddev,
        "per_cd_benchmarks": per_cd_benchmarks,
        "burst_windows": burst_windows,
        "gear": gear,
        "top_defensives_summary": top_defensives_summary,
        "top_dtk_comparison": top_dtk_comparison,
        "top_dtk_segments": top_dtk_segments,
    }

    enc_dir = SPECS_DIR / spec / "encounters"
    try:
        enc_dir.mkdir(parents=True, exist_ok=True)
        (enc_dir / f"{encounter_id}.json").write_text(
            json.dumps(out, indent=2, ensure_ascii=False)
        )
        _sync_encounters_index(spec, enc_dir)
    except Exception:
        pass


def _sync_encounters_index(spec: str, enc_dir: Path) -> None:
    """Write data/specs/{spec}/encounters.json - index of available encounters."""
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


# ── Helpers ───────────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _write_spec_file(spec: str, filename: str, data: object) -> None:
    try:
        p = SPECS_DIR / spec
        p.mkdir(parents=True, exist_ok=True)
        (p / filename).write_text(json.dumps(data, indent=2, ensure_ascii=False))
    except Exception:
        pass


def _bench_uses_per_min(entries: list[dict]) -> dict:
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
