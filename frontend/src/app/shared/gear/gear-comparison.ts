import { CharacterGear } from '../../core/models/wcl.models';
import { EncounterGearStats } from '../../core/models/encounter.models';
import { SpecTalents, TalentEntry, TalentDiff } from '../../core/models/talent.models';
import { parseTalentKey } from './talent-key';

export type GearStatus = 'ok' | 'warn' | 'info' | 'unknown';

/** A slot counts as consensus-enchanted, and an un-enchanted one warns, at this top-parse share. */
const ENCHANT_CONSENSUS_PCT = 50;

const SLOT_NAMES: Record<number, string> = {
  0:'Head', 1:'Neck', 2:'Shoulder', 3:'Shirt', 4:'Chest', 5:'Waist', 6:'Legs',
  7:'Feet', 8:'Wrists', 9:'Hands', 10:'Ring 1', 11:'Ring 2',
  12:'Trinket 1', 13:'Trinket 2', 14:'Back', 15:'Main Hand', 16:'Off Hand',
};

const STATUS_ICONS: Record<GearStatus, string> = {
  ok: 'check_circle', warn: 'warning', info: 'info', unknown: 'help_outline',
};

export function slotName(slot: number): string { return SLOT_NAMES[slot] || `Slot ${slot}`; }
export function statusIcon(status: GearStatus): string { return STATUS_ICONS[status]; }

export interface EnchantRow {
  slotName: string;
  status: GearStatus;
  name: string;
  /** Usage % of the player's current enchant among top parsers, or null when absent/unknown. */
  topPct: number | null;
  note: string | null;
}

export interface TalentBuildRow {
  pct: number;
  isPlayer: boolean;
  link: string;
  playerName: string;
  label: string;
  added: TalentEntry[];
  dropped: TalentEntry[];
  ranks: TalentDiff[];
}

export interface TrinketRow {
  slotLabel: string;
  /** Item id for wl-game-icon (player's item if they have one, else the top-parse item). */
  id: number;
  name: string;
  icon: string;
  status: GearStatus;
  /** Usage % of the displayed item among top parsers, or null when unknown. */
  topPct: number | null;
  note: string | null;
}

// The comparison builders below take a real `CharacterGear` (never null); the bench-only view uses the dedicated `buildBench*` builders instead, so a not-yet-loaded player never renders "Not enchanted".

/** Flags slots the player left un-enchanted that top parsers consider mandatory, and surfaces where the player differs from the consensus enchant. */
export function buildEnchantRows(gear: CharacterGear, stats: EncounterGearStats | null): EnchantRow[] {
  const topEnch = stats?.enchants ?? {};
  const playerEnch = gear.enchants ?? [];
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
      if (top && top.pct >= ENCHANT_CONSENSUS_PCT) {
        rows.push({ slotName: name, status: 'warn', name: 'Not enchanted', topPct: top.pct,
          note: `Apply ${topName}` });
      }
      continue;
    }
    const playerName = player.name || `Enchant #${player.id}`;
    const playerUsagePct = topEnch[slot]?.find(e => e.id === player.id)?.pct ?? null;
    if (top && player.id === top.id) {
      rows.push({ slotName: name, status: 'ok', name: playerName, topPct: top.pct,
        note: `${top.pct}% run this` });
    } else if (top) {
      rows.push({ slotName: name, status: 'info', name: playerName, topPct: playerUsagePct,
        note: `${top.pct}% run ${topName}` });
    } else {
      rows.push({ slotName: name, status: 'ok', name: playerName, topPct: null, note: null });
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
    // Deep-link to the example parse: select the fight, the summary tab, and the player (`source` = their actor id within that report).
    link: `https://www.warcraftlogs.com/reports/${b.report_code}?fight=${b.fight_id}&type=summary&source=${b.source_id}`,
    playerName: b.player_name,
    label: i === 0 ? 'Most common build' : `Alt build ${i}`,
    // Benches from the prior ingest have no diff field on disk.
    added: (b.diff ?? []).filter(d => d.kind === 'added').map(d => d.talent),
    dropped: (b.diff ?? []).filter(d => d.kind === 'dropped').map(d => d.talent),
    ranks: (b.diff ?? []).filter(d => d.kind === 'rank'),
  }));
}

