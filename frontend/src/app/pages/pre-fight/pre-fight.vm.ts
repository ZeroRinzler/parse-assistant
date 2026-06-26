/**
 * Pure view-model derivations for the pre-fight boss-study page.
 *
 * Gear-comparison helpers (buildEnchantRows, buildTalentBuilds, etc.) live in
 * `shared/gear/gear-comparison.ts` and are shared with the analyze page.
 * This file holds only the plan/burst derivations that are specific to /pre.
 */
import { EncounterBench } from '../../core/models/encounter.models';
import { Rulebook } from '../../core/models/rulebook.models';

export interface CdPlanItem {
  name: string;
  spellId: number | null;
  firstCastS: number | null;
  uses: number | null;
  usesPerMin: number | null;
  bloodlust: boolean;
  bloodlustPct: number | null;
  holds: Array<{ castIndex: number; targetS: number }>;
  rule: string | null;
}

export interface DefPlanItem {
  name: string;
  spellId: number | null;
  uses: number | null;
  firstCastS: number | null;
  windowsS: number[];
  holds: Array<{ castIndex: number; targetS: number }>;
  rule: string | null;
}

export interface BurstWindowVm {
  startS: number;
  endS: number;
  cds: Array<{ name: string; spellId: number | null }>;
  aoe: boolean;
  dmg: number | null;
  /** Damage relative to the biggest window in the fight, 0-1. Drives the position bar. */
  dmgShare: number | null;
}

/**
 * Cooldown game plan: target opener timing, expected uses, BL alignment and
 * hold targets per major cooldown, drawn from the top-parse benchmarks.
 */
export function buildCdPlan(rulebook: Rulebook | null, bench: EncounterBench | null): CdPlanItem[] {
  if (!rulebook?.major_cooldowns?.length) return [];
  const benchmarks = bench?.per_cd_benchmarks ?? {};
  const cds = [...rulebook.major_cooldowns].sort((a, b) => {
    const pa = a.opener_priority ?? 99;
    const pb = b.opener_priority ?? 99;
    return pa !== pb ? pa - pb : a.name.localeCompare(b.name);
  });
  return cds.map(cd => {
    const b = benchmarks[cd.name];
    const holds = b?.majority_hold && b.hold_targets
      ? Object.entries(b.hold_targets)
          .sort((a, c) => Number(a[0]) - Number(c[0]))
          .map(([idx, h]) => ({ castIndex: Number(idx), targetS: h.target_s }))
      : [];
    return {
      name: cd.name,
      spellId: cd.spell_id ?? null,
      firstCastS: b?.avg_first_cast_s ?? null,
      uses: b?.avg_uses ?? null,
      usesPerMin: b?.uses_per_min.avg ?? null,
      bloodlust: !!cd.align_with_bloodlust,
      bloodlustPct: cd.align_with_bloodlust && b && b.bl_pct >= 40 ? b.bl_pct : null,
      holds,
      rule: cd.usage_rule ?? null,
    };
  });
}

/** Defensive plan: when top parsers fire each defensive and how often. */
export function buildDefensivePlan(rulebook: Rulebook | null, bench: EncounterBench | null): DefPlanItem[] {
  if (!rulebook?.defensives?.length) return [];
  const benchmarks = bench?.per_defensive_benchmarks ?? {};
  const windows = bench?.defensive_windows ?? [];
  return rulebook.defensives.map(def => {
    const b = benchmarks[def.name];
    const windowsS = windows
      .filter(w => w.defensive_name === def.name)
      .map(w => w.time_s)
      .sort((a, c) => a - c);
    const holds = b?.majority_hold && b.hold_targets
      ? Object.entries(b.hold_targets)
          .sort((a, c) => Number(a[0]) - Number(c[0]))
          .map(([idx, h]) => ({ castIndex: Number(idx), targetS: h.target_s }))
      : [];
    return {
      name: def.name,
      spellId: def.spell_id ?? null,
      uses: b?.avg_uses ?? null,
      firstCastS: b?.avg_first_cast_s ?? null,
      windowsS,
      holds,
      rule: def.usage_rule ?? null,
    };
  }).filter(d => d.uses != null || d.firstCastS != null || d.windowsS.length || d.holds.length || d.rule);
}

/** Map cooldown/defensive names (used as keys in burst windows) to spell ids. */
function spellIdByName(rulebook: Rulebook | null): Record<string, number> {
  const map: Record<string, number> = {};
  for (const cd of rulebook?.major_cooldowns ?? []) if (cd.spell_id) map[cd.name] = cd.spell_id;
  for (const d of rulebook?.defensives ?? []) if (d.spell_id) map[d.name] = d.spell_id;
  return map;
}

export function buildBurstWindows(rulebook: Rulebook | null, bench: EncounterBench | null): BurstWindowVm[] {
  const map = spellIdByName(rulebook);
  const raw = bench?.burst_windows ?? [];
  const maxDmg = Math.max(0, ...raw.map(bw => bw.dmg_avg ?? 0));
  return raw.map(bw => ({
    startS: bw.time_s,
    endS: bw.time_s + bw.window_length_s,
    cds: (bw.common_cds ?? []).map(n => ({ name: n, spellId: map[n] ?? null })),
    aoe: bw.avg_targets >= 2,
    dmg: bw.dmg_avg,
    dmgShare: maxDmg > 0 && bw.dmg_avg != null ? bw.dmg_avg / maxDmg : null,
  }));
}
