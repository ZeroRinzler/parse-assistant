import { describe, it, expect } from 'vitest';
import { Clipboard } from '@angular/cdk/clipboard';
import { missing, transient, ok, Result, LoadError } from '../../../core/result';
import { mountVm } from '../../../../testing/component-harness';
import { SelectionStore } from '../../../core/services/selection-store';
import { NorthernSkyExportComponent } from './northern-sky-export';
import { NorthernSkyFeatureService } from './northern-sky.service';
import { NorthernSkyBench } from './northern-sky-data-source';

const SPEC = 'SubtletyRogue';
const ENCOUNTER_ID = 3009;
const OUTAGE_MESSAGE = 'WCL is unreachable right now.';
const NOT_INGESTED_MESSAGE = 'Not yet ingested.';

function bench(): NorthernSkyBench {
  return { spec: SPEC, encounter_id: ENCOUNTER_ID, encounter_name: 'Boss', abilities: [] };
}

// The constructor effect fires an async load; a macrotask flush lets its `.then` land before assertions run.
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

function mount(getExport: () => Promise<Result<NorthernSkyBench, LoadError>>, copySucceeds = true) {
  const feature = { getExport } as unknown as NorthernSkyFeatureService;
  const selection = { loadNorthernSky: () => null, saveNorthernSky: () => undefined } as unknown as SelectionStore;
  const clipboard = { copy: () => copySucceeds } as unknown as Clipboard;
  return mountVm(NorthernSkyExportComponent, { spec: SPEC, encounterId: ENCOUNTER_ID }, [
    { provide: NorthernSkyFeatureService, useValue: feature },
    { provide: SelectionStore, useValue: selection },
    { provide: Clipboard, useValue: clipboard },
  ]);
}

describe('NorthernSkyExportComponent load error handling', () => {
  it('surfaces a retry error when the bench load hits a transient outage', async () => {
    const { vm } = mount(async () => transient(OUTAGE_MESSAGE));

    await settle();

    expect((vm['error'] as () => LoadError | null)()).toEqual({ kind: 'transient', message: OUTAGE_MESSAGE });
    expect((vm['available'] as () => boolean)()).toBe(false);
  });

  it('stays the silent empty state, with no error, when the bench is simply not ingested yet', async () => {
    const { vm } = mount(async () => missing(NOT_INGESTED_MESSAGE));

    await settle();

    expect((vm['error'] as () => LoadError | null)()).toBeNull();
    expect((vm['available'] as () => boolean)()).toBe(false);
  });

  it('clears a previous error once the bench loads successfully', async () => {
    const { vm } = mount(async () => ok(bench()));

    await settle();

    expect((vm['error'] as () => LoadError | null)()).toBeNull();
  });
});

describe('NorthernSkyExportComponent copyNote', () => {
  it('shows the confirmation and not the failure state on a successful copy', async () => {
    const { vm } = mount(async () => ok(bench()), true);

    await settle();
    (vm['copyNote'] as () => void)();

    expect((vm['copied'] as () => boolean)()).toBe(true);
    expect((vm['copyFailed'] as () => boolean)()).toBe(false);
  });

  it('shows the failure state and not the confirmation when the clipboard write fails', async () => {
    const { vm } = mount(async () => ok(bench()), false);

    await settle();
    (vm['copyNote'] as () => void)();

    expect((vm['copied'] as () => boolean)()).toBe(false);
    expect((vm['copyFailed'] as () => boolean)()).toBe(true);
  });
});