function talentOf(talents: SpecTalents, entryId: number): TalentEntry {
  return talents[entryId] ?? { name: `Talent #${entryId}`, icon: '' };
}

export function buildTalentDiff(
  buildKey: string, baselineKey: string, talents: SpecTalents | null,
): TalentDiff[] {
  if (!talents) return [];
  const buildPicks = parseTalentKey(buildKey);
  const basePicks = parseTalentKey(baselineKey);
  if (!buildPicks.length || !basePicks.length) return [];

  const baseByEntry = new Map(basePicks.map(pick => [pick.entryId, pick]));
  const buildByEntry = new Map(buildPicks.map(pick => [pick.entryId, pick]));
  const diffs: TalentDiff[] = [];
  for (const pick of buildPicks) {
    const base = baseByEntry.get(pick.entryId);
    if (!base) diffs.push({ kind: 'added', talent: talentOf(talents, pick.entryId) });
    else if (base.rank !== pick.rank) {
      diffs.push({ kind: 'rank', talent: talentOf(talents, pick.entryId), rank: pick.rank, standardRank: base.rank });
    }
  }
  for (const pick of basePicks) {
    if (!buildByEntry.has(pick.entryId)) diffs.push({ kind: 'dropped', talent: talentOf(talents, pick.entryId) });
  }
  return diffs;
}

export function talentStatusOf(topStats: EncounterGearStats | null, playerKey: string): { status: GearStatus; note: string } {
  const builds = topStats?.talent_builds ?? [];
  if (!builds.length) return { status: 'unknown', note: 'No talent data.' };
  const topPct = builds[0]?.pct ?? 0;
  // No comparable player build (not ranked here, or format mismatch): present the consensus build positively rather than flagging it.
  if (!playerKey || playerKey.split(':')[0] !== (builds[0]?.key ?? '').split(':')[0]) {
    return { status: 'ok', note: `${topPct}% run this build` };
  }
  if (builds.some(b => b.key === playerKey)) {
    return { status: 'ok', note: 'Standard build.' };
  }
  return { status: 'warn', note: `Off-meta build. ${topPct}% run the standard one.` };
}

/** Overall usage of a trinket id among top parsers (summed across slots 12/13). */
function trinketUsagePct(stats: EncounterGearStats | null, id: number): number | null {
  const topTrinkets = stats?.trinkets ?? {};
  let sum = 0;
  let found = false;
  for (const slot of [12, 13]) {
    const hit = (topTrinkets[slot] ?? []).find(trinket => trinket.id === id);
    if (hit) {
      sum += hit.pct;
      found = true;
    }
  }
  return found ? sum : null;
}

