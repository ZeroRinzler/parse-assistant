import { describe, it, expect } from 'vitest';
import { CollapsibleTextComponent } from './collapsible-text';
import { mountVm } from '../../../../testing/component-harness';

describe('CollapsibleTextComponent', () => {
  it('starts collapsed', () => {
    const { vm } = mountVm(CollapsibleTextComponent);
    expect((vm['expanded'] as () => boolean)()).toBe(false);
  });

  it('toggle() flips the expanded state', () => {
    const { vm } = mountVm(CollapsibleTextComponent);
    (vm['toggle'])();
    expect((vm['expanded'] as () => boolean)()).toBe(true);
    (vm['toggle'])();
    expect((vm['expanded'] as () => boolean)()).toBe(false);
  });
});
