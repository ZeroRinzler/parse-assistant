export interface RulebookCooldown {
  name: string;
  spell_id: number;
  cooldown: number;
  opener_priority?: number;
  usage_rule?: string;
  talent_gated?: boolean;
}

export interface RulebookDefensive {
  name: string;
  spell_id: number;
  cooldown: number;
  duration?: number;
  usage_rule?: string;
  talent_gated?: boolean;
}

export interface CastWithoutPriorCondition {
  kind: 'cast_without_prior';
  spell_id: number;
  spell_name: string;
  required_spell_id: number;
  required_spell_name: string;
  /** Where the required cast must sit relative to the judged one; defaults to `before`. */
  position?: 'before' | 'after' | 'either';
}

export interface HoldCooldownForAnchorCondition {
  kind: 'hold_cooldown_for_anchor';
  spell_ids: number[];
  spell_names: string[];
  anchor_spell_id: number;
  anchor_spell_name: string;
}

export interface CastOutsideBuffCondition {
  kind: 'cast_outside_buff';
  spell_id: number;
  spell_name: string;
  buff_spell_id: number;
  buff_spell_name: string;
  /** `inside` flags casts made while the buff is down; `outside` flags casts made while it is up. */
  require: 'inside' | 'outside';
}

export interface AuraUptimeBelowCondition {
  kind: 'aura_uptime_below';
  aura_spell_id: number;
  aura_spell_name: string;
  /** `target` reads the enemy debuff stream, which is where damage-over-time rules live. */
  on: 'self' | 'target';
}

export interface OpeningSequenceCondition {
  kind: 'opening_sequence';
  spell_ids: number[];
  spell_names: string[];
}

export interface CastAtTargetCountCondition {
  kind: 'cast_at_target_count';
  spell_id: number;
  spell_name: string;
  /** `min` flags casts made at too few enemies, `max` casts made at too many. */
  bound: 'min' | 'max';
}

export interface ResourceAtCastCondition {
  kind: 'resource_at_cast';
  spell_id: number;
  spell_name: string;
  resource_type: number;
  resource_name: string;
  /** `min` flags spending below the field's level, `max` flags generating near the cap. */
  bound: 'min' | 'max';
}

export interface ProcWastedCondition {
  kind: 'proc_wasted';
  buff_spell_id: number;
  buff_spell_name: string;
  spend_spell_ids: number[];
  spend_spell_names: string[];
}

export interface FillerInBuffCondition {
  kind: 'filler_in_buff';
  spell_id: number;
  spell_name: string;
  /** The fillers it competes with, so the check reads a share of the choice rather than a raw count. */
  alternative_spell_ids: number[];
  alternative_spell_names: string[];
  buff_spell_id: number;
  buff_spell_name: string;
  /** States that suspend the choice, so a burst window or proc that makes the other filler correct is not counted against it. */
  except_buff_spell_ids?: number[];
  except_buff_spell_names?: string[];
}

export interface SpendAtStacksCondition {
  kind: 'spend_at_stacks';
  spell_id: number;
  spell_name: string;
  buff_spell_id: number;
  buff_spell_name: string;
  /** `min` flags spending below the field's level, `max` flags generating near the cap. */
  bound: 'min' | 'max';
  /** The buff's own stack cap, a game constant like a cooldown rather than a field behaviour. */
  max_stacks?: number;
  /** States that suspend the rule, so a proc that licenses a cheap cast is not counted against it. */
  except_buff_spell_ids?: number[];
  except_buff_spell_names?: string[];
}

export interface AuraClippedCondition {
  kind: 'aura_clipped';
  aura_spell_id: number;
  aura_spell_name: string;
  /** The cast that applies it, since a proc-applied refresh is not a button the player pressed. */
  cast_spell_id: number;
  cast_spell_name: string;
  /** `target` reads the enemy debuff stream, which is where damage-over-time rules live. */
  on: 'self' | 'target';
  /** States that suspend the rule, so a cooldown the sources say to re-snapshot under is not counted against it. */
  except_buff_spell_ids?: number[];
  except_buff_spell_names?: string[];
}

export interface FillerBelowHealthCondition {
  kind: 'filler_below_health';
  spell_id: number;
  spell_name: string;
  /** The fillers it displaces, so the check reads a share of the choice rather than a raw count. */
  alternative_spell_ids: number[];
  alternative_spell_names: string[];
  /** The ability's own execute threshold, a game constant like a cooldown rather than a field behaviour. */
  health_pct: number;
  /** States that suspend the choice, so a burst window that overrides the priority is not counted against it. */
  except_buff_spell_ids?: number[];
  except_buff_spell_names?: string[];
}

/** Spell ids drive every check; a `*_names` field the engine never renders is there for the rulebook generator's offline id/name cross-check. */
export type RuleCondition =
  | CastWithoutPriorCondition
  | HoldCooldownForAnchorCondition
  | CastOutsideBuffCondition
  | AuraUptimeBelowCondition
  | OpeningSequenceCondition
  | CastAtTargetCountCondition
  | ResourceAtCastCondition
  | ProcWastedCondition
  | FillerInBuffCondition
  | SpendAtStacksCondition
  | AuraClippedCondition
  | FillerBelowHealthCondition;

/** The tiers the findings table renders, authored directly so nothing translates between vocabularies. */
export type RuleSeverity = 'critical' | 'warning' | 'info';

export interface RulebookRule {
  type?: string;
  severity: RuleSeverity;
  description?: string;
  condition?: RuleCondition;
  action?: string;
}

export interface Rulebook {
  spec: string;
  /** Required. zamimg spec-icon file stem, e.g. 'ability_stealth'; read from the guide, used for dropdown art. */
  spec_icon: string;
  major_cooldowns?: RulebookCooldown[];
  defensives?: RulebookDefensive[];
  rules?: RulebookRule[];
}
