import { RuleCondition } from '../../../../core/models/rulebook.models';
import { KindSpec } from './engine-core';
import { CAST_WITHOUT_PRIOR_KIND } from './kinds/cast-without-prior';
import { HOLD_COOLDOWN_FOR_ANCHOR_KIND } from './kinds/hold-cooldown-for-anchor';
import { CAST_OUTSIDE_BUFF_KIND } from './kinds/cast-outside-buff';
import { AURA_UPTIME_BELOW_KIND } from './kinds/aura-uptime-below';
import { OPENING_SEQUENCE_KIND } from './kinds/opening-sequence';
import { CAST_AT_TARGET_COUNT_KIND } from './kinds/cast-at-target-count';
import { RESOURCE_AT_CAST_KIND } from './kinds/resource-at-cast';
import { PROC_WASTED_KIND } from './kinds/proc-wasted';
import { FILLER_IN_BUFF_KIND } from './kinds/filler-in-buff';
import { SPEND_AT_STACKS_KIND } from './kinds/spend-at-stacks';
import { AURA_CLIPPED_KIND } from './kinds/aura-clipped';
import { FILLER_BELOW_HEALTH_KIND } from './kinds/filler-below-health';

/** Keyed by kind, so a new condition cannot compile until it declares every field. */
const RULE_KINDS: { [K in RuleCondition['kind']]: KindSpec<Extract<RuleCondition, { kind: K }>> } = {
  cast_without_prior: CAST_WITHOUT_PRIOR_KIND,
  hold_cooldown_for_anchor: HOLD_COOLDOWN_FOR_ANCHOR_KIND,
  cast_outside_buff: CAST_OUTSIDE_BUFF_KIND,
  aura_uptime_below: AURA_UPTIME_BELOW_KIND,
  opening_sequence: OPENING_SEQUENCE_KIND,
  cast_at_target_count: CAST_AT_TARGET_COUNT_KIND,
  resource_at_cast: RESOURCE_AT_CAST_KIND,
  proc_wasted: PROC_WASTED_KIND,
  filler_in_buff: FILLER_IN_BUFF_KIND,
  spend_at_stacks: SPEND_AT_STACKS_KIND,
  aura_clipped: AURA_CLIPPED_KIND,
  filler_below_health: FILLER_BELOW_HEALTH_KIND,
};

/** The engine's one cast: the table is keyed by `kind`, so an entry always matches the condition that looked it up. */
export function specFor<C extends RuleCondition>(cond: C): KindSpec<C> {
  return RULE_KINDS[cond.kind] as unknown as KindSpec<C>;
}
