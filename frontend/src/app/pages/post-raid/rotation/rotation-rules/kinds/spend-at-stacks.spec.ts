import { describe, it, expect } from 'vitest';
import { SpendAtStacksCondition } from '../../../../../core/models/rulebook.models';
import { LIGHTNING_BOLT, MAELSTROM_WEAPON, SHADOW_DANCE } from '../../../../../../testing/spell-ids';
import { cast, applyBuff, removeBuff, applyBuffStack, buffWindow } from '../../../../../../testing/builders/events';
import { band, benched, judged, ruleCtx, ruleFor } from '../rule-fixtures';
import { evaluateRules, ruleApplicable, ruleLabel, rulesFollowed, sampleRule } from '../engine';
import { evaluateSpendAtStacks as rawSpendAtStacks } from './spend-at-stacks';

const evaluateSpendAtStacks = judged(rawSpendAtStacks);

describe('evaluateSpendAtStacks', () => {
  // What the field holds before spending, supplied as a measured band.
  const FIELD_STACKS = 8;
  // Top of the `climbing` fixture below, standing in for the buff's own cap.
  const MAELSTROM_WEAPON_MAX_STACKS = 10;
  const spendAtStacks: SpendAtStacksCondition = {
    kind: 'spend_at_stacks',
    spell_id: LIGHTNING_BOLT, spell_name: 'Lightning Bolt',
    buff_spell_id: MAELSTROM_WEAPON, buff_spell_name: 'Maelstrom Weapon',
    bound: 'min', max_stacks: MAELSTROM_WEAPON_MAX_STACKS,
  };
  // One stack lands each second from t=1.
  const climbing = [applyBuff(MAELSTROM_WEAPON, 1), ...Array.from({ length: 9 }, (_, i) => applyBuffStack(MAELSTROM_WEAPON, i + 2, i + 2))];
  // The count read is the one in force GOING INTO the cast, so a cast one second after the Nth stack holds N.
  const holding = (stacks: number) => stacks + 1;

  it('flags a spender pressed below the count the field waits for', () => {
    const ctx = ruleCtx([cast(LIGHTNING_BOLT, holding(3))], { buffs: climbing });
    expect(evaluateSpendAtStacks(spendAtStacks, ctx, band(FIELD_STACKS), 'warning')?.measured)
      .toEqual({ value: '1 / 1', unit: 'cast(s)' });
  });

  it('passes a spender pressed at the field count, and flags one a stack below it', () => {
    const onCount = ruleCtx([cast(LIGHTNING_BOLT, holding(FIELD_STACKS))], { buffs: climbing });
    const underIt = ruleCtx([cast(LIGHTNING_BOLT, holding(FIELD_STACKS - 1))], { buffs: climbing });
    expect(evaluateSpendAtStacks(spendAtStacks, onCount, band(FIELD_STACKS), 'warning')).toBeNull();
    expect(evaluateSpendAtStacks(spendAtStacks, underIt, band(FIELD_STACKS), 'warning')).not.toBeNull();
  });

  it('reads the count going into the cast, since a spend and the cast that spends it share one timestamp', () => {
    const SPEND_AT_S = 6, STACKS_HELD = SPEND_AT_S - 1;
    const buffs = [
      applyBuff(MAELSTROM_WEAPON, 1),
      ...Array.from({ length: STACKS_HELD - 1 }, (_, i) => applyBuffStack(MAELSTROM_WEAPON, i + 2, i + 2)),
      removeBuff(MAELSTROM_WEAPON, SPEND_AT_S),
    ];
    const ctx = ruleCtx([cast(LIGHTNING_BOLT, SPEND_AT_S)], { buffs });
    // Reading the post-consumption value would see 0 here and flag every spend in the log.
    expect(sampleRule(spendAtStacks, ctx).values).toEqual([STACKS_HELD]);
  });

  it('inverts for bound "max", flagging a generator pressed while the buff is nearly capped', () => {
    const generateAtCap: SpendAtStacksCondition = { ...spendAtStacks, bound: 'max' };
    // The field generates at 3; this cast holds 9.
    const FIELD_GENERATES_AT = 3;
    const ctx = ruleCtx([cast(LIGHTNING_BOLT, holding(9))], { buffs: climbing });
    // The ceiling assertion pins lo at 0 so 9 cannot also trip the far side; the floor assertion pins hi past 9 for the same reason.
    expect(evaluateSpendAtStacks(generateAtCap, ctx, band(0, FIELD_GENERATES_AT), 'warning')?.message)
      .toContain('overcapping');
    expect(evaluateSpendAtStacks(spendAtStacks, ctx, band(FIELD_GENERATES_AT, MAELSTROM_WEAPON_MAX_STACKS), 'warning')).toBeNull();
  });

  it('drops casts made in a state that suspends the rule', () => {
    const suspended: SpendAtStacksCondition = {
      ...spendAtStacks, except_buff_spell_ids: [SHADOW_DANCE], except_buff_spell_names: ['Ascendance'],
    };
    const buffs = [...climbing, ...buffWindow(SHADOW_DANCE, 3, 6)];
    const ctx = ruleCtx([cast(LIGHTNING_BOLT, holding(3))], { buffs });
    expect(evaluateSpendAtStacks(suspended, ctx, band(FIELD_STACKS), 'warning')).toBeNull();
    expect(evaluateSpendAtStacks(spendAtStacks, ctx, band(FIELD_STACKS), 'warning')).not.toBeNull();
  });

  it('is not applicable on a build where the buff never appeared', () => {
    expect(ruleApplicable(spendAtStacks, ruleCtx([cast(LIGHTNING_BOLT, 4)]))).toBe(false);
  });

  it('is not applicable when every cast falls before the buff\'s first recorded trace, so nothing is measurable', () => {
    const PRE_PULL_DROP_S = 5; // the buff was already up at pull; its first trace is this bare remove
    const buffs = [removeBuff(MAELSTROM_WEAPON, PRE_PULL_DROP_S)];
    const ctx = ruleCtx([cast(LIGHTNING_BOLT, PRE_PULL_DROP_S - 1)], { buffs });
    const rule = ruleFor(spendAtStacks, { description: 'spend at stacks' });
    expect(ruleApplicable(spendAtStacks, ctx)).toBe(false);
    expect(evaluateRules([benched(rule)], ctx)).toEqual([]);
    expect(rulesFollowed([benched(rule)], ctx)).toEqual([]);
  });

  it('does not flag an opener spent under a buff already up at pull, but still flags a genuine low-stack spend later', () => {
    const PRE_PULL_DROP_S = 2; // the buff was already up at pull; its first trace is this bare remove
    const LATER_APPLY_S = 10, LATER_SPEND_S = 12; // a fresh application later in the pull, spent cheap
    const buffs = [
      removeBuff(MAELSTROM_WEAPON, PRE_PULL_DROP_S),
      applyBuff(MAELSTROM_WEAPON, LATER_APPLY_S),
      applyBuffStack(MAELSTROM_WEAPON, LATER_APPLY_S + 1, 2),
    ];
    const opener = ruleCtx([cast(LIGHTNING_BOLT, PRE_PULL_DROP_S - 1)], { buffs });
    const laterCheapSpend = ruleCtx([cast(LIGHTNING_BOLT, LATER_SPEND_S)], { buffs });
    expect(evaluateSpendAtStacks(spendAtStacks, opener, band(FIELD_STACKS), 'warning')).toBeNull();
    expect(evaluateSpendAtStacks(spendAtStacks, laterCheapSpend, band(FIELD_STACKS), 'warning')).not.toBeNull();
  });

  it('samples every spend\'s own stack count, so the field-wide pool - not a per-parse reduction - finds the floor', () => {
    const ctx = ruleCtx([cast(LIGHTNING_BOLT, holding(3)), cast(LIGHTNING_BOLT, holding(9))], { buffs: climbing });
    expect(sampleRule(spendAtStacks, ctx).values).toEqual([3, 9]);
    expect(sampleRule(spendAtStacks, ruleCtx([], { buffs: climbing })).values).toEqual([]);
  });

  it('samples a cast made before the first stack landed as zero, not as unmeasured', () => {
    const BEFORE_FIRST_STACK_S = 0.5;
    const ctx = ruleCtx([cast(LIGHTNING_BOLT, BEFORE_FIRST_STACK_S), cast(LIGHTNING_BOLT, holding(9))], { buffs: climbing });
    expect(sampleRule(spendAtStacks, ctx).values).toEqual([0, 9]);
  });

  it('flags a spend below the field floor and passes one exactly on it', () => {
    const FLOOR = 5;
    const onFloor = ruleCtx([cast(LIGHTNING_BOLT, holding(FLOOR))], { buffs: climbing });
    const underFloor = ruleCtx([cast(LIGHTNING_BOLT, holding(FLOOR - 1))], { buffs: climbing });
    expect(evaluateSpendAtStacks(spendAtStacks, onFloor, band(FLOOR), 'warning')).toBeNull();
    expect(evaluateSpendAtStacks(spendAtStacks, underFloor, band(FLOOR), 'warning')).not.toBeNull();
  });

  it('does not fire at exactly the tolerance share, and fires one instance past it (strict)', () => {
    const TOLERANCE = 0.2;
    const FLOOR = 8;
    // Strictly inside (FLOOR - 1, FLOOR) reads FLOOR - 1 (a violation); strictly inside (FLOOR, FLOOR + 1) reads FLOOR.
    const belowTime = (i: number) => FLOOR - 1 + 0.5 + i / 100;
    const atFloorTime = (i: number) => FLOOR + 0.5 + i / 100;
    const scenario = (belowCount: number) => ruleCtx([
      ...Array.from({ length: belowCount }, (_, i) => cast(LIGHTNING_BOLT, belowTime(i))),
      ...Array.from({ length: 10 - belowCount }, (_, i) => cast(LIGHTNING_BOLT, atFloorTime(i))),
    ], { buffs: climbing });
    // 2 of 10 below the floor: 2 > 10 * 0.2 is false.
    expect(evaluateSpendAtStacks(spendAtStacks, scenario(2), band(FLOOR, FLOOR, TOLERANCE), 'warning')).toBeNull();
    // 3 of 10 below the floor: 3 > 10 * 0.2 is true.
    expect(evaluateSpendAtStacks(spendAtStacks, scenario(3), band(FLOOR, FLOOR, TOLERANCE), 'warning')).not.toBeNull();
  });

  it('labels the rule as "<spender> at <buff>"', () => {
    expect(ruleLabel(spendAtStacks)).toBe('Lightning Bolt at Maelstrom Weapon');
  });

  it('flags the far side: a spender held to the buff\'s own cap, over the field\'s own ceiling', () => {
    const FIELD_LO = 3, FIELD_HI = 8;
    const overCap = ruleCtx([cast(LIGHTNING_BOLT, holding(MAELSTROM_WEAPON_MAX_STACKS))], { buffs: climbing });
    const atHi = ruleCtx([cast(LIGHTNING_BOLT, holding(FIELD_HI))], { buffs: climbing });
    const finding = evaluateSpendAtStacks(spendAtStacks, overCap, band(FIELD_LO, FIELD_HI), 'warning', 'do x');
    expect(finding?.message).toBe('1 of 1 Lightning Bolt casts were held past 8/10 stacks of Maelstrom Weapon. Spend before you cap.');
    expect(finding?.details?.remedy).toBe('do x');
    expect(evaluateSpendAtStacks(spendAtStacks, atHi, band(FIELD_LO, FIELD_HI), 'warning', 'do x')).toBeNull();
  });
});

