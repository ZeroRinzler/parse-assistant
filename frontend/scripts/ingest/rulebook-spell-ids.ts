/**
 * Pure rulebook spell-id helpers for the ingest integrity gate.
 *
 * Rulebook spell ids are LLM-generated and explicitly uncertain (the schema carries an
 * `id_note` field for best guesses). A wrong id silently breaks the runtime: `WclApiService.
 * getAbilities` resolves each id via `gameData.ability(id)`, which returns `null` for a
 * nonexistent id, and `abilityIcons` skips nulls - so a bad id lands in `cd_spell_ids` but
 * NOT in `ability_icons`, and the card's `ability_icons[spellId].icon` lookup then throws.
 *
 * The fix is to fail loudly at the ingest gate rather than guard at runtime (per the
 * "complete ingested data, no fallbacks" principle): before running the transforms the
 * orchestrator resolves every rulebook spell id against WCL and refuses a spec whose
 * rulebook references an id WCL cannot resolve. These pure functions are the testable core;
 * the orchestrator wires them to the live `getAbilities`. No network, no IO.
 */
import type { Rulebook } from '../../src/app/core/models/rulebook.models.ts';
import type { WclRawAbility } from '../../src/app/core/models/wcl.models.ts';

/**
 * Every distinct, positive spell id a rulebook references: major cooldowns, defensives,
 * and both rule-condition kinds (`cast_without_prior` primary/required/exception-context,
 * `hold_cooldown_for_anchor` held-spells/anchor). These are exactly the ids the runtime
 * later feeds to `getAbilities` for the card art, so validating them here covers every id
 * that could break a card.
 */
export function rulebookSpellIds(rulebook: Rulebook): number[] {
  const ids = new Set<number>();
  for (const cooldown of rulebook.major_cooldowns ?? []) ids.add(cooldown.spell_id);
  for (const defensive of rulebook.defensives ?? []) ids.add(defensive.spell_id);
  for (const rule of rulebook.rules ?? []) {
    const condition = rule.condition;
    if (!condition) continue;
    if (condition.kind === 'cast_without_prior') {
      ids.add(condition.spell_id);
      ids.add(condition.required_spell_id);
      if (condition.exception) ids.add(condition.exception.context_spell_id);
    } else if (condition.kind === 'hold_cooldown_for_anchor') {
      for (const spellId of condition.spell_ids) ids.add(spellId);
      ids.add(condition.anchor_spell_id);
    }
  }
  return [...ids].filter(id => id > 0);
}

/**
 * The subset of `ids` that WCL could not resolve. `resolved` is the raw aliased `gameData`
 * map `getAbilities` returns (`a<id>` -> ability | null); an id is unresolved when its alias
 * is absent or null. Sorted ascending so the error message is stable.
 */
export function unresolvedSpellIds(
  ids: number[], resolved: Record<string, WclRawAbility | null>,
): number[] {
  return ids.filter(id => !resolved[`a${id}`]).sort((a, b) => a - b);
}
