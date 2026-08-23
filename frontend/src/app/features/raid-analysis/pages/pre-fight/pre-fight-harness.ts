import { assert } from 'vitest';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { EncounterEntry, SpecEntry } from '../../../../domain/encounter/encounter.models';
import { SpecMeta } from '../../../../core/data-files/spec-meta.models';
import { Result, Results } from '../../../../core/http/result';
import { mapFeatureStub, stubBenchTokens } from '../../../../../testing/page-stubs';
import { BURST_DATA_SOURCE } from '../../burst-windows/data-access/burst-data-source';
import { ROTATION_DATA_SOURCE } from '../../rotation/data-access/rotation-data-source';
import { DEFENSIVE_DATA_SOURCE } from '../../defensive/data-access/defensive-data-source';
import { GEAR_DATA_SOURCE } from '../../gear/data-access/gear-data-source';
import { MAP_DATA_SOURCE } from '../../map/data-access/map-data-source';
import { NORTHERN_SKY_DATA_SOURCE } from '../../northern-sky/data-access/northern-sky-data-source';
import { DataFileApiService } from '../../../../core/data-files/data-file-api-service';
import { WclApiService } from '../../../../core/wcl/wcl-api-service';
import { SelectionStore } from '../../../../core/state/selection-store';
import { MapFeatureService } from '../../map/facade/map-feature-service';
import { EncounterSelectionService } from './encounter-selection-service';
import { PreFight } from './pre-fight';

// A card cannot construct without its data source, so every slice the shell mounts one for is listed here.
const SLICE_TOKENS = [
  BURST_DATA_SOURCE, ROTATION_DATA_SOURCE, DEFENSIVE_DATA_SOURCE,
  GEAR_DATA_SOURCE, MAP_DATA_SOURCE, NORTHERN_SKY_DATA_SOURCE,
];

export const SUBTLETY_ROGUE = 'SubtletyRogue';
const ASSASSINATION_ROGUE = 'AssassinationRogue';
export const FROST_MAGE = 'FrostMage';

const meta = (spec: string, className: string, specLabel: string): SpecMeta => ({
  spec, className, specName: specLabel, classLabel: className, specLabel, classIcon: 'icon', specIcon: 'icon',
});

// Two Rogue specs so a spec change is reachable without also changing class.
const SPEC_META: SpecMeta[] = [
  meta(SUBTLETY_ROGUE, 'Rogue', 'Subtlety'),
  meta(ASSASSINATION_ROGUE, 'Rogue', 'Assassination'),
  meta(FROST_MAGE, 'Mage', 'Frost'),
];

export const SPEC_INDEX: SpecEntry[] = [
  { spec: SUBTLETY_ROGUE, encounter_count: 2 },
  { spec: ASSASSINATION_ROGUE, encounter_count: 2 },
  { spec: FROST_MAGE, encounter_count: 2 },
];

/** An index is addressable only once its gate opens: no spec select before a class, no encounter select before a spec. */
export const CLASS_SELECT = 0;
export const SPEC_SELECT = 1;
export const ENCOUNTER_SELECT = 2;

export interface PreFightPage {
  readonly fixture: ComponentFixture<PreFight>;
  selectCount(): number;
  options(index: number): string[];
  choose(index: number, optionText: string): void;
  text(): string;
  /** The export card renders only while `selectedEncId()` holds, so its presence is the gate. */
  cardsShown(): boolean;
  settled(): Promise<void>;
  render(): void;
}

export function preFightPage(encounterSelection: Partial<EncounterSelectionService>): PreFightPage {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [PreFight],
    providers: [
      provideZonelessChangeDetection(),
      { provide: EncounterSelectionService, useValue: encounterSelection as EncounterSelectionService },
      { provide: MapFeatureService, useValue: mapFeatureStub() },
      {
        provide: SelectionStore,
        useValue: {
          savePreFight: () => undefined, loadPreFight: () => null,
          loadNorthernSky: () => null, saveNorthernSky: () => undefined,
        },
      },
      { provide: DataFileApiService, useValue: { getSpecMeta: (): Promise<Result<SpecMeta[]>> => Promise.resolve(Results.ok(SPEC_META)) } },
      // Injected at construction by the gear card, never called on a benched-missing page.
      { provide: WclApiService, useValue: {} },
      ...stubBenchTokens(SLICE_TOKENS),
    ] as never[],
  });

  const fixture = TestBed.createComponent(PreFight);
  fixture.detectChanges();

  const host = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const clean = (el: Element): string => el.textContent.replace(/\s+/g, ' ').trim();
  const render = (): void => { fixture.detectChanges(); };

  // Driven by hand: the page holds a pending task while encounters load, so `whenStable()` deadlocks on a parked read.
  const selectAt = (index: number): HTMLElement => {
    const select = host().querySelectorAll<HTMLElement>('mat-select')[index];
    assert.exists(select);
    return select;
  };
  const openOptions = (index: number): HTMLElement[] => {
    const select = selectAt(index);
    const trigger = select.querySelector<HTMLElement>('.mat-mdc-select-trigger');
    assert.exists(trigger);
    trigger.click();
    render();
    // A closed panel can linger in the document, so follow this select's own aria-controls to the live one.
    const panelId = select.getAttribute('aria-controls');
    const panel = panelId ? document.getElementById(panelId) : null;
    assert.exists(panel);
    return Array.from(panel.querySelectorAll<HTMLElement>('mat-option'));
  };
  const closePanel = (): void => {
    document.querySelector<HTMLElement>('.cdk-overlay-backdrop')?.click();
    render();
  };

  return {
    fixture,
    selectCount: () => host().querySelectorAll('mat-select').length,
    options(index) {
      const labels = openOptions(index).map(clean);
      closePanel();
      return labels;
    },
    choose(index, optionText) {
      const option = openOptions(index).find(candidate => clean(candidate).includes(optionText));
      if (!option) throw new Error(`choose: select ${index} has no option matching "${optionText}"`);
      option.click();
      render();
    },
    text: () => clean(host()),
    cardsShown: () => host().querySelector('wl-northern-sky-export') !== null,
    settled: () => fixture.whenStable(),
    render,
  };
}

export class ParkedEncounterSelection {
  private readonly resolvers = new Map<string, (result: Result<EncounterEntry[]>) => void>();

  getSpecs(): Promise<Result<SpecEntry[]>> {
    return Promise.resolve(Results.ok(SPEC_INDEX));
  }

  getEncounters(spec: string): Promise<Result<EncounterEntry[]>> {
    return new Promise(resolve => this.resolvers.set(spec, resolve));
  }

  settle(spec: string, encounters: EncounterEntry[]): void {
    const resolve = this.resolvers.get(spec);
    assert.exists(resolve);
    resolve(Results.ok(encounters));
  }
}
