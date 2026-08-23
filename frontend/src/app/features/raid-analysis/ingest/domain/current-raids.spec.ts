import { describe, it, expect } from 'vitest';
import type { WclApiService } from '../../../../core/wcl/wcl-api-service';
import type { WclClass, WclExpansion, WclZone } from '../../../../core/wcl/wcl.models';
import { BudgetExceededError, CurrentRaidsService } from './current-raids-service';
import { TestBed } from '@angular/core/testing';

const currentRaids = TestBed.inject(CurrentRaidsService);

type PointsBudget = Awaited<ReturnType<WclApiService['getPointsBudget']>>;

function zone(over: Partial<WclZone> & Pick<WclZone, 'id' | 'name'>): WclZone {
  return { frozen: false, ...over };
}

const ABYSS = 53, FROZEN_ABYSS = 54, SPOREFALL = 50;
const NEKZALI = 3470, SENTINELS = 3445, ROTMIRE = 3159;

const expansions: WclExpansion[] = [
  {
    zones: [
      zone({ id: 46, name: 'VS / DR / MQD', encounters: [{ id: 3176, name: 'Imperator' }] }),
      zone({ id: SPOREFALL, name: 'Sporefall', partitions: [{ id: 1 }, { id: 2 }], encounters: [{ id: ROTMIRE, name: 'Rotmire' }] }),
      zone({ id: ABYSS, name: 'The Venomous Abyss', encounters: [{ id: NEKZALI, name: "Nek'zali" }, { id: SENTINELS, name: 'Sentinels' }] }),
      zone({ id: FROZEN_ABYSS, name: 'The Venomous Abyss', frozen: true, encounters: [{ id: 3480, name: 'Frozen copy' }] }),
    ],
  },
  { zones: [zone({ id: 44, name: 'Manaforge Omega', encounters: [{ id: 3129, name: 'Old' }] })] },
];

const classes: WclClass[] = [
  { name: 'Rogue', slug: 'Rogue', specs: [
    { name: 'Assassination', slug: 'Assassination' },
    { name: 'Subtlety', slug: 'Subtlety' },
  ] },
  { name: 'Hunter', slug: 'Hunter', specs: [
    { name: 'Beast Mastery', slug: 'BeastMastery' },
  ] },
  { name: 'Demon Hunter', slug: 'DemonHunter', specs: [
    { name: 'Devourer', slug: 'Devourer' },
  ] },
];

const wclWithZoneTree = (tree: WclExpansion[] | null): WclApiService =>
  ({ getZoneTree: async () => tree }) as unknown as WclApiService;

const wclWithClasses = (playable: WclClass[]): WclApiService =>
  ({ getPlayableClasses: async () => playable }) as unknown as WclApiService;

const wclWithBudget = (budget: PointsBudget): WclApiService =>
  ({ getPointsBudget: async () => budget }) as unknown as WclApiService;

describe('parseRaidNames', () => {
  it('splits on commas and trims, so the repo variable can be written with spaces', () => {
    expect(currentRaids.parseRaidNames('The Venomous Abyss, Sporefall')).toEqual(['The Venomous Abyss', 'Sporefall']);
  });

  it('yields no raid for unset or blank input, which leaves the dataset alone rather than pruning it', () => {
    expect(currentRaids.parseRaidNames(null)).toEqual([]);
    expect(currentRaids.parseRaidNames('  ,  ')).toEqual([]);
  });
});