describe('occurrence strips', () => {
  it('spend_at_stacks: a chip per cast, the count against the cap as the label', () => {
    const spendAtStacks: SpendAtStacksCondition = {
      kind: 'spend_at_stacks',
      spell_id: LIGHTNING_BOLT, spell_name: 'Lightning Bolt',
      buff_spell_id: MAELSTROM_WEAPON, buff_spell_name: 'Maelstrom Weapon',
      bound: 'min', max_stacks: 10,
    };
    const buffs = [applyBuff(MAELSTROM_WEAPON, 1), applyBuffStack(MAELSTROM_WEAPON, 5, 5), applyBuffStack(MAELSTROM_WEAPON, 9, 9)];
    const ctx = ruleCtx([cast(LIGHTNING_BOLT, 6), cast(LIGHTNING_BOLT, 10)], { buffs });
    // hi at 9 (not the degenerate 8-8) so the second cast, one above the floor, does not itself trip the far side.
    const finding = evaluateSpendAtStacks(spendAtStacks, ctx, band(8, 9), 'warning');
    expect(finding?.occurrences).toEqual([
      { atS: 6, ok: false, label: '5/10', detail: 'Lightning Bolt cast at 5/10.' },
      { atS: 10, ok: true, label: '9/10', detail: 'Lightning Bolt cast at 9/10.' },
    ]);
    expect(finding?.occurrenceTarget).toBe('Spend at 8/10 or more.');
    expect(finding?.message).toBe('1 of 2 Lightning Bolt casts were spent under 8/10 stacks of Maelstrom Weapon. Spend at 8/10 or more.');
  });
});
