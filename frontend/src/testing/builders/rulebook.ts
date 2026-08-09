/** Rulebook fixture factory: fills in the boilerplate so a test only states the one cooldown or rule it cares about. */
import { Rulebook, RulebookCooldown, RulebookDefensive, RulebookRule } from '../../app/core/models/rulebook.models';

type CooldownSeed = Pick<RulebookCooldown, 'name' | 'spell_id' | 'cooldown'> & Partial<RulebookCooldown>;
type DefensiveSeed = Pick<RulebookDefensive, 'name' | 'spell_id' | 'cooldown'> & Partial<RulebookDefensive>;

export function rulebook(partial: {
  spec?: string;
  spec_icon?: string;
  cooldowns?: CooldownSeed[];
  defensives?: DefensiveSeed[];
  rules?: RulebookRule[];
} = {}): Rulebook {
  return {
    spec: partial.spec ?? 'TestSpec',
    spec_icon: partial.spec_icon ?? 'ability_stealth',
    major_cooldowns: (partial.cooldowns ?? []).map((c) => ({ align_with_bloodlust: false, ...c })),
    defensives: (partial.defensives ?? []).map((d) => ({ duration: 5, ...d })),
    rules: partial.rules ?? [],
  };
}
