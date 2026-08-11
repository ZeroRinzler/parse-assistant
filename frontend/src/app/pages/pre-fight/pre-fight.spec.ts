import { describe, it, expect } from 'vitest';
import { WritableSignal } from '@angular/core';
import { FormControl } from '@angular/forms';
import { EncounterEntry, SpecEntry } from '../../core/models/encounter.models';
import { LoadError, Result, ok } from '../../core/result';
import { mountVm } from '../../../testing/component-harness';
import { PreFightComponent } from './pre-fight';
import { EncounterSelectionService } from './encounter-selection.service';
import { MapFeatureService } from '../post-raid/map/map.service';
import { SelectionStore } from '../../core/services/selection-store';

// The template gates every feature card on `@if (selectedEncId())`, so 0 closes it.
const NO_ENCOUNTER = 0;
const SELECTED_ENCOUNTER_ID = 3144;
const OTHER_ENCOUNTER_ID = 3145;
const NEW_SPEC = 'SubtletyRogue';

const BENCHED_ENCOUNTER: EncounterEntry = { id: SELECTED_ENCOUNTER_ID, name: 'Boss A', sample_count: 12 };
const OTHER_BENCHED_ENCOUNTER: EncounterEntry = { id: OTHER_ENCOUNTER_ID, name: 'Boss B', sample_count: 9 };

const CARD_BUSY_SIGNALS = ['northernSkyBusy', 'gearBusy', 'cdPlanBusy', 'defensivePlanBusy', 'burstBusy'];

function providers(encounters: EncounterEntry[]): unknown[] {
  const encounterSelection = {
    getSpecs: (): Promise<Result<SpecEntry[], LoadError>> => Promise.resolve(ok([])),
    getEncounters: (_spec: string): Promise<Result<EncounterEntry[], LoadError>> => Promise.resolve(ok(encounters)),
  } as EncounterSelectionService;
  const mapFeature = {
    clear: (): void => undefined,
    loadBench: (): Promise<void> => Promise.resolve(),
  } as unknown as MapFeatureService;
  const selectionStore = { savePreFight: (): void => undefined } as unknown as SelectionStore;
  return [
    { provide: EncounterSelectionService, useValue: encounterSelection },
    { provide: MapFeatureService, useValue: mapFeature },
    { provide: SelectionStore, useValue: selectionStore },
  ];
}

function mountPreFight(encounters: EncounterEntry[] = [BENCHED_ENCOUNTER]) {
  return mountVm(PreFightComponent, {}, providers(encounters));
}

function selectedEncId(vm: Record<string, unknown>): number {
  return (vm['selectedEncId'] as () => number)();
}

function pickEncounter(vm: Record<string, unknown>, id: number): void {
  const encControl = vm['encControl'] as FormControl<number>;
  encControl.enable();
  encControl.setValue(id);
}

function cardsBusy(vm: Record<string, unknown>): boolean {
  return (vm['cardsBusy'] as () => boolean)();
}

function reportCardLoaded(vm: Record<string, unknown>, name: string): void {
  (vm[name] as WritableSignal<boolean>).set(false);
}

describe('PreFightComponent stale-encounter reset', () => {
  it('closes the encounter-gated cards when the class changes', () => {
    const { vm } = mountPreFight();
    pickEncounter(vm, SELECTED_ENCOUNTER_ID);
    expect(selectedEncId(vm)).toBe(SELECTED_ENCOUNTER_ID);

    (vm['onClassChange'] as () => void)();

    expect(selectedEncId(vm)).toBe(NO_ENCOUNTER);
  });

  it('closes the encounter-gated cards when the spec changes', async () => {
    const { vm } = mountPreFight();
    (vm['specControl'] as FormControl<string>).setValue(NEW_SPEC);
    pickEncounter(vm, SELECTED_ENCOUNTER_ID);
    expect(selectedEncId(vm)).toBe(SELECTED_ENCOUNTER_ID);

    await (vm['onSpecChange'] as () => Promise<void>)();

    expect(selectedEncId(vm)).toBe(NO_ENCOUNTER);
  });
});

describe('PreFightComponent card loading state', () => {
  it('reports the cards busy before any of them has loaded', () => {
    const { vm } = mountPreFight();

    expect(cardsBusy(vm)).toBe(true);
  });

  it('stays busy while one card is still loading', () => {
    const { vm } = mountPreFight();

    for (const name of CARD_BUSY_SIGNALS.slice(0, -1)) reportCardLoaded(vm, name);

    expect(cardsBusy(vm)).toBe(true);
  });

  it('clears the busy state once every card has loaded', () => {
    const { vm } = mountPreFight();

    for (const name of CARD_BUSY_SIGNALS) reportCardLoaded(vm, name);

    expect(cardsBusy(vm)).toBe(false);
  });

  it('goes busy again when another encounter is picked', async () => {
    const { vm } = mountPreFight([BENCHED_ENCOUNTER, OTHER_BENCHED_ENCOUNTER]);
    (vm['specControl'] as FormControl<string>).setValue(NEW_SPEC);
    pickEncounter(vm, SELECTED_ENCOUNTER_ID);
    for (const name of CARD_BUSY_SIGNALS) reportCardLoaded(vm, name);
    expect(cardsBusy(vm)).toBe(false);

    pickEncounter(vm, OTHER_ENCOUNTER_ID);
    await (vm['onEncChange'] as () => Promise<void>)();

    expect(cardsBusy(vm)).toBe(true);
  });
});
