---
name: warcraft-rulebook
description: Generate or refresh warcraft-learner spec rulebooks on demand (no stored guide corpus, no CLI). The main agent preps stripped SimulationCraft APLs, Wowhead guide text, and a WCL-verified ability-id table per spec, then fans out one isolated authoring subagent per spec that works only from those local files. Load this whenever creating or refreshing rulebook.json for one, several, or all specs - at a new patch or tier, or when onboarding a new spec. Knows the SimC + Wowhead source URLs and their per-tier discovery, the WCL grounding queries, the schema contract, the authoring quality bar, the output path, and the gh-pages publish recipe.
---

# warcraft-learner rulebook generation

A rulebook (`rulebook.json`) is the per-spec contract the ingestion transforms consume: the spec's
major offensive cooldowns, personal defensives, its checkable usage rules - each with a
**real WoW spell id** - and the spec's icon stem. One file per spec under
`frontend/public/data/specs/{spec}/rulebook.json`. Every run is a **clean-slate regeneration**: build each
rulebook fresh from the sources below and overwrite the existing file - never read, copy, or patch the old
`rulebook.json`.

Division of labor: the **main agent** does everything mechanical - source fetching, stripping, spell-id
grounding, schema validation, publishing. The **authoring subagents** do exactly one thing: transform a
spec's prepped local source files into its rulebook JSON. Subagents make no network calls and never see
credentials; every byte they read comes from the scratchpad files the main agent prepared. This keeps each
subagent focused, cheap, and retryable.

The schema is the authoritative shape: **`.claude/skills/warcraft-ingestion/rulebook.schema.json`**. Read
it first and make the output conform to it - the schema is the only contract, since ingestion consumes
rulebooks directly (no code-side validation). The field meanings live in the schema's own `description`
strings; follow them exactly (especially: `usage_rule` is user-facing coaching copy and must never carry
spell-id uncertainty; put that in `id_note`).

## When to use

- A new patch/tier reshapes cooldowns, adds tier-set-driven timing, or churns spell ids -> refresh the affected specs.
- Onboarding a new spec (a new class or a new spec) -> generate its first rulebook.
- A spec's analysis looks wrong (a missing cooldown, an ability with no art) -> regenerate that spec.

## Step 1 - pick the specs and get one WCL token

Get a single WCL client-credentials token up front and reuse it for everything in Step 2 - one OAuth
handshake per session, never one per spec or per subagent. Credentials: the embedded public pair
in `frontend/src/environments/wcl-public-client.ts`. POST
`grant_type=client_credentials` to `https://www.warcraftlogs.com/oauth/token`, then POST GraphQL to
`https://www.warcraftlogs.com/api/v2/client` with `Authorization: Bearer <token>`.

Enumerate the spec universe live from WCL:

```
query { gameData { classes { name slug specs { name slug } } } }
```

Each `spec.slug + class.slug` is the folder key (e.g. `Subtlety` + `Rogue` -> `SubtletyRogue`;
`Devourer` + `DemonHunter` -> `DevourerDemonHunter`). Ask the user which specs to do - accept "all", a
class, a role ("healers"), or explicit names - resolve to folder keys, and confirm the list before
starting the prep.

## Step 2 - prep the sources (main agent, per spec)

All fetching, stripping, and grounding is mechanical shell work the main agent runs itself (parallel
`curl` across specs is fine); it needs no subagents and no deep reasoning. For each selected spec, write
three small files into the scratchpad. Never author spell ids from memory - the ability table below is
where every id comes from.

### 2a. `<spec>.simc.txt` - the SimulationCraft APL (DPS and tanks; SimC has no healer profiles)

```
https://raw.githubusercontent.com/simulationcraft/simc/<branch>/profiles/<TIER>/<TIER>_<ClassName>_<SpecName>.simc
```

Discover `<branch>` and `<TIER>` **once per session** and reuse them for every spec:

- `<branch>` is SimC's **current-expansion branch** - `midnight` now (`thewarwithin` was the prior one).
  **Never use `main` or the repo default: they carry no current profiles (`.../simc/main/profiles/...` 404s).**
  If unsure of the name, it is the current WoW expansion lowercased with no spaces; confirm it resolves
  before fetching.
- `<TIER>` is the highest tier profile dir on that branch, e.g. **`MID1`**. Probe
  `https://raw.githubusercontent.com/simulationcraft/simc/<branch>/profiles/<TIER>/...` for `MID1`, `MID2`, ...
  and take the highest that resolves (the GitHub contents API also lists the dir when reachable). The path
  moves every tier; discover it, do not hard-trust it.
