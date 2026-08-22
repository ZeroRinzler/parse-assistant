import { describe, it, expect } from 'vitest';
import { Clipboard } from '@angular/cdk/clipboard';
import { ok, Result, transient } from '../../../core/result';
import { mountDom, MountedDom } from '../../../../testing/component-harness';
import { SelectionStore } from '../../../core/services/selection-store';
import { NorthernSkyExportComponent } from './northern-sky-export';
import { NorthernSkyFeatureService } from './northern-sky.service';
import { NorthernSkyAbility, NorthernSkyBench } from './northern-sky-data-source';
import { SHADOW_BLADES, EVASION } from '../../../../testing/spell-ids';
import { whenStable } from '../../../../testing/when-stable';
import { NORTHERN_SKY_ENCOUNTER_ID, NORTHERN_SKY_SPEC, bench } from './northern-sky-harness';

const CAST_TIMES_S = [10, 30];
const EXPORT_BUTTON = 'button[mat-stroked-button]';
const COPY_BUTTON = 'button[mat-flat-button]';
const CHECKBOX = 'mat-checkbox input[type="checkbox"]';
const COPIED_MESSAGE = 'Copied to clipboard.';
const FAILED_MESSAGE = 'Clipboard write failed. Retry the copy.';

function ability(spellId: number, kind: NorthernSkyAbility['kind']): NorthernSkyAbility {
  return { spell_id: spellId, name: `name_${spellId}`, icon: `icon_${spellId}`, kind, cast_times_s: CAST_TIMES_S };
}

const POPULATED_ABILITIES = [ability(SHADOW_BLADES, 'cooldown'), ability(EVASION, 'defensive')];

interface Mounted {
  readonly dom: MountedDom;
  readonly copies: string[];
}

async function mount(
  getExport: () => Promise<Result<NorthernSkyBench>>,
  copySucceeds = true,
): Promise<Mounted> {
  const copies: string[] = [];
  const feature = { getExport } as unknown as NorthernSkyFeatureService;
  const selection = { loadNorthernSky: () => null, saveNorthernSky: () => undefined } as unknown as SelectionStore;
  const clipboard = {
    copy: (text: string) => { copies.push(text); return copySucceeds; },
  } as unknown as Clipboard;

  const dom = mountDom(NorthernSkyExportComponent, { spec: NORTHERN_SKY_SPEC, encounterId: NORTHERN_SKY_ENCOUNTER_ID }, [
    { provide: NorthernSkyFeatureService, useValue: feature },
    { provide: SelectionStore, useValue: selection },
    { provide: Clipboard, useValue: clipboard },
  ]);
  await whenStable();
  dom.detectChanges();
  return { dom, copies };
}

describe('NorthernSkyExportComponent export availability', () => {
  it('waits, with no error banner, when the bench carries no abilities', async () => {
    const { dom } = await mount(async () => ok(bench()));

    expect(dom.query('wl-load-state')).not.toBeNull();
    expect(dom.query(EXPORT_BUTTON)).toBeNull();
    expect(dom.text()).toContain('Waiting for top parses');
  });

  it('offers the export button once the bench carries at least one ability', async () => {
    const { dom } = await mount(async () => ok(bench({ abilities: POPULATED_ABILITIES })));

    expect(dom.query('wl-load-state')).toBeNull();
    expect(dom.query(EXPORT_BUTTON)).not.toBeNull();
    expect(dom.text()).toContain('Northern Sky export');
  });

  it('shows the load error instead of the export button when the bench fails to load', async () => {
    const MESSAGE = 'WCL is unreachable right now.';
    const { dom } = await mount(async () => transient(MESSAGE));

    expect(dom.query(EXPORT_BUTTON)).toBeNull();
    expect(dom.text()).toContain(MESSAGE);
  });
});

describe('NorthernSkyExportComponent copy', () => {
  const openPanel = async (copySucceeds = true): Promise<Mounted> => {
    const mounted = await mount(async () => ok(bench({ abilities: POPULATED_ABILITIES })), copySucceeds);
    mounted.dom.click(EXPORT_BUTTON);
    return mounted;
  };

  it('opens the export panel with a copy action and one checkbox per ability', async () => {
    const { dom } = await openPanel();

    expect(dom.query(COPY_BUTTON)).not.toBeNull();
    expect(dom.queryAll(CHECKBOX)).toHaveLength(POPULATED_ABILITIES.length);
  });

  it('confirms the copy, and hands the clipboard a note naming every selected ability', async () => {
    const { dom, copies } = await openPanel();

    dom.click(COPY_BUTTON);

    expect(dom.text()).toContain(COPIED_MESSAGE);
    expect(dom.text()).not.toContain(FAILED_MESSAGE);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toContain(`spellid:${SHADOW_BLADES}`);
    expect(copies[0]).toContain(`spellid:${EVASION}`);
  });

  it('reports the failure, and no confirmation, when the clipboard write is refused', async () => {
    const { dom } = await openPanel(false);

    dom.click(COPY_BUTTON);

    expect(dom.text()).toContain(FAILED_MESSAGE);
    expect(dom.text()).not.toContain(COPIED_MESSAGE);
  });

  it('leaves a deselected ability out of the copied note', async () => {
    const { dom, copies } = await openPanel();

    dom.queryAll(CHECKBOX)[0]?.click();
    dom.detectChanges();
    dom.click(COPY_BUTTON);

    expect(copies[0]).not.toContain(`spellid:${SHADOW_BLADES}`);
    expect(copies[0]).toContain(`spellid:${EVASION}`);
  });

  it('drops every ability from the note on deselect all', async () => {
    const { dom, copies } = await openPanel();

    dom.click('button[mat-button]');
    dom.click(COPY_BUTTON);

    expect(copies[0]).not.toContain('spellid:');
  });
});
