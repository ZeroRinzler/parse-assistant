/**
 * Fluent-ish builders for rulebook fixtures.
 *
 * A test usually cares about exactly one cooldown or one rule. These factories
 * fill in the boilerplate so a spec only states what matters:
 *
 * ```ts
 * const rb = rulebook({ cooldowns: [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 180 }] });
 * ```
 */
import {
  Rulebook,
  RulebookCooldown,
  RulebookDefensive,
  RulebookRule,
  CastWithoutPriorCondition,
  HoldCooldownForAnchorCondition,
} from '../../app/core/models/rulebook.models';

/** The minimal fields every cooldown fixture must name. */
type CooldownSeed = Pick<RulebookCooldown, 'name' | 'spell_id' | 'cooldown'> & Partial<RulebookCooldown>;
type DefensiveSeed = Pick<RulebookDefensive, 'name' | 'spell_id' | 'cooldown'> & Partial<RulebookDefensive>;

export function rulebook(partial: {
  spec?: string;
  cooldowns?: CooldownSeed[];
  defensives?: DefensiveSeed[];
  rules?: RulebookRule[];
} = {}): Rulebook {
  return {
    spec: partial.spec ?? 'TestSpec',
    major_cooldowns: (partial.cooldowns ?? []).map((c) => ({ align_with_bloodlust: false, ...c })),
    defensives: (partial.defensives ?? []).map((d) => ({ duration: 5, ...d })),
    rules: partial.rules ?? [],
  };
}

/** A `cast_without_prior` rule fixture. */
export function castWithoutPriorRule(
  condition: Omit<CastWithoutPriorCondition, 'kind'>,
  opts?: { priority?: RulebookRule['priority']; action?: string; description?: string },
): RulebookRule {
  return {
    type: 'cooldown_pairing',
    priority: opts?.priority ?? 'critical',
    description: opts?.description ?? `${condition.spell_name} requires ${condition.required_spell_name}`,
    action: opts?.action,
    condition: { kind: 'cast_without_prior', ...condition },
  };
}

/** A `hold_cooldown_for_anchor` rule fixture. */
export function holdForAnchorRule(
  condition: Omit<HoldCooldownForAnchorCondition, 'kind'>,
  opts?: { priority?: RulebookRule['priority']; action?: string; description?: string },
): RulebookRule {
  return {
    type: 'cd_hold',
    priority: opts?.priority ?? 'high',
    description: opts?.description ?? `Hold for ${condition.anchor_spell_name}`,
    action: opts?.action,
    condition: { kind: 'hold_cooldown_for_anchor', ...condition },
  };
}
