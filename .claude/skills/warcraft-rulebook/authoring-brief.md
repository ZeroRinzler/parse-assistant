# Rulebook authoring brief

Hand this file's path to each authoring subagent. It carries the subagent's whole job: the input
contract, the output shape, and the quality bar the output is judged against.

You author exactly one spec's `rulebook.json` from the local files named in your task prompt. You make no
network calls. Every fact you write comes from those files. You never mention, read, or reference any
other specialization: your rulebook contains only your spec's own abilities.

## Inputs

- The schema: `.claude/skills/warcraft-ingestion/rulebook.schema.json`. Read it first. It is the only
  contract, and the field `description` strings are instructions, so follow them exactly.
- `<spec>.simc.txt` (absent for healers and Augmentation Evoker): the SimulationCraft APL. Its conditions
  (`if=`, `buff.X.up`, `cooldown.X.remains`, resource and target-count gates) are the raw material for
  cooldown timing, opener order, and rule conditions.
- `<spec>.guide.txt`: the stripped rotation guide, current patch. Abilities appear inline as
  `Name(spell=12345)`. It carries the openers, the single-target and AoE priorities, cooldown usage, and
  the hero-talent variants.
- `<spec>.abilities.tsv`: the ONLY source of spell ids. Columns: `name`, `spell_id`, `icon`, `base_cd_s`,
  `note`. Every id is verified against Warcraft Logs game data, and the `note` says what each id actually
  is, observed across several current top parses:
  - `CAST` with a count - a real cast id. Use these for `major_cooldowns`, `defensives`, and every
    cast-based rule field (`spell_id`, `required_spell_id`, `anchor_spell_id`, `spend_spell_ids`).
  - `SELF AURA` / `TARGET AURA` with uptime - an aura id. Use these for every `buff_spell_id` and
    `aura_spell_id`. An aura id is frequently not the id of the ability that applies it.
  - `not pressed in the sampled parses but castable per its tooltip` - real and castable, typically a
    defensive nobody needed in those pulls. Safe to use.
  - `NOT observed` - probably a talent node or an unplayed build's aura. Avoid it unless the guide clearly
    describes it as a button, and say so in `id_note`.
  - `SAME NAME as id(s) X,Y` - several live ids share this name. Pick by kind: the row seen in casts is
    the current cast id, the row with uptime is the aura.
  The note's parse count is evidence, not proof: an id seen in none of the sampled parses may still be a
  real button whose build was not represented.

## Output

Write pretty-printed JSON to the output path in your prompt, creating the directory if needed. Overwrite
any existing file without reading it: this is a clean-slate regeneration. Set `spec` to your folder key
and `spec_icon` to the stem given in your prompt. Never write `guide_count` or `saved_at`.

Report one line: spec key, the major_cooldowns / defensives / rules counts, and any ability name the
sources called for that your table did not contain. No prose narration.

## The quality bar

The rulebook's entire value is the optimization detail the sources carry; a schema-valid file that
flattens it is a failed run.

- **`usage_rule` and rule `action` carry the sources' concrete conditions**: combo-point / resource
  thresholds, target counts, charge handling, hold windows, hero-talent-specific variants (e.g. different
  entry conditions per hero tree), macro and timing notes, why-it-works mechanics named in the sources.
  "Use on cooldown" with no condition fails the bar whenever the source states one.
- **`major_cooldowns` is every ability over 30s that meaningfully affects output**, including an on-use
  trinket when a source gives it timing. **`defensives` >= 15s is inclusive** - an ability with exactly a
  15s cooldown belongs in the list. No passives, no stance toggles.
- **Numbers come from the sources, not from vibes**: thresholds and target counts quoted in
  `usage_rule` and rule `action` must trace to an APL line or a guide sentence, and comparators are
  copied exactly (an APL `combo_points<=2` means 2, not 1). `cooldown` values come from a source sentence
  or the table's `base_cd_s`; when the sources state an effective (talented) cooldown that differs from
  the base value, the source wins and the base goes in `id_note`.
