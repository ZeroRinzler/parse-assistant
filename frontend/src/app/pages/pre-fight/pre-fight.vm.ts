/**
 * Pure view-model derivations for the pre-fight gear check.
 *
 * `PreFightComponent` injects eight services and loads its state through async
 * network methods, which makes it impractical to mount for a unit test. The
 * actual logic - turning a rulebook + top-parse bench + the player's gear into
 * the rows the template renders - is pure, so it lives here as standalone
 * functions. The component's `computed()`s are thin wrappers over these, and the
 * tests exercise the functions directly.
 */
import { CharacterGear } from '../../core/models/wcl.models';
import { EncounterBench, EncounterGearStats } from '../../core/models/encounter.models';
import { Rulebook } from '../../core/models/rulebook.models';

export type GearStatus = 'ok' | 'warn' | 'info' | 'unknown';

const SLOT_NAMES: Record<number, string> = {
  0:'Head', 1:'Neck', 2:'Shoulder', 3:'Back', 4:'Chest', 5:'Waist', 6:'Legs',
  7:'Feet', 8:'Wrists', 9:'Hands', 10:'Ring 1', 11:'Ring 2',
  12:'Trinket 1', 13:'Trinket 2', 14:'Back', 15:'Main Hand', 16:'Off Hand',
};

const STATUS_ICONS: Record<GearStatus, string> = {
  ok: 'check_circle', warn: 'warning', info: 'info', unknown: 'help_outline',
};

const STATUS_CLASSES: Record<GearStatus, string> = {
  ok: 'badge-success', warn: 'badge-warning', info: 'badge-info', unknown: 'text-[var(--muted)]',
};

export function slotName(slot: number): string { return SLOT_NAMES[slot] || `Slot ${slot}`; }
export function statusIcon(status: GearStatus): string { return STATUS_ICONS[status]; }
export function statusClass(status: GearStatus): string { return STATUS_CLASSES[status]; }

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
  rule: string | null;
}

export interface EnchantRow {
  slotName: string;
  status: GearStatus;
  name: string;
  note: string | null;
}

export interface TalentBuildRow {
  pct: number;
  isPlayer: boolean;
  link: string | null;
  playerName: string;
  label: string;
}

export interface GemCheck {
  count: number;
  expected: number;
  status: GearStatus;
}

export interface BurstWindowVm {
  startS: number;
  endS: number;
  cds: Array<{ name: string; spellId: number | null }>;
  aoe: boolean;
  dmg: number | null;
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
      usesPerMin: b?.uses_per_min?.avg ?? b?.avg_uses_per_min ?? null,
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
      .filter(w => (w.defensive_name ?? w.common_defensives?.[0]) === def.name)
      .map(w => w.time_s)
      .sort((a, c) => a - c);
    return {
      name: def.name,
      spellId: def.spell_id ?? null,
      uses: b?.avg_uses ?? null,
      firstCastS: b?.avg_first_cast_s ?? null,
      windowsS,
      rule: def.usage_rule ?? null,
    };
  }).filter(d => d.uses != null || d.firstCastS != null || d.windowsS.length || d.rule);
}

/**
 * Enchants: flag slots the player left un-enchanted that top parsers consider
 * mandatory, and surface where the player differs from the consensus enchant.
 */
export function buildEnchantRows(gear: CharacterGear | null, stats: EncounterGearStats | null): EnchantRow[] {
  const topEnch = stats?.enchants ?? {};
  const playerEnch = gear?.enchants ?? [];
  if (!Object.keys(topEnch).length && !playerEnch.length) return [];
  const slots = new Set<number>();
  for (const k of Object.keys(topEnch)) slots.add(Number(k));
  for (const e of playerEnch) slots.add(e.slot);

  const rows: EnchantRow[] = [];
  for (const slot of [...slots].sort((a, b) => a - b)) {
    const name = slotName(slot);
    const top = topEnch[slot]?.[0];
    const topName = top ? (top.name || `Enchant #${top.id}`) : '';
    const player = playerEnch.find(e => e.slot === slot);
    if (!player) {
      if (top && top.pct >= 70) {
        rows.push({ slotName: name, status: 'warn', name: 'Not enchanted',
          note: `${top.pct}% of top parsers enchant this slot` });
      } else if (top && top.pct >= 40) {
        rows.push({ slotName: name, status: 'info', name: 'Not enchanted',
          note: `${top.pct}% of top parsers enchant this slot` });
      }
      continue;
    }
    const playerName = player.name || `Enchant #${player.id}`;
    if (top && player.id === top.id) {
      rows.push({ slotName: name, status: 'ok', name: playerName, note: `Matches top parsers (${top.pct}%)` });
    } else if (top) {
      rows.push({ slotName: name, status: 'info', name: playerName, note: `Top parsers use ${topName} (${top.pct}%)` });
    } else {
      rows.push({ slotName: name, status: 'ok', name: playerName, note: null });
    }
  }
  return rows;
}

export function enchantStatusOf(rows: EnchantRow[]): GearStatus {
  return rows.some(r => r.status === 'warn') ? 'warn' : 'ok';
}

/** Top-parse talent builds with a link to an example parse running each one. */
export function buildTalentBuilds(stats: EncounterGearStats | null, playerKey: string): TalentBuildRow[] {
  const builds = stats?.talent_builds ?? [];
  if (!builds.length) return [];
  return builds.map((b, i) => ({
    pct: b.pct,
    isPlayer: !!playerKey && b.key === playerKey,
    link: b.report_code ? `https://www.warcraftlogs.com/reports/${b.report_code}#fight=${b.fight_id ?? 0}` : null,
    playerName: b.player_name || '',
    label: i === 0 ? 'Most common build' : `Alt build ${i}`,
  }));
}

/** Filled-socket check: compare the player's gem count to the top-parse total. */
export function buildGemCheck(stats: EncounterGearStats | null, count: number | null | undefined): GemCheck | null {
  const gems = stats?.gems;
  if (!gems || count == null) return null;
  const expected = gems.max_count;
  return { count, expected, status: count >= expected ? 'ok' : 'warn' };
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
  return (bench?.burst_windows ?? []).map(bw => ({
    startS: bw.time_s,
    endS: bw.time_s + bw.window_length_s,
    cds: (bw.common_cds ?? []).map(n => ({ name: n, spellId: map[n] ?? null })),
    aoe: (bw.avg_targets ?? 1) >= 2,
    dmg: bw.dmg_avg ?? null,
  }));
}

export function talentStatusOf(topStats: EncounterGearStats | null, playerKey: string): { status: GearStatus; note: string } {
  const builds = topStats?.talent_builds ?? [];
  if (!builds.length) return { status: 'unknown', note: 'No talent data yet.' };
  const topPct = builds[0]?.pct ?? 0;
  // No comparable player build (not ranked here, or format mismatch): just
  // present the consensus build positively rather than flagging it.
  if (!playerKey || playerKey.split(':')[0] !== (builds[0]?.key ?? '').split(':')[0]) {
    return { status: 'ok', note: `Most common build used by ${topPct}% of top parsers` };
  }
  if (builds.some(b => b.key === playerKey)) {
    return { status: 'ok', note: 'On a top-parse build' };
  }
  return { status: 'warn', note: `Your build differs - most common used by ${topPct}% of top parsers` };
}
