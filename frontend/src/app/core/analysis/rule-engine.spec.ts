import { describe, it, expect } from 'vitest';
import { evaluateRules } from './rule-engine';
import { Events } from '../../../testing/builders/events';
import { castWithoutPriorRule, holdForAnchorRule } from '../../../testing/builders/rulebook';
import { FIGHT_START } from '../../../testing/time';
import { SHADOW_BLADES, SHADOW_DANCE, SECRET_TECHNIQUE, SYMBOLS_OF_DEATH } from '../../../testing/spell-ids';

describe('evaluateRules / cast_without_prior', () => {
  // RULE: Secret Technique must be cast within 5s of a Shadow Dance.
  const rule = castWithoutPriorRule(
    { spell_id: SECRET_TECHNIQUE, spell_name: 'Secret Technique', required_spell_id: SHADOW_DANCE, required_spell_name: 'Shadow Dance', window_s: 5 },
    { priority: 'critical', action: 'Always cast Secret Technique inside Shadow Dance.' },
  );

  it('flags a Secret Technique with no Shadow Dance in the preceding window', () => {
    const casts = Events.cast(SECRET_TECHNIQUE, '0:30').build();

    const findings = evaluateRules([rule], casts, FIGHT_START);

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].category).toBe('rule_violation');
    expect(findings[0].message).toContain('Secret Technique without Shadow Dance');
    expect(findings[0].details?.remedy).toBe('Always cast Secret Technique inside Shadow Dance.');
    expect(findings[0].timestamp_ms).toBe(30_000);
  });

  it('does not flag when Shadow Dance is cast within the window', () => {
    const casts = Events.cast(SHADOW_DANCE, '0:28').cast(SECRET_TECHNIQUE, '0:30').build();

    expect(evaluateRules([rule], casts, FIGHT_START)).toHaveLength(0);
  });

  it('treats the window boundary as satisfied (companion exactly window_s away)', () => {
    // Shadow Dance at 0:25, Secret Technique at 0:30 -> exactly 5s, still paired.
    const casts = Events.cast(SHADOW_DANCE, '0:25').cast(SECRET_TECHNIQUE, '0:30').build();

    expect(evaluateRules([rule], casts, FIGHT_START)).toHaveLength(0);
  });

  it('counts every unpaired cast and reports it against the total', () => {
    const casts = Events.cast(SECRET_TECHNIQUE, '0:10').cast(SECRET_TECHNIQUE, '0:40').cast(SHADOW_DANCE, '1:00').cast(SECRET_TECHNIQUE, '1:02').build();

    const findings = evaluateRules([rule], casts, FIGHT_START);

    expect(findings[0].message).toContain('2 of 3 cast(s)');
  });

  it('honours a "before" context-spell exception', () => {
    // Exception: a Symbols of Death up to 25s before excuses the missing Shadow Dance.
    const ruleWithException = castWithoutPriorRule({
      spell_id: SECRET_TECHNIQUE,
      spell_name: 'Secret Technique',
      required_spell_id: SHADOW_DANCE,
      required_spell_name: 'Shadow Dance',
      window_s: 5,
      exception: { context_spell_id: SYMBOLS_OF_DEATH, context_window_s: 25, position: 'before' },
    });
    const casts = Events.cast(SYMBOLS_OF_DEATH, '0:20').cast(SECRET_TECHNIQUE, '0:35').build();

    expect(evaluateRules([ruleWithException], casts, FIGHT_START)).toHaveLength(0);
  });
});

describe('evaluateRules / hold_cooldown_for_anchor', () => {
  // RULE: hold Shadow Dance + Secret Technique in the 20s before each Shadow Blades.
  const rule = holdForAnchorRule(
    { spell_ids: [SHADOW_DANCE, SECRET_TECHNIQUE], spell_names: ['Shadow Dance', 'Secret Technique'], anchor_spell_id: SHADOW_BLADES, anchor_spell_name: 'Shadow Blades', hold_window_s: 20 },
    { priority: 'high', action: 'Pool charges for Shadow Blades.' },
  );

  it('flags a charge spent inside the hold window before a (non-first) anchor', () => {
    // First Shadow Blades at 0:05 is exempt; second at 2:00 has a Dance at 1:50 (10s before).
    const casts = Events.cast(SHADOW_BLADES, '0:05').cast(SHADOW_DANCE, '1:50').cast(SHADOW_BLADES, '2:00').build();

    const findings = evaluateRules([rule], casts, FIGHT_START);

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning'); // priority 'high' -> warning
    expect(findings[0].message).toContain('Shadow Dance used in the 20s hold window before Shadow Blades');
    expect(findings[0].timestamp_ms).toBe(110_000);
  });

  it('does not flag a charge spent outside the hold window', () => {
    // Dance at 1:30 is 30s before the 2:00 anchor -> outside the 20s window.
    const casts = Events.cast(SHADOW_BLADES, '0:05').cast(SHADOW_DANCE, '1:30').cast(SHADOW_BLADES, '2:00').build();

    expect(evaluateRules([rule], casts, FIGHT_START)).toHaveLength(0);
  });

  it('exempts the very first anchor cast (nothing to hold for yet)', () => {
    const casts = Events.cast(SHADOW_DANCE, '0:01').cast(SHADOW_BLADES, '0:05').build();

    expect(evaluateRules([rule], casts, FIGHT_START)).toHaveLength(0);
  });
});

