export interface RulebookCooldown {
  name: string;
  spell_id: number;
  cooldown: number;
  duration?: number;
  align_with_bloodlust?: boolean;
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

export type RuleCondition =
  | CastWithoutPriorCondition
  | HoldCooldownForAnchorCondition
  | CastOutsideBuffCondition
  | AuraUptimeBelowCondition
  | OpeningSequenceCondition
  | CastAtTargetCountCondition
  | ResourceAtCastCondition
  | ProcWastedCondition;

/** The tiers the findings table renders, authored directly so nothing translates between vocabularies. */
export type RuleSeverity = 'critical' | 'warning' | 'info';

export interface RulebookRule {
  type?: string;
  severity: RuleSeverity;
  description?: string;
  condition: RuleCondition;
  action?: string;
}

export interface Rulebook {
  spec: string;
  /** Required. zamimg spec-icon file stem, e.g. 'ability_stealth'; read from the guide, used for dropdown art. */
  spec_icon: string;
  major_cooldowns?: RulebookCooldown[];
  defensives?: RulebookDefensive[];
  rules?: RulebookRule[];
  source_summary?: string;
  guide_count?: number;
  saved_at?: string;
}
