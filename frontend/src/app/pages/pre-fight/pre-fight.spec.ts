import { describe, it, expect } from 'vitest';
import { EncounterEntry, SpecEntry } from '../../core/models/encounter.models';
import { Result, ok } from '../../core/result';
import {
  CLASS_SELECT, ENCOUNTER_SELECT, FROST_MAGE, SPEC_INDEX, SPEC_SELECT, SUBTLETY_ROGUE,
  ParkedEncounterSelection, preFightPage,
} from './pre-fight-harness';

const BOSS_A: EncounterEntry = { id: 3144, name: 'Boss A', sample_count: 12 };
const BOSS_B: EncounterEntry = { id: 3145, name: 'Boss B', sample_count: 9 };

const ROGUE_ENCOUNTERS = [BOSS_A, BOSS_B];

function staticSelection(encounters: EncounterEntry[] = ROGUE_ENCOUNTERS): Partial<ParkedEncounterSelection> {
  return {
    getSpecs: (): Promise<Result<SpecEntry[]>> => Promise.resolve(ok(SPEC_INDEX)),
    getEncounters: (): Promise<Result<EncounterEntry[]>> => Promise.resolve(ok(encounters)),
  };
}

async function pickThrough(encounters: EncounterEntry[] = ROGUE_ENCOUNTERS) {
  const page = preFightPage(staticSelection(encounters));
  await page.settled();
  page.render();

  page.choose(CLASS_SELECT, 'Rogue');
  await page.settled();
  page.choose(SPEC_SELECT, 'Subtlety');
  await page.settled();
  page.render();
  return page;
}

describe('PreFightComponent encounter selection', () => {
  it('reveals the spec select only once a class is picked', async () => {
    const page = preFightPage(staticSelection());
    await page.settled();
    page.render();

    expect(page.selectCount()).toBe(1);

    page.choose(CLASS_SELECT, 'Rogue');
    await page.settled();

    expect(page.selectCount()).toBeGreaterThan(SPEC_SELECT);
  });

  it('lists the encounters of the picked spec', async () => {
    const page = await pickThrough();
    expect(page.options(ENCOUNTER_SELECT)).toEqual([BOSS_A.name, BOSS_B.name]);
  });

  it('opens the plan cards once an encounter is picked', async () => {
    const page = await pickThrough();
    expect(page.cardsShown()).toBe(false);

    page.choose(ENCOUNTER_SELECT, BOSS_A.name);
    await page.settled();
    page.render();

    expect(page.cardsShown()).toBe(true);
  });
});

describe('PreFightComponent stale-encounter reset', () => {
  it('closes the encounter-gated cards when the class changes', async () => {
    const page = await pickThrough();
    page.choose(ENCOUNTER_SELECT, BOSS_A.name);
    await page.settled();
    page.render();
    expect(page.cardsShown()).toBe(true);

    page.choose(CLASS_SELECT, 'Mage');
    await page.settled();
    page.render();

    expect(page.cardsShown()).toBe(false);
  });

  it('closes the encounter-gated cards when the spec changes', async () => {
    const page = await pickThrough();
    page.choose(ENCOUNTER_SELECT, BOSS_A.name);
    await page.settled();
    page.render();
    expect(page.cardsShown()).toBe(true);

    page.choose(SPEC_SELECT, 'Assassination');
    await page.settled();
    page.render();

    expect(page.cardsShown()).toBe(false);
  });

  it('names the newly picked encounter in the waiting banner when the bench is empty', async () => {
    const page = await pickThrough();

    page.choose(ENCOUNTER_SELECT, BOSS_B.name);
    await page.settled();
    page.render();

    expect(page.text()).toContain(BOSS_B.name);
  });
});

describe('PreFightComponent encounter load latest-wins', () => {
  const SLOW_ENCOUNTER: EncounterEntry = { id: 3129, name: 'Boss Slow', sample_count: 9 };
  const NEWER_ENCOUNTER: EncounterEntry = { id: 3131, name: 'Boss Newer', sample_count: 4 };
  const LOADING_ENCOUNTERS = 'Loading encounters';

  async function parkedPage() {
    const api = new ParkedEncounterSelection();
    const page = preFightPage(api);
    await page.settled();
    page.render();
    page.choose(CLASS_SELECT, 'Rogue');
    page.render();
    return { api, page };
  }

  it('shows the newer spec\'s encounters when the responses arrive in order', async () => {
    const { api, page } = await parkedPage();

    page.choose(SPEC_SELECT, 'Subtlety');
    api.settle(SUBTLETY_ROGUE, [SLOW_ENCOUNTER]);
    await page.settled();
    page.render();
    expect(page.options(ENCOUNTER_SELECT)).toEqual([SLOW_ENCOUNTER.name]);

    page.choose(CLASS_SELECT, 'Mage');
    page.choose(SPEC_SELECT, 'Frost');
    api.settle(FROST_MAGE, [NEWER_ENCOUNTER]);
    await page.settled();
    page.render();

    expect(page.options(ENCOUNTER_SELECT)).toEqual([NEWER_ENCOUNTER.name]);
  });

  it('keeps the newer spec\'s encounters when the earlier request resolves after it', async () => {
    const { api, page } = await parkedPage();

    page.choose(SPEC_SELECT, 'Subtlety');
    page.choose(CLASS_SELECT, 'Mage');
    page.choose(SPEC_SELECT, 'Frost');

    // The stale response settles last, so its handler runs against an already-applied newer result.
    api.settle(FROST_MAGE, [NEWER_ENCOUNTER]);
    api.settle(SUBTLETY_ROGUE, [SLOW_ENCOUNTER]);
    await page.settled();
    page.render();

    expect(page.options(ENCOUNTER_SELECT)).toEqual([NEWER_ENCOUNTER.name]);
    expect(page.text()).not.toContain(LOADING_ENCOUNTERS);
  });

  it('holds the loading message until the pending request lands', async () => {
    const { api, page } = await parkedPage();

    page.choose(SPEC_SELECT, 'Subtlety');
    page.render();
    expect(page.text()).toContain(LOADING_ENCOUNTERS);

    api.settle(SUBTLETY_ROGUE, [NEWER_ENCOUNTER]);
    await page.settled();
    page.render();

    expect(page.text()).not.toContain(LOADING_ENCOUNTERS);
  });
});