- `<ClassName>_<SpecName>` are the no-space forms (e.g. `Rogue_Subtlety`, `Hunter_BeastMastery`,
  `DeathKnight_Frost`). If a fetch 404s, list the tier dir to confirm the exact filename (SimC sometimes
  suffixes hero-talent variants; take the base spec file).

The APL is already plain text; save it as-is. Its conditions (e.g.
`racial_sync,value=buff.shadow_blades.up&buff.shadow_dance.up`, `if=cooldown.X.remains`, combo-point and
charge gates) are the raw material for `major_cooldowns`, `align_with_bloodlust`, `opener_priority`, and
the rule conditions - the subagent needs them verbatim.

### 2b. `<spec>.guide.txt` - the Wowhead guide, stripped to text

```
https://www.wowhead.com/guide/classes/<class-kebab>/<spec-kebab>/<subpage>-pve-<role>
```

- `<class-kebab>`: `rogue`, `paladin`, `demon-hunter`, `death-knight` (hyphenated for two-word classes).
- `<spec-kebab>`: `subtlety`, `holy`, `devourer`, `beast-mastery`.
- `<subpage>`: `rotation-cooldowns` (the key page); add `overview` / `talent-builds` only if the rotation
  page leaves gaps.
- `<role>`: `dps` / `healer` / `tank`. If a role suffix 404s, try the others.

The pages are server-rendered, so a plain fetch returns the full body - but it is hundreds of KB of HTML.
**Strip it before handing it to a subagent**: keep the `guide-body` block, drop tags, and save the
resulting few KB of text. While stripping, also capture from the raw HTML:

- the spec's **icon stem** (e.g. `ability_stealth`) for the rulebook's required `spec_icon`;
- every `wowhead.com/spell=<id>` link with its anchor text - these name-to-id pairs feed the ability table.

### 2c. `<spec>.abilities.tsv` - the WCL-verified ability-id table

Build one `name <tab> spell_id <tab> icon <tab> base_cd_s` table per spec; the subagent picks **every**
id it writes from this table, so grounding happens here, once, at prep time - ingestion does not re-check
ids.

1. Collect candidate ids from three places:
   - the spell links extracted from the guide HTML (2b) - exact name-to-id pairs;
   - a top parse's kit filtered to **exact** APL action-name matches: `masterData{abilities{gameID name
     icon}}` from a top `report.code` obtained via
     `worldData{encounter(id:E){characterRankings(className:C specName:S metric:dps)}}` (metric `hps` for
     healers), kept only when the normalized name (lowercase, underscores to spaces, apostrophes stripped)
     equals an APL action token. Substring matching against guide prose is wrong - common ability names
     ("Charge", "Judgment", "Execute") match ordinary sentences and drag other classes' spells into the
     table. The parse kit matters most for healers, whose SimC profile does not exist;
   - domain-knowledge candidates for the spec's cooldowns and defensives the rotation sources do not
     mention (the rotation guide page typically covers no defensives at all): name plus best-guess id.
     These are safe only because of the name gate in step 2.
2. Verify the union with **one batched** `gameData` query per spec
   (`query{gameData{ a<ID>: ability(id:<ID>){id name icon} ... }}` - `ability` lives under `gameData`);
   a `null` means the id does not exist - drop it. For every memory-sourced candidate, also require the
   returned name to equal the expected name - a real id attached to the wrong ability (a renamed or
   reworked spell) fails the gate and is dropped.
3. Fill `base_cd_s` from the Wowhead tooltip endpoint - `https://nether.wowhead.com/tooltip/spell/<id>`
   returns JSON whose `tooltip` HTML carries "`N sec/min cooldown`" (parallel `curl` across ids; blank
   when the tooltip has none). Tooltip cooldowns are **base, pre-talent** values; they anchor the
   subagent's `cooldown` numbers, which otherwise have no source at all.

## Step 3 - fan out one isolated authoring subagent per spec

**Always spawn one subagent per selected spec - even when only a single spec is chosen.** The main agent
never authors a rulebook inline. **Each subagent runs in a clean, empty context with exactly one job:
transform its spec's prepped local files into that spec's rulebook.** Give it only: its folder key +
`[className, specName]` + the schema path + the three scratchpad file paths + the output path - nothing
about any other spec, and nothing about the existing rulebook. No URLs, no credentials, no network access.
Subagents share no context and must never see or reference another spec, so rulebooks cannot mix (a Fury
Warrior rulebook contains only Fury Warrior abilities, never Arms). Batch the subagents for concurrency.

Each subagent (starting from a clean slate - it does not read or reuse the existing `rulebook.json`):

