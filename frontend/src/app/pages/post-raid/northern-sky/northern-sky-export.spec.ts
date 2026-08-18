import { describe, it, expect } from 'vitest';
import { Clipboard } from '@angular/cdk/clipboard';
import { ok, Result, LoadError } from '../../../core/result';
import { mountVm } from '../../../../testing/component-harness';
import { SelectionStore } from '../../../core/services/selection-store';
import { NorthernSkyExportComponent } from './northern-sky-export';
import { NorthernSkyFeatureService } from './northern-sky.service';
import { NorthernSkyAbility, NorthernSkyBench } from './northern-sky-data-source';
import { SHADOW_BLADES, EVASION } from '../../../../testing/spell-ids';
import { whenStable } from '../../../../testing/when-stable';

const SPEC = 'SubtletyRogue';
const ENCOUNTER_ID = 3009;
const CAST_TIMES_S = [10, 30];

function ability(spellId: number, kind: NorthernSkyAbility['kind']): NorthernSkyAbility {
  return { spell_id: spellId, name: `name_${spellId}`, icon: `icon_${spellId}`, kind, cast_times_s: CAST_TIMES_S };
}

const POPULATED_ABILITIES = [ability(SHADOW_BLADES, 'cooldown'), ability(EVASION, 'defensive')];

function bench(over: Partial<NorthernSkyBench> = {}): NorthernSkyBench {
  return { spec: SPEC, encounter_id: ENCOUNTER_ID, encounter_name: 'Boss', abilities: [], ...over };
}

function mount(getExport: () => Promise<Result<NorthernSkyBench>>, copySucceeds = true) {
  const feature = { getExport } as unknown as NorthernSkyFeatureService;
  const selection = { loadNorthernSky: () => null, saveNorthernSky: () => undefined } as unknown as SelectionStore;
  const clipboard = { copy: () => copySucceeds } as unknown as Clipboard;
  return mountVm(NorthernSkyExportComponent, { spec: SPEC, encounterId: ENCOUNTER_ID }, [
    { provide: NorthernSkyFeatureService, useValue: feature },
    { provide: SelectionStore, useValue: selection },
    { provide: Clipboard, useValue: clipboard },
  ]);
}

describe('NorthernSkyExportComponent export availability', () => {
  it('waits without an error when the bench carries no abilities', async () => {
    const { vm } = mount(async () => ok(bench()));

    await whenStable();

    expect((vm['error'] as () => LoadError | null)()).toBeNull();
    expect((vm['available'] as () => boolean)()).toBe(false);
  });

  it('offers the export once the bench carries at least one ability', async () => {
    const { vm } = mount(async () => ok(bench({ abilities: POPULATED_ABILITIES })));

    await whenStable();

    expect((vm['error'] as () => LoadError | null)()).toBeNull();
    expect((vm['available'] as () => boolean)()).toBe(true);
  });
});

describe('NorthernSkyExportComponent copyNote', () => {
  it('shows the confirmation and not the failure state on a successful copy', async () => {
    const { vm } = mount(async () => ok(bench({ abilities: POPULATED_ABILITIES })), true);

    await whenStable();
    (vm['copyNote'])();

    expect((vm['copied'] as () => boolean)()).toBe(true);
    expect((vm['copyFailed'] as () => boolean)()).toBe(false);
  });

  it('shows the failure state and not the confirmation when the clipboard write fails', async () => {
    const { vm } = mount(async () => ok(bench({ abilities: POPULATED_ABILITIES })), false);

    await whenStable();
    (vm['copyNote'])();

    expect((vm['copied'] as () => boolean)()).toBe(false);
    expect((vm['copyFailed'] as () => boolean)()).toBe(true);
  });
});