describe('discoverCurrentRaids', () => {
  it('returns the named raids\' encounters, in the order they were named', async () => {
    const { encounters } = await currentRaids.discoverCurrentRaids(wclWithZoneTree(expansions), ['The Venomous Abyss', 'Sporefall']);
    expect(encounters.map(encounter => encounter.id)).toEqual([NEKZALI, SENTINELS, ROTMIRE]);
    expect(encounters[0]).toMatchObject({ name: "Nek'zali", zone: 'The Venomous Abyss', zoneId: ABYSS });
  });

  it('takes the unfrozen zone when a frozen copy shares the name', async () => {
    const { encounters } = await currentRaids.discoverCurrentRaids(wclWithZoneTree(expansions), ['The Venomous Abyss']);
    expect(encounters.map(encounter => encounter.id)).toEqual([NEKZALI, SENTINELS]);
    expect(encounters.every(encounter => encounter.zoneId === ABYSS)).toBe(true);
  });

  it('matches ignoring case and surrounding space, and sorts partitions newest-first', async () => {
    const { encounters } = await currentRaids.discoverCurrentRaids(wclWithZoneTree(expansions), ['  sporefall ']);
    expect(encounters[0]).toMatchObject({ id: ROTMIRE, zone: 'Sporefall', zoneId: SPOREFALL, partitionIds: [2, 1] });
  });

  it('contributes nothing for a name no current expansion zone carries, rather than guessing at a near match', async () => {
    const { encounters } = await currentRaids.discoverCurrentRaids(
      wclWithZoneTree(expansions), ['The Venomous Abyss Complete Raid', 'Manaforge Omega']);
    expect(encounters).toEqual([]);
  });

  it('protects exactly the named raids, so everything else on disk is pruned', async () => {
    const { protectedIds } = await currentRaids.discoverCurrentRaids(wclWithZoneTree(expansions), ['The Venomous Abyss']);
    expect([...protectedIds].sort((a, b) => a - b)).toEqual([SENTINELS, NEKZALI]);
  });

  it('protects nothing when no raid is named, which is what stops an unset variable pruning the dataset', async () => {
    const { encounters, protectedIds } = await currentRaids.discoverCurrentRaids(wclWithZoneTree(expansions), []);
    expect(encounters).toEqual([]);
    expect(protectedIds.size).toBe(0);
  });

  it('throws rather than pruning everything when WCL serves no zone tree', async () => {
    await expect(currentRaids.discoverCurrentRaids(wclWithZoneTree(null), ['The Venomous Abyss']))
      .rejects.toThrow('worldData.expansions');
  });
});

describe('discoverSpecMetas', () => {
  it('composes the folder key as spec.slug + class.slug and carries the WCL slugs + labels', async () => {
    const metas = await currentRaids.discoverSpecMetas(wclWithClasses(classes));
    expect(metas.find(meta => meta.spec === 'SubtletyRogue')).toMatchObject(
      { className: 'Rogue', specName: 'Subtlety', classLabel: 'Rogue', specLabel: 'Subtlety' });
    expect(metas.find(meta => meta.spec === 'BeastMasteryHunter')).toMatchObject(
      { className: 'Hunter', specName: 'BeastMastery', specLabel: 'Beast Mastery' });
  });

  it('derives the class icon formulaically from the lowercased class slug', async () => {
    const metas = await currentRaids.discoverSpecMetas(wclWithClasses(classes));
    expect(metas.find(meta => meta.spec === 'SubtletyRogue')?.classIcon).toBe('class_rogue');
    expect(metas.find(meta => meta.spec === 'DevourerDemonHunter')?.classIcon).toBe('class_demonhunter');
  });

  it('leaves the spec icon empty (the orchestrator fills it from the rulebook)', async () => {
    const metas = await currentRaids.discoverSpecMetas(wclWithClasses(classes));
    expect(metas.every(meta => meta.specIcon === '')).toBe(true);
  });

  it('yields no meta when WCL serves no class', async () => {
    expect(await currentRaids.discoverSpecMetas(wclWithClasses([]))).toEqual([]);
  });
});

describe('assertPointsBudget', () => {
  const MARGIN = 500;
  const LIMIT_PER_HOUR = 36_000;
  /** Leaves exactly the margin remaining. */
  const SPENT_AT_MARGIN = LIMIT_PER_HOUR - MARGIN;
  const REMAINING_UNDER_MARGIN = MARGIN - 1;

  it('allows the run to continue when the remaining points exactly meet the margin', async () => {
    const budget = { limitPerHour: LIMIT_PER_HOUR, pointsSpentThisHour: SPENT_AT_MARGIN };
    await expect(currentRaids.assertPointsBudget(wclWithBudget(budget), MARGIN)).resolves.toBeUndefined();
  });

  it('stops the run one point under the margin, naming what is left', async () => {
    const budget = { limitPerHour: LIMIT_PER_HOUR, pointsSpentThisHour: SPENT_AT_MARGIN + 1 };
    await expect(currentRaids.assertPointsBudget(wclWithBudget(budget), MARGIN)).rejects.toThrow(BudgetExceededError);
    await expect(currentRaids.assertPointsBudget(wclWithBudget(budget), MARGIN))
      .rejects.toThrow(`WCL budget low: ${REMAINING_UNDER_MARGIN} of ${LIMIT_PER_HOUR} remaining (need ${MARGIN})`);
  });

  it('lets the run proceed when WCL serves no rate-limit block, since an unknown budget is not an exhausted one', async () => {
    await expect(currentRaids.assertPointsBudget(wclWithBudget(null), MARGIN)).resolves.toBeUndefined();
  });
});