/** Per-slot trinket comparison (slots 12, 13); recommendations come from `topTrinketPair`, each consumed by at most one slot, so the same item is never suggested for both. */
export function buildTrinketRows(gear: CharacterGear, stats: EncounterGearStats | null): TrinketRow[] {
  const playerTrinkets = gear.trinkets ?? [];
  const pair = topTrinketPair(stats);
  const rows: TrinketRow[] = [];

  // Hand each remaining (distinct) recommendation to a slot that needs one, consuming it once, so the two suggestions never collide.
  const wornIds = new Set(playerTrinkets.map(trinket => trinket.id));
  const remainingRecs = pair.filter(rec => !wornIds.has(rec.id));
  let recIndex = 0;
  const claimedRecIds = new Set<number>();

  for (const slot of [12, 13]) {
    const label = slotName(slot);
    const player = playerTrinkets.find(trinket => trinket.slot === slot);

    if (!player) {
      const rec = remainingRecs[recIndex];
      if (!rec) continue;
      recIndex++;
      rows.push({ slotLabel: label, id: rec.id, name: rec.name, icon: rec.icon,
        status: 'info', topPct: rec.pct, note: `${rec.pct}% run this trinket` });
      continue;
    }

    const matchedRec = pair.find(rec => rec.id === player.id && !claimedRecIds.has(rec.id));
    if (matchedRec) {
      // Claim the matched recommendation so a duplicate slot is compared against what remains.
      claimedRecIds.add(matchedRec.id);
      rows.push({ slotLabel: label, id: player.id, name: player.name, icon: player.icon ?? '',
        status: 'ok', topPct: matchedRec.pct, note: null });
      continue;
    }

    const rec = remainingRecs[recIndex];
    if (rec) {
      recIndex++;
      rows.push({ slotLabel: label, id: player.id, name: player.name, icon: player.icon ?? '',
        status: 'info', topPct: trinketUsagePct(stats, player.id),
        note: `Switch to ${rec.name} (${rec.pct}%)` });
    } else {
      // No bench data / no distinct recommendation left; player item is acceptable.
      rows.push({ slotLabel: label, id: player.id, name: player.name, icon: player.icon ?? '',
        status: 'ok', topPct: null, note: null });
    }
  }
  return rows;
}

export function trinketStatusOf(rows: TrinketRow[]): GearStatus {
  if (rows.some(r => r.status === 'warn')) return 'warn';
  if (rows.some(r => r.status === 'info')) return 'info';
  return 'ok';
}

export interface BenchEnchantRow {
  slotName: string;
  name: string;
  pct: number;
}

export interface BenchTrinketRow {
  slotLabel: string;
  id: number;
  name: string;
  icon: string;
  pct: number;
}

export interface RecommendedTrinket {
  id: number;
  name: string;
  icon: string;
  pct: number;
}

/** The two distinct trinkets top parsers run, merged by id: no parse wears the same trinket in both slots, so slot-12 + slot-13 usage sums to the true "% running it" (40% + 30% = 70%). */
export function topTrinketPair(stats: EncounterGearStats | null): RecommendedTrinket[] {
  const topTrinkets = stats?.trinkets ?? {};
  const byId = new Map<number, RecommendedTrinket>();
  for (const slot of [12, 13]) {
    for (const trinket of topTrinkets[slot] ?? []) {
      const existing = byId.get(trinket.id);
      if (existing) existing.pct += trinket.pct;
      else byId.set(trinket.id, { id: trinket.id, name: trinket.name, icon: trinket.icon, pct: trinket.pct });
    }
  }
  return [...byId.values()].sort((a, b) => b.pct - a.pct).slice(0, 2);
}

/** Shows the consensus enchant per slot for the boss-study view; omits slots below the top-parse consensus share. */
export function buildBenchEnchantRows(stats: EncounterGearStats | null): BenchEnchantRow[] {
  const topEnch = stats?.enchants ?? {};
  return Object.keys(topEnch)
    .map(Number)
    .sort((a, b) => a - b)
    .reduce<BenchEnchantRow[]>((acc, slot) => {
      const top = topEnch[slot]?.[0];
      if (top && top.pct >= ENCHANT_CONSENSUS_PCT) {
        acc.push({ slotName: slotName(slot), name: top.name || `Enchant #${top.id}`, pct: top.pct });
      }
      return acc;
    }, []);
}

/** The two distinct most-used trinkets for the boss-study view (`topTrinketPair`, never the same twice). */
export function buildBenchTrinketRows(stats: EncounterGearStats | null): BenchTrinketRow[] {
  return topTrinketPair(stats).map((trinket, index) => ({
    slotLabel: index === 0 ? 'Trinket 1' : 'Trinket 2',
    id: trinket.id,
    name: trinket.name,
    icon: trinket.icon,
    pct: trinket.pct,
  }));
}