describe('evaluateRules / cast_without_prior / after exception', () => {
  // Exception: a Symbols of Death cast within 25s AFTER SecTech excuses the missing Dance.
  const ruleWithAfterException = castWithoutPriorRule({
    spell_id: SECRET_TECHNIQUE,
    spell_name: 'Secret Technique',
    required_spell_id: SHADOW_DANCE,
    required_spell_name: 'Shadow Dance',
    window_s: 5,
    exception: { context_spell_id: SYMBOLS_OF_DEATH, context_window_s: 25, position: 'after' },
  });

  it('excuses a cast when the context spell comes AFTER the primary within the window', () => {
    // SecTech at 0:20, Symbols at 0:30 (10s after) -> ct - t = 10, within 25s -> no violation.
    const casts = Events.cast(SECRET_TECHNIQUE, '0:20').cast(SYMBOLS_OF_DEATH, '0:30').build();
    expect(evaluateRules([ruleWithAfterException], casts, FIGHT_START)).toHaveLength(0);
  });

  it('flags the cast when the context spell comes BEFORE (not after) the primary', () => {
    // Symbols at 0:10, SecTech at 0:20 -> context is before primary -> "after" exception does NOT fire.
    const casts = Events.cast(SYMBOLS_OF_DEATH, '0:10').cast(SECRET_TECHNIQUE, '0:20').build();
    expect(evaluateRules([ruleWithAfterException], casts, FIGHT_START)).toHaveLength(1);
  });
});

describe('evaluateRules / hold_cooldown_for_anchor / exact boundary', () => {
  // RULE: hold Shadow Dance in the 20s before each Shadow Blades.
  const rule = holdForAnchorRule(
    { spell_ids: [SHADOW_DANCE], spell_names: ['Shadow Dance'], anchor_spell_id: SHADOW_BLADES, anchor_spell_name: 'Shadow Blades', hold_window_s: 20 },
    { priority: 'high', action: 'Pool for Shadow Blades.' },
  );

  it('does not flag a charge cast at exactly the anchor time (half-open: castTime < anchorTime)', () => {
    // Dance at exactly 2:00 = anchor. Window is [100, 120). 120 < 120 is false -> not in window.
    const casts = Events.cast(SHADOW_BLADES, '0:05').cast(SHADOW_DANCE, '2:00').cast(SHADOW_BLADES, '2:00').build();
    expect(evaluateRules([rule], casts, FIGHT_START)).toHaveLength(0);
  });
});

describe('evaluateRules / hold_cooldown_for_anchor / multiple anchors', () => {
  const rule = holdForAnchorRule(
    { spell_ids: [SHADOW_DANCE], spell_names: ['Shadow Dance'], anchor_spell_id: SHADOW_BLADES, anchor_spell_name: 'Shadow Blades', hold_window_s: 20 },
    { priority: 'high', action: 'Pool for Shadow Blades.' },
  );

  it('aggregates violations from multiple anchor windows into one finding with the charge count', () => {
    // SB at 0:05, 2:00, 4:00. Dance at 1:50 (in window before 2:00) AND 3:50 (in window before 4:00).
    const casts = Events.cast(SHADOW_BLADES, '0:05')
      .cast(SHADOW_DANCE, '1:50')
      .cast(SHADOW_BLADES, '2:00')
      .cast(SHADOW_DANCE, '3:50')
      .cast(SHADOW_BLADES, '4:00')
      .build();
    const findings = evaluateRules([rule], casts, FIGHT_START);
    expect(findings).toHaveLength(1);
    expect(findings[0].measured?.value).toBe('2');
  });
});

describe('evaluateRules', () => {
  it('silently skips rules with no condition', () => {
    expect(evaluateRules([{ priority: 'critical', description: 'prose only', condition: null }], [], FIGHT_START)).toEqual([]);
  });
});