- **Every rule needs a `condition`**, and the engine renders nothing else, so advice it cannot check is
  not a rule: leave it out rather than writing a rule around it. Quality over count - two real rules
  beat eight, and an empty `rules` list is valid. Eight kinds are available (see the schema's `$defs`):

  | The rule says | Kind |
  |---|---|
  | cast A near cast B | `cast_without_prior` |
  | do not spend A shortly before B | `hold_cooldown_for_anchor` |
  | only / never cast A while buff B is up | `cast_outside_buff` |
  | keep buff or dot B up | `aura_uptime_below` |
  | open with A then B then C | `opening_sequence` |
  | use A at N+ targets, stop using A above N | `cast_at_target_count` |
  | spend A only at N resource, do not overcap | `resource_at_cast` |
  | consume proc B on sight | `proc_wasted` |

- **Never author a magnitude.** A condition names identity and direction only - which spell, which
  aura, which resource, and which way the rule runs (`position`, `require`, `on`, `bound`). Every
  number it is judged against (pairing window, hold gap, uptime bar, opener time, target count,
  resource level) is measured from the encounter's own top parses, so the same rule adapts to a fight
  the field plays differently instead of failing the player against a guess. Put the source's concrete
  numbers in the rule's `action` as coaching copy, where they inform without being enforced.
- **Pick the kind the rule actually means.** A rule about a buff being up wants `cast_outside_buff`,
  not a `cast_without_prior` proximity window that only approximates it. A rule about combo points
  wants `resource_at_cast`, not a cast pairing. `aura_uptime_below` needs `on: "target"` for a dot the
  player maintains on the boss and `on: "self"` for a personal buff.
- **Never write a "keep X on cooldown" rule.** The rotation card already flags lost casts for every
  `major_cooldowns` entry, benched against the top parses, so such a rule would duplicate a row the
  player already sees and can contradict it. Put the timing detail in the cooldown's `usage_rule`.
- **`on: "target"` costs a raid-wide fetch** (WCL cannot narrow enemy auras to one caster), so it is
  worth it for a spec whose dots are the rotation and wasteful for an incidental debuff.
- **A rule a top parse would fail is a broken rule, not a strict one.** Every finding is benched against
  the encounter's best logs, so a rule the field already violates accuses everyone and teaches nobody.
  Sanity-check each rule against the parse evidence in the table before keeping it, and drop the ones
  that do not survive. `proc_wasted` is where this bites: compare the proc's application count against
  the cast counts of its spend abilities, and if applications dwarf spends the pairing is wrong - the
  buff is a lasting state (an execute-phase "usable" window, a stacking tracker) rather than a proc that
  ability consumes. `aura_uptime_below` deserves the same look: if the top parses let the aura drop for
  long stretches, it is situational and not a maintenance rule.
- **Never take a spell id from a schema `examples` block.** Those are illustrative and go stale as spells
  churn, so an id copied out of one can be a real id for a different ability. Every id comes from the
  prepared table, even when an example seems to hand you the exact rule you are writing.
- **`cast_without_prior` operands are ordered, and getting them backwards inverts the check.**
  `spell_id` is the ability being judged; `required_spell_id` is its companion, which under the default
  `position: "before"` must already have been cast. For "Secret Technique always inside Shadow Dance",
  Secret Technique is `spell_id` and Shadow Dance is `required_spell_id`. Set `position: "either"` only
  when the rule text genuinely says pair or sync rather than naming an order, and `"after"` when the
  companion must follow. Read the rule's own `action` back against the condition before writing it.

## Writing rules (project-wide, non-negotiable)

- Never use em-dashes (U+2014), en-dashes (U+2013), or the Unicode minus (U+2212) anywhere in the file.
  Use a plain ASCII hyphen.
- `usage_rule` and `action` are user-facing coaching copy in a terse expert-analyst voice. Never put
  spell-id uncertainty in them; that belongs in `id_note`.
