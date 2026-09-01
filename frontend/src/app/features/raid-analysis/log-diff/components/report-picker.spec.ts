import { describe, it, expect } from 'vitest';
import { mountVm } from '../../../../../testing/component-harness';
import { ReportPicker } from './report-picker';

describe('ReportPicker', () => {
  it('submit emits the trimmed pasted value', () => {
    const { vm } = mountVm(ReportPicker, { label: 'Log A' });
    const emitted: string[] = [];
    vm.urlSubmit.subscribe(v => emitted.push(v));

    vm['urlControl'].setValue('  AbCdEfGh12345678  ');
    vm['submit']();

    expect(emitted).toEqual(['AbCdEfGh12345678']);
  });

  it('submit emits nothing for a blank input', () => {
    const { vm } = mountVm(ReportPicker, { label: 'Log A' });
    const emitted: string[] = [];
    vm.urlSubmit.subscribe(v => emitted.push(v));

    vm['urlControl'].setValue('   ');
    vm['submit']();

    expect(emitted).toEqual([]);
  });

  it('forwards the picked fight and player ids as-is', () => {
    const { vm } = mountVm(ReportPicker, { label: 'Log A' });
    const fightEmitted: number[] = [];
    const playerEmitted: number[] = [];
    vm.fightChange.subscribe(v => fightEmitted.push(v));
    vm.playerChange.subscribe(v => playerEmitted.push(v));

    vm['onFightChange'](7);
    vm['onPlayerChange'](42);

    expect(fightEmitted).toEqual([7]);
    expect(playerEmitted).toEqual([42]);
  });

  it('resolves the selected player from the roster by id', () => {
    const players = [{ id: 1, name: 'Ana', spec: 'Rogue', server: '' }, { id: 2, name: 'Bo', spec: 'Mage', server: '' }];
    const { vm } = mountVm(ReportPicker, { label: 'Log A', players, selectedPlayerId: 2 });
    expect(vm['selectedPlayer']()).toEqual(players[1]);
  });

  it('has no selected player when the id matches nothing in the roster', () => {
    const { vm } = mountVm(ReportPicker, { label: 'Log A', players: [], selectedPlayerId: 2 });
    expect(vm['selectedPlayer']()).toBeNull();
  });
});
