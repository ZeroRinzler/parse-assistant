/**
 * Pure gear-comparison helpers shared between the pre-fight boss-study page and
 * the analyze page's gear section. All functions are framework-free and unit-testable
 * without Angular.
 */
import { CharacterGear } from '../../core/models/wcl.models';
import { EncounterGearStats } from '../../core/models/encounter.models';

export type GearStatus = 'ok' | 'warn' | 'info' | 'unknown';

const SLOT_NAMES: Record<number, string> = {
  0:'Head', 1:'Neck', 2:'Shoulder', 3:'Back', 4:'Chest', 5:'Waist', 6:'Legs',
  7:'Feet', 8:'Wrists', 9:'Hands', 10:'Ring 1', 11:'Ring 2',
  12:'Trinket 1', 13:'Trinket 2', 14:'Back', 15:'Main Hand', 16:'Off Hand',
};

const STATUS_ICONS: Record<GearStatus, string> = {
  ok: 'check_circle', warn: 'warning', info: 'info', unknown: 'help_outline',
};

export function slotName(slot: number): string { return SLOT_NAMES[slot] || `Slot ${slot}`; }
export function statusIcon(status: GearStatus): string { return STATUS_ICONS[status]; }

// ── Shared types ─────────────────────────────────────────────────────────────

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
  link: string | null;
  playerName: string;
  label: string;
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

// ── Player-vs-bench comparison (analyze page) ─────────────────────────────────

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
        rows.push({ slotName: name, status: 'warn', name: 'Not enchanted', topPct: top.pct,
          note: `Apply ${topName}` });
      } else if (top && top.pct >= 40) {
        rows.push({ slotName: name, status: 'info', name: 'Not enchanted', topPct: top.pct,
          note: `${top.pct}% run ${topName}` });
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
    link: b.report_code ? `https://www.warcraftlogs.com/reports/${b.report_code}#fight=${b.fight_id ?? 0}` : null,
    playerName: b.player_name || '',
    label: i === 0 ? 'Most common build' : `Alt build ${i}`,
  }));
}

export function talentStatusOf(topStats: EncounterGearStats | null, playerKey: string): { status: GearStatus; note: string } {
  const builds = topStats?.talent_builds ?? [];
  if (!builds.length) return { status: 'unknown', note: 'No talent data.' };
  const topPct = builds[0]?.pct ?? 0;
  // No comparable player build (not ranked here, or format mismatch): just
  // present the consensus build positively rather than flagging it.
  if (!playerKey || playerKey.split(':')[0] !== (builds[0]?.key ?? '').split(':')[0]) {
    return { status: 'ok', note: `${topPct}% run this build` };
  }
  if (builds.some(b => b.key === playerKey)) {
    return { status: 'ok', note: 'Standard build.' };
  }
  return { status: 'warn', note: `Off-meta build. ${topPct}% run the standard one.` };
}

/**
 * Trinket slot order is irrelevant in WoW: wearing the two correct top-pick
 * trinkets counts as optimal regardless of which slot (12 vs 13) each sits in.
 * Returns true when the player's worn trinket id set for slots {12, 13} equals
 * the bench's top-pick id set {benchTop12Id, benchTop13Id}, compared unordered.
 * Returns false when either side lacks two distinct ids.
 */
function trinketSetMatches(
  playerTrinkets: NonNullable<CharacterGear['trinkets']>,
  benchTop12Id: number | undefined,
  benchTop13Id: number | undefined,
): boolean {
  const playerTrinketIds = new Set(
    [12, 13]
      .map(slot => playerTrinkets.find(trinket => trinket.slot === slot)?.id)
      .filter((id): id is number => id !== undefined),
  );
  const benchTopIds = new Set(
    [benchTop12Id, benchTop13Id].filter((id): id is number => id !== undefined),
  );
  if (playerTrinketIds.size !== 2 || benchTopIds.size !== 2) return false;
  for (const id of playerTrinketIds) {
    if (!benchTopIds.has(id)) return false;
  }
  return true;
}

