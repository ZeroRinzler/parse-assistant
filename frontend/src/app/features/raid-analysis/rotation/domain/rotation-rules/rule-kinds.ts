import { InjectionToken, Type, inject } from '@angular/core';
import { RuleCondition } from '../../../../../domain/rulebook/rulebook.models';
import { RuleKind } from './rule-kind';
import { CastWithoutPriorKind } from './kinds/cast-without-prior-kind';
import { HoldCooldownForAnchorKind } from './kinds/hold-cooldown-for-anchor-kind';
import { CastOutsideBuffKind } from './kinds/cast-outside-buff-kind';
import { AuraUptimeBelowKind } from './kinds/aura-uptime-below-kind';
import { OpeningSequenceKind } from './kinds/opening-sequence-kind';
import { CastAtTargetCountKind } from './kinds/cast-at-target-count-kind';
import { ResourceAtCastKind } from './kinds/resource-at-cast-kind';
import { ProcWastedKind } from './kinds/proc-wasted-kind';
import { FillerInBuffKind } from './kinds/filler-in-buff-kind';
import { SpendAtStacksKind } from './kinds/spend-at-stacks-kind';
import { AuraClippedKind } from './kinds/aura-clipped-kind';
import { FillerBelowHealthKind } from './kinds/filler-below-health-kind';

/** Keyed by kind, so a new condition cannot compile until it declares a kind class here. */
const KIND_CLASSES: { [K in RuleCondition['kind']]: Type<RuleKind<Extract<RuleCondition, { kind: K }>>> } = {
  cast_without_prior: CastWithoutPriorKind,
  hold_cooldown_for_anchor: HoldCooldownForAnchorKind,
  cast_outside_buff: CastOutsideBuffKind,
  aura_uptime_below: AuraUptimeBelowKind,
  opening_sequence: OpeningSequenceKind,
  cast_at_target_count: CastAtTargetCountKind,
  resource_at_cast: ResourceAtCastKind,
  proc_wasted: ProcWastedKind,
  filler_in_buff: FillerInBuffKind,
  spend_at_stacks: SpendAtStacksKind,
  aura_clipped: AuraClippedKind,
  filler_below_health: FillerBelowHealthKind,
};

export const RULE_KINDS = new InjectionToken<readonly RuleKind<RuleCondition>[]>('RULE_KINDS', {
  factory: () => Object.values(KIND_CLASSES).map(kindClass => inject(kindClass)),
});