1. Reads the schema, then its `.simc.txt` (if present), `.guide.txt`, and `.abilities.tsv`.
2. Extracts the rulebook JSON to the schema: all `major_cooldowns`, all `defensives`, the spec's
   checkable `rules`, `source_summary`, `spec_icon`. Spec-only abilities - never another spec of the
   same class.
3. Takes every `spell_id` from the ability table. An ability the sources name but the table lacks goes
   into the report **by name** - the subagent never guesses an id and never writes an unverified one.
4. Writes the file (Step 4 shape) and returns a one-line report: spec, cooldown/defensive/rule counts,
   and any ability names it could not resolve from the table. Nothing else - no prose narration.

### The authoring quality bar

The rulebook's entire value is the optimization detail the sources carry; a schema-valid file that
flattens it is a failed run. Reject and respawn a subagent whose output misses this bar:

- **`usage_rule` and rule `action` carry the sources' concrete conditions**: combo-point / resource
  thresholds, target counts, charge handling, hold windows, hero-talent-specific variants (e.g. different
  entry conditions per hero tree), macro and timing notes, why-it-works mechanics named in the sources.
  "Use on cooldown" with no condition fails the bar whenever the source states one.
- **`defensives` >= 15s is inclusive** - an ability with exactly a 15s cooldown belongs in the list.
- **Numbers come from the sources, not from vibes**: thresholds and target counts quoted in
  `usage_rule` and rule `action` must trace to an APL line or a guide sentence, and comparators are
  copied exactly (an APL `combo_points<=2` means 2, not 1). `cooldown` values come from a source sentence or the table's
  `base_cd_s`; when the sources state an effective (talented) cooldown that differs from the base value,
  the source wins and the base goes in `id_note`.
- **Every rule needs a `condition`**, and the engine renders nothing else, so advice it cannot check is
  not a rule: leave it out rather than writing a rule around it. Quality over count - two real rules
  beat eight, and an empty `rules` list is valid. Nine kinds are available (see the schema's `$defs`):

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
- **`cast_without_prior` operands are ordered, and getting them backwards inverts the check.**
  `spell_id` is the ability being judged; `required_spell_id` is its companion, which under the default
  `position: "before"` must already have been cast. For "Secret Technique always inside Shadow Dance",
  Secret Technique is `spell_id` and Shadow Dance is `required_spell_id`. Set `position: "either"` only
  when the rule text genuinely says pair or sync rather than naming an order, and `"after"` when the
  companion must follow. Read the rule's own `action` back against the condition before writing it.

## Step 4 - validate and write (main agent)

The subagent writes (overwriting any existing file) to `frontend/public/data/specs/{spec}/rulebook.json`,
pretty-printed, `spec` set to the folder key, the **required** `spec_icon` set to the captured stem (never
empty), and no `guide_count`/`saved_at`.

The main agent then validates every written file once, locally:

- schema check: `python3 -c "import json,jsonschema; jsonschema.validate(json.load(open('<file>')), json.load(open('.claude/skills/warcraft-ingestion/rulebook.schema.json')))"`
- dash scan: no U+2014 / U+2013 / U+2212 anywhere in the file.
- unresolved-name follow-up: for any ability name a subagent reported as missing from its table, find the
  id (Wowhead spell search), verify it with a WCL `ability(id:...)` query, and patch it in.

Ingestion consumes the rulebook directly with no code-side check, so this validation pass is the last gate.

## Step 5 - publish

`frontend/public/data/specs/**` is **gitignored on every code branch** - rulebooks are never committed to
a `main`-based branch. Their source of truth is the **`gh-pages`** branch, at
`data/specs/{spec}/rulebook.json` (the shared dataset the site serves). Publish with a worktree based on
`gh-pages`:

```bash
git fetch origin gh-pages
git worktree add -b <publish-branch> <scratch>/ghpages-wt origin/gh-pages
cp frontend/public/data/specs/<Spec>/rulebook.json <scratch>/ghpages-wt/data/specs/<Spec>/rulebook.json   # per spec
git -C <scratch>/ghpages-wt add data/specs
git -C <scratch>/ghpages-wt commit -m "..."
git -C <scratch>/ghpages-wt push -u origin <publish-branch>
# open a PR with base gh-pages, then:
git worktree remove <scratch>/ghpages-wt
```

Open the PR with **base `gh-pages`** (push to `gh-pages` directly only when the user explicitly says so).
Once merged, the hourly ingest overlays `data/specs` from `gh-pages` before each run and rebuilds that
spec's benches over its next passes; the site reads the same tree directly. The gh-pages writers publish
tree-based single commits, so the file content persists across their force-pushes.
