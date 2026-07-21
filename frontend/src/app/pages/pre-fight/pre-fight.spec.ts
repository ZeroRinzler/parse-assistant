import { describe, it, expect } from 'vitest';
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
const NEW_SPEC = 'SubtletyRogue';

const BENCHED_ENCOUNTER: EncounterEntry = { id: SELECTED_ENCOUNTER_ID, name: 'Boss A', sample_count: 12 };

function providers(encounters: EncounterEntry[]): unknown[] {
  const encounterSelection = {
    getSpecs: (): Promise<Result<SpecEntry[], LoadError>> => Promise.resolve(ok([])),
    getEncounters: (_spec: string): Promise<Result<EncounterEntry[], LoadError>> => Promise.resolve(ok(encounters)),
  } as EncounterSelectionService;
  const mapFeature = { clear: (): void => undefined } as unknown as MapFeatureService;
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

/** The signal the card gate reads; it mirrors `encControl.valueChanges`. */
function selectedEncId(vm: Record<string, unknown>): number {
  return (vm['selectedEncId'] as () => number)();
}

/** Mirror a user having picked an encounter, so the feature cards are showing. */
function pickEncounter(vm: Record<string, unknown>, id: number): void {
  const encControl = vm['encControl'] as FormControl<number>;
  encControl.enable();
  encControl.setValue(id);
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
