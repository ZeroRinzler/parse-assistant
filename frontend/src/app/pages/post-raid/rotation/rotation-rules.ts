// Separate from rotation.service.ts so the ingest transform measures top parses with the same code the runtime judges the player with.
export type { RuleBand, BenchedRule, RuleSample } from './rotation-rules/engine-core';

export { buildRuleContext } from './rotation-rules/rule-context';
export {
  MIN_MEASURED_PARSES, RULE_TYPE_LABEL,
  rulesNeed, judgeableRules, sampleRule, ruleBand, benchedRules, evaluateRules, rulesFollowed,
} from './rotation-rules/engine';
