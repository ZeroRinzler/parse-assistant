"""
Pure analysis helpers shared between main.py (request-time) and db.py (ingestion-time).
No FastAPI, no DB, no WCL - only standard library.
"""
import statistics
from collections import Counter, defaultdict


def cluster_burst_windows(windows: list[dict], total_samples: int, merge_s: float = 15.0) -> list[dict]:
    """Cluster burst windows from multiple parses by fight time and return consistent ones."""
    if not windows:
        return []
    sorted_w = sorted(windows, key=lambda w: w["time_s"])
    clusters: list[list[dict]] = []
    for w in sorted_w:
        placed = False
        for cl in clusters:
            center = statistics.median(c["time_s"] for c in cl)
            if abs(w["time_s"] - center) <= merge_s:
                cl.append(w)
                placed = True
                break
        if not placed:
            clusters.append([w])

    result = []
    for cl in clusters:
        if len(cl) < max(2, total_samples * 0.35):
            continue
        times = [c["time_s"] for c in cl]
        pcts = [c["pct_of_total"] for c in cl]
        cd_counts: Counter = Counter()
        for c in cl:
            for name in c.get("active_cds", []):
                cd_counts[name] += 1
        common_cds = [name for name, cnt in cd_counts.most_common() if cnt >= len(cl) * 0.5]
        avg_targets = round(statistics.mean(c.get("target_count", 1) for c in cl), 1)
        pct_stddev = round(statistics.stdev(pcts) if len(pcts) > 1 else 0.0, 3)

        ability_totals: dict[int, list[float]] = defaultdict(list)
        for c in cl:
            for ab in c.get("ability_breakdown", []):
                ability_totals[ab["spell_id"]].append(ab["pct"])
        ability_breakdown = sorted(
            [
                {
                    "spell_id": sid,
                    "avg_pct": round(statistics.mean(pcts_list), 3),
                    "min_pct": round(min(pcts_list), 3),
                    "max_pct": round(max(pcts_list), 3),
                    "count": len(pcts_list),
                }
                for sid, pcts_list in ability_totals.items()
                if len(pcts_list) >= len(cl) * 0.5
            ],
            key=lambda x: -x["avg_pct"],
        )[:6]

        parse_pcts = sorted(pcts)
        result.append({
            "time_s": round(statistics.median(times), 1),
            "stddev_s": round(statistics.stdev(times) if len(times) > 1 else 0.0, 1),
            "count": len(cl),
            "total_samples": total_samples,
            "pct_avg": round(statistics.mean(pcts), 3),
            "pct_stddev": pct_stddev,
            "pct_min": round(parse_pcts[0], 3),
            "pct_max": round(parse_pcts[-1], 3),
            "common_cds": common_cds,
            "avg_targets": avg_targets,
            "ability_breakdown": ability_breakdown,
        })
    return sorted(result, key=lambda r: r["time_s"])


def aggregate_gear(samples: list[dict]) -> dict:
    """Aggregate talent builds, trinkets, and enchants across stored parse samples."""
    total = len(samples)
    talent_counter: Counter = Counter()
    talent_example: dict[str, dict] = {}
    trinket_counters: dict[int, Counter] = {12: Counter(), 13: Counter()}
    trinket_names: dict[int, str] = {}
    enchant_counters: dict[int, Counter] = defaultdict(Counter)
    enchant_names: dict[int, str] = {}

    for s in samples:
        cd_data = s.get("cooldown_data") or {}

        tk = cd_data.get("talent_key", "")
        if tk:
            talent_counter[tk] += 1
            if tk not in talent_example:
                talent_example[tk] = {
                    "report_code": s.get("report_code", ""),
                    "fight_id": s.get("fight_id"),
                    "player_name": s.get("player_name", ""),
                }

        for t in cd_data.get("trinkets") or []:
            slot = t.get("slot")
            item_id = t.get("id")
            if slot in (12, 13) and item_id:
                trinket_counters[slot][item_id] += 1
                if item_id not in trinket_names:
                    trinket_names[item_id] = t.get("name", "")

        for e in cd_data.get("enchants") or []:
            slot = e.get("slot")
            enc_id = e.get("id")
            if slot is not None and enc_id:
                enchant_counters[slot][enc_id] += 1
                if enc_id not in enchant_names:
                    enchant_names[enc_id] = e.get("name", "")

    return {
        "sample_count": total,
        "talent_builds": [
            {
                "key": k,
                "count": c,
                "pct": round(c / total * 100) if total else 0,
                **talent_example.get(k, {}),
            }
            for k, c in talent_counter.most_common(5)
        ],
        "trinkets": {
            str(slot): [
                {
                    "id": item_id,
                    "name": trinket_names.get(item_id, ""),
                    "count": c,
                    "pct": round(c / total * 100) if total else 0,
                }
                for item_id, c in counter.most_common(5)
            ]
            for slot, counter in trinket_counters.items()
            if counter
        },
        "enchants": {
            str(slot): [
                {
                    "id": enc_id,
                    "name": enchant_names.get(enc_id, ""),
                    "count": c,
                    "pct": round(c / total * 100) if total else 0,
                }
                for enc_id, c in counter.most_common(3)
            ]
            for slot, counter in enchant_counters.items()
            if counter
        },
    }
