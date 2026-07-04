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
  window_s?: number;
  exception?: {
    context_spell_id: number;
    context_window_s?: number;
    position?: 'before' | 'after';
  };
}

export interface HoldCooldownForAnchorCondition {
  kind: 'hold_cooldown_for_anchor';
  spell_ids: number[];
  spell_names: string[];
  anchor_spell_id: number;
  anchor_spell_name: string;
  hold_window_s?: number;
}

export type RuleCondition = CastWithoutPriorCondition | HoldCooldownForAnchorCondition;

export interface RulebookRule {
  type?: string;
  priority?: 'critical' | 'high' | 'medium' | 'low' | string;
  description?: string;
  condition?: RuleCondition | null;
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
