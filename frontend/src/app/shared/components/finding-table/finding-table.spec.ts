import { describe, it, expect } from 'vitest';
import { mountVm } from '../../../../testing/component-harness';
import { FindingTable } from './finding-table';

describe('FindingTable', () => {
  const rows = [
    { severity: 'warning' as const, icon: '', measured: { value: '1 / 2' }, occurrences: [] },
    { severity: 'warning' as const, icon: '', measured: { value: '3 / 4' }, occurrences: [] },
  ];

  it('opens no row by default, so the table renders collapsed', () => {
    const { vm } = mountVm(FindingTable, { heading: 'Rules', rows });
    expect(vm.openIndex()).toBeNull();
  });

  it('toggle opens the clicked row', () => {
    const { vm } = mountVm(FindingTable, { heading: 'Rules', rows });
    vm.toggle(0);
    expect(vm.openIndex()).toBe(0);
  });

  it('toggle on the open row closes it', () => {
    const { vm } = mountVm(FindingTable, { heading: 'Rules', rows });
    vm.toggle(1);
    vm.toggle(1);
    expect(vm.openIndex()).toBeNull();
  });

  it('toggle on a different row replaces the open one, so at most one strip is open at a time', () => {
    const { vm } = mountVm(FindingTable, { heading: 'Rules', rows });
    vm.toggle(0);
    vm.toggle(1);
    expect(vm.openIndex()).toBe(1);
  });

  it('closes the open row when rows swaps to a different pull or player', () => {
    const { vm, setInput } = mountVm(FindingTable, { heading: 'Rules', rows });
    vm.toggle(1);
    expect(vm.openIndex()).toBe(1);

    const otherRows = [{ severity: 'critical' as const, icon: '', measured: { value: '5 / 6' }, occurrences: [] }];
    setInput('rows', otherRows);

    expect(vm.openIndex()).toBeNull();
  });
});