/**
 * Per-slot trinket comparison: player's item vs top-parse consensus.
 * Returns a row for each slot (12, 13) that has either a player item or bench data.
 */
export function buildTrinketRows(gear: CharacterGear | null, stats: EncounterGearStats | null): TrinketRow[] {
  const topTrinkets = stats?.trinkets ?? {};
  const playerTrinkets = gear?.trinkets ?? [];
  const rows: TrinketRow[] = [];

  // Trinket slot order does not matter: if the player wears both top-pick
  // trinkets (in either slot order), accept both rows as optimal instead of
  // flagging each slot for a "Switch to" swap.
  const benchTop12 = topTrinkets[12]?.[0];
  const benchTop13 = topTrinkets[13]?.[0];
  if (trinketSetMatches(playerTrinkets, benchTop12?.id, benchTop13?.id)) {
    for (const slot of [12, 13]) {
      const label = slotName(slot);
      const player = playerTrinkets.find(trinket => trinket.slot === slot)!;
      // The player's worn trinket is one of the two bench top picks; pull its
      // usage pct from whichever bench slot lists it.
      const matchingBenchPct =
        benchTop12?.id === player.id ? benchTop12.pct : benchTop13?.id === player.id ? benchTop13.pct : null;
      rows.push({ slotLabel: label, id: player.id, name: player.name, icon: player.icon ?? '',
        status: 'ok', topPct: matchingBenchPct, note: null });
    }
    return rows;
  }

  for (const slot of [12, 13]) {
    const label = slotName(slot);
    const topList = topTrinkets[slot] ?? [];
    const top = topList[0];
    const player = playerTrinkets.find(t => t.slot === slot);

    if (!player && !top) continue;

    if (!player) {
      // No player item; surface the top recommendation as an info prompt.
      rows.push({ slotLabel: label, id: top.id, name: top.name, icon: '',
        status: 'info', topPct: top.pct, note: `${top.pct}% run this trinket` });
      continue;
    }

    // Find how popular the player's current trinket is among top parsers.
    const playerUsagePct = topList.find(t => t.id === player.id)?.pct ?? null;

    if (top && player.id === top.id) {
      rows.push({ slotLabel: label, id: player.id, name: player.name, icon: player.icon ?? '',
        status: 'ok', topPct: top.pct, note: null });
    } else if (top) {
      rows.push({ slotLabel: label, id: player.id, name: player.name, icon: player.icon ?? '',
        status: 'info', topPct: playerUsagePct,
        note: `Switch to ${top.name} (${top.pct}%)` });
    } else {
      // No bench data for this slot; player item is acceptable.
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

// ── Bench-only display (/pre boss-study page) ─────────────────────────────────

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

/**
 * Shows the consensus enchant per slot for the boss-study view.
 * Omits slots where fewer than 40% of top parsers enchant.
 */
export function buildBenchEnchantRows(stats: EncounterGearStats | null): BenchEnchantRow[] {
  const topEnch = stats?.enchants ?? {};
  return Object.keys(topEnch)
    .map(Number)
    .sort((a, b) => a - b)
    .reduce<BenchEnchantRow[]>((acc, slot) => {
      const top = topEnch[slot]?.[0];
      if (top && top.pct >= 40) {
        acc.push({ slotName: slotName(slot), name: top.name || `Enchant #${top.id}`, pct: top.pct });
      }
      return acc;
    }, []);
}

/**
 * Shows the most-used trinket per slot (12 and 13) for the boss-study view.
 */
export function buildBenchTrinketRows(stats: EncounterGearStats | null): BenchTrinketRow[] {
  const topTrinkets = stats?.trinkets ?? {};
  return [12, 13].reduce<BenchTrinketRow[]>((acc, slot) => {
    const top = topTrinkets[slot]?.[0];
    if (top) acc.push({ slotLabel: slotName(slot), id: top.id, name: top.name, icon: top.icon, pct: top.pct });
    return acc;
  }, []);
}
