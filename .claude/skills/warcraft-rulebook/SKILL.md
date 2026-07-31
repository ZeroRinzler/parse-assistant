---
name: warcraft-rulebook
description: Generate or refresh warcraft-learner spec rulebooks on demand (no stored guide corpus, no CLI). The main agent preps stripped SimulationCraft APLs, rotation guide text, and a WCL-verified ability-id table per spec, then fans out one isolated authoring subagent per spec that works only from those local files. Load this whenever creating or refreshing rulebook.json for one, several, or all specs - at a new patch or tier, or when onboarding a new spec. Knows the SimC and guide source URLs and their per-tier discovery, the WCL grounding queries, the spec icon lookup, the schema contract, the authoring brief, the output path, and the gh-pages publish recipe.
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
the three files of 2a, 2b and 2d into the scratchpad; 2c is one lookup covering every spec at once. Never
author spell ids from memory - the ability table is where every id comes from.

### 2a. `<spec>.simc.txt` - the SimulationCraft APL (DPS and tanks; SimC ships no healer or Augmentation Evoker profile)

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
  and take the highest that resolves. The path moves every tier; discover it, do not hard-trust it.
- `<ClassName>_<SpecName>` are **underscore-separated words**, so a two-word class or spec keeps its
  space as an underscore: `Rogue_Subtlety`, `Hunter_Beast_Mastery`, `Death_Knight_Frost`,
  `Demon_Hunter_Havoc`. Probing a wrong form 404s cleanly, so probe the underscore form first.

`api.github.com` is blocked behind some egress proxies, so the contents API is not a reliable way to list
the tier dir; probe `raw.githubusercontent.com` paths directly instead. When a base spec file 404s under
every form, that spec has no profile this tier and the subagent works from the guide and the table alone.

The APL is already plain text; save it as-is. Its conditions (e.g.
`racial_sync,value=buff.shadow_blades.up&buff.shadow_dance.up`, `if=cooldown.X.remains`, combo-point and
charge gates) are the raw material for `major_cooldowns`, `align_with_bloodlust`, `opener_priority`, and
the rule conditions - the subagent needs them verbatim.

**The bottom of each action list is the filler, and it is the spec's most-pressed decision.** SimC splits
the rotation into sub-lists per hero tree and target count (`actions.ec_st`, `actions.kotg_st`,
`actions.aoe`), and each one ends in a **terminal unconditioned action** - the button pressed whenever
nothing above it is available. The lines just above it are the gates that swap in a different filler
(`starfire,if=action.starfire.execute_time<buff.eclipse.remains` then a bare `wrath`). Together they are
the `filler_in_buff` rules, and the states in those gates - the buff that decides the choice, and the
burst window or proc that suspends it - are ability ids the table must carry, so add every buff named in
a filler gate to the 2d candidate list. Never trim these lines when saving the file: a rulebook that
describes a spec's cooldowns but not which button fills between them has missed the rotation.

### 2b. `<spec>.guide.txt` - the rotation guide, stripped to text

What the file must contain is a current-patch rotation page reduced to a few KB of text with **every
ability's spell id inlined next to its name** (`Name(spell=12345)`). Two sources carry that; use Wowhead
when it is reachable and Icy Veins when it is not.

Wowhead:

```
https://www.wowhead.com/guide/classes/<class-kebab>/<spec-kebab>/<subpage>-pve-<role>
```

- `<class-kebab>`: `rogue`, `paladin`, `demon-hunter`, `death-knight` (hyphenated for two-word classes).
- `<spec-kebab>`: `subtlety`, `holy`, `devourer`, `beast-mastery`.
- `<subpage>`: `rotation-cooldowns` (the key page); add `overview` / `talent-builds` only if the rotation
  page leaves gaps.
- `<role>`: `dps` / `healer` / `tank`. If a role suffix 404s, try the others.

The pages are server-rendered but hundreds of KB, so keep the `guide-body` block, drop tags, and save the
text. The priority lists, openers and AoE sequences ship a second time inside a `WH.markup.printHtml("...")`
JS string literal where each ability is a `[spell=<id>]` code: extract the longest such literal per page,
resolve the codes to `Name(spell=<id>)` with one batched `gameData` query, and append that block. Plain
`href="...wowhead.com/spell=<id>"` anchors are nearly absent from these pages, so do not rely on them.

**Wowhead's guide pages return 403 to some egress** (CloudFront blocks datacenter ranges). This is not a
signal about the whole domain: `nether.wowhead.com`, which serves the tooltips in 2d, is a different host
and stays reachable, so a working tooltip fetch says nothing about the guide pages. When the guide pages
are blocked, take Icy Veins, whose rotation pages track the same patch and attach ids as
`data-wowhead="spell=<id>"` on every ability:

```
https://www.icy-veins.com/wow/<spec-kebab>-<class-kebab>-pve-<dps|healing|tank>-rotation-cooldowns-abilities
```

Strip from its `guide-page-content` block, rewriting each `<span data-wowhead="spell=<id>">Name</span>` to
`Name(spell=<id>)` first so the ids survive tag removal. Healers use `healing`, not `healer`.

### 2c. spec icon stems - one lookup for every spec

`spec_icon` is a required field and its value is a zamimg icon file stem (e.g. `ability_stealth`). Read
all of them at once from the game's own data:

```
https://wago.tools/db2/ChrSpecialization/csv      # Name_lang, ClassID, SpellIconFileID
https://wago.tools/db2/ManifestInterfaceData/csv  # ID -> FileName (about 9 MB)
```

Join `SpellIconFileID` to `ID` and lowercase the filename without its extension. Match a spec by name
**plus `ClassID`** - spec names repeat across classes - using 1 Warrior, 2 Paladin, 3 Hunter, 4 Rogue,
5 Priest, 6 DeathKnight, 7 Shaman, 8 Mage, 9 Warlock, 10 Monk, 11 Druid, 12 DemonHunter, 13 Evoker. This
resolves specs too new for the guides to describe. Confirm each stem with a HEAD against
`https://wow.zamimg.com/images/wow/icons/large/<stem>.jpg`.

### 2d. `<spec>.abilities.tsv` - the WCL-verified ability-id table

Build one `name <tab> spell_id <tab> icon <tab> base_cd_s <tab> note` table per spec; the subagent picks
**every** id it writes from this table, so grounding happens here, once, at prep time - ingestion does not
re-check ids.

The `note` column is what makes the table usable rather than merely correct. A spec routinely has several
live ids sharing one name, and the subagent cannot tell them apart from the name: the cast id and the aura
id differ (Improved Garrote casts nothing and its logged buff is not its talent id), a reworked ability
keeps its old id alive alongside the new one (both Crimson Tempest ids return "Crimson Tempest"), and a
talent id is not what shows up in a log. Say in the note which one each row is - cast, aura, talent,
retired - and **in how many of the sampled top parses it appeared**. Tell the subagent which kind each
field wants: cast ids for `major_cooldowns`, `defensives` and cast-based rules, aura ids for every
`cast_outside_buff`, `aura_uptime_below`, `proc_wasted` and `filler_in_buff`.

**A guide's inline id for a state buff is frequently not the id the logs carry**, and the name gate cannot
tell: Balance Druid's guide writes `Eclipse (Solar)(spell=326053)`, `ability(id:326053)` answers
"Eclipse (Solar)", and every log in the tier records the buff as **48517**. A rule built on the advertised
id matches nothing and silently reads as followed on every pull. So an aura id only earns its row by
appearing in a parse's `Buffs` or `Debuffs` table; when a guide names one the tables do not, keep the
observed id and record the guide's in the note.

Steps 1 and 3 both need one **rankable encounter id**, so resolve it once per session. Query
`worldData{expansions{id name zones{id name encounters{id name}}}}` and read the current expansion's
zones; never dump `worldData{zones{...}}`, which returns every zone ever and costs far more output than it
answers. The newest raid zone usually returns `"Fight data doesn't exist yet. Try again later."` from
`characterRankings` because the tier has not opened, and a zone can appear two or three times (live, PTR,
beta) with different ids. So probe a few encounter ids for a non-empty `rankings` array and take the first
that answers, falling back to the previous tier's zone. Record which encounter you used: it is what the
parse counts in the notes are counted against.

1. Collect candidate ids from three places:
   - the spell links extracted from the guide HTML (2b) - exact name-to-id pairs;
   - the sampled parses' kits filtered to **exact** APL action-name matches: `masterData{abilities{gameID
     name icon}}` from each `report.code` obtained via
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
3. **Observe 3 to 5 top parses to separate casts from auras**, because step 2 cannot: the name gate passes
   a retired id, a talent id and an aura id equally, since all three return the right name. For each of the
   top rankings take its `report.code` + `fightID`, resolve the player's `sourceID` from
   `playerDetails(fightIDs:[F])`, then pull three tables for that source and union the results across
   parses, recording per id how many parses it appeared in:

   ```
   table(dataType:Casts   fightIDs:[F] sourceID:S)   # data.entries -> the cast ids actually pressed
   table(dataType:Buffs   fightIDs:[F] sourceID:S)   # data.auras   -> self aura ids + uptime
   table(dataType:Debuffs fightIDs:[F] sourceID:S)   # data.auras   -> aura ids, direction not guaranteed
   ```

   An id in `Casts` is a cast id; an id in `Buffs`/`Debuffs` is an aura id; a name-verified id in none of
   them is a talent or an unplayed build, and the note must say so rather than implying it is castable.
   When a name maps to two live ids, the one in `Casts` is the current one.

   **One parse is not enough evidence.** Cast tables are routinely partial - a spec's logs can carry a
   dozen entries and omit core buttons entirely - and any single player's build leaves out abilities the
   spec generally presses, so a lone sample silently deletes real cooldowns from the rulebook. Sampling
   several turns a hard absence into a soft one: an id missing from every parse is evidence, missing from
   one is noise, and the count in the note lets the author weigh it. Sampling is nearly free - a full
   40-spec run at 5 parses each stays well inside the 3600 points/hour budget - so spend it here.

   `Debuffs` filtered by `sourceID` does not reliably narrow to auras that source applied; it can return
   auras sitting on the player instead. Treat those ids as auras, and confirm from the guide that the spec
   actually applies one to enemies before using it for `aura_uptime_below` with `on: "target"`.
4. Fill `base_cd_s` from the Wowhead tooltip endpoint - `https://nether.wowhead.com/tooltip/spell/<id>`
   returns JSON whose `tooltip` HTML carries "`N sec/min cooldown`". Tooltip cooldowns are **base,
   pre-talent** values; they anchor the subagent's `cooldown` numbers, which otherwise have no source at
   all. The same tooltip text carries the **buff/dot duration and the effect percentages**, so parse those
   in the same pass - they are what makes a `usage_rule` concrete. Fetch the whole id set from **one
   script** that requests concurrently and prints one line per id; a shell loop of backgrounded `curl`
   subshells re-prints its own body for every job it reaps and buries the results in noise.

## Step 3 - fan out one isolated authoring subagent per spec

**Always spawn one subagent per selected spec - even when only a single spec is chosen.** The main agent
never authors a rulebook inline. **Each subagent runs in a clean, empty context with exactly one job:
transform its spec's prepped local files into that spec's rulebook.** Give it only: the path to
`authoring-brief.md` next to this file + its folder key + `[className, specName]` + its spec icon stem +
the three scratchpad file paths + the output path - nothing about any other spec, and nothing about the
existing rulebook. No URLs, no credentials, no network access. Subagents share no context and must never
see or reference another spec, so rulebooks cannot mix (a Fury Warrior rulebook contains only Fury Warrior
abilities, never Arms).

Launch them in waves and refill as they report: concurrency is capped per session (20 by default), and an
account or session limit can kill a whole wave in flight. A killed subagent usually leaves a complete,
plausible file behind, so a wave that reports failures still needs Step 4 run over every file.

Each subagent (starting from a clean slate - it does not read or reuse the existing `rulebook.json`):

1. Reads the brief and the schema, then its `.simc.txt` (if present), `.guide.txt`, and `.abilities.tsv`.
2. Extracts the rulebook JSON to the schema: all `major_cooldowns`, all `defensives`, the spec's
   checkable `rules`, `source_summary`, `spec_icon`. Spec-only abilities - never another spec of the
   same class.
3. Takes every `spell_id` from the ability table. An ability the sources name but the table lacks goes
   into the report **by name** - the subagent never guesses an id and never writes an unverified one.
4. Writes the file (Step 4 shape) and returns a one-line report: spec, cooldown/defensive/rule counts,
   and any ability names it could not resolve from the table. Nothing else - no prose narration.

### The authoring brief

The subagent's instructions live in **`authoring-brief.md`** next to this file: the input contract, the
output shape, and the quality bar the output is judged against. Hand the subagent that path rather than
restating any of it, so what the agents receive cannot drift from what this skill enforces. Reject and
respawn a subagent whose output misses the bar.

## Step 4 - validate and write (main agent)

The subagent writes (overwriting any existing file) to `frontend/public/data/specs/{spec}/rulebook.json`,
pretty-printed, `spec` set to the folder key, the **required** `spec_icon` set to the captured stem (never
empty), and no `guide_count`/`saved_at`.

The main agent then validates locally, once, over **every file on disk for the selected specs** rather
than the ones the reports claim: a subagent killed by an API or session limit routinely leaves a complete,
plausible file behind, and its failure notice says nothing about it. Run the checks as **one script over
all the files**, not a command per file per check:

- schema check: `python3 -c "import json,jsonschema; jsonschema.validate(json.load(open('<file>')), json.load(open('.claude/skills/warcraft-ingestion/rulebook.schema.json')))"`
  (`pip install jsonschema` first if the import fails).
- dash scan: no U+2014 / U+2013 / U+2212 anywhere in the file.
- **id cross-check**: walk every `spell_id` in `major_cooldowns`, `defensives` and each condition's id
  fields (including the `spell_ids` / `spend_spell_ids` / `alternative_spell_ids` / `except_buff_spell_ids`
  arrays) and assert the id is in that spec's table
  **and** that the name written beside it matches the table's name for that id. This catches a
  transposed pair that the schema cannot see, since both fields are individually well-typed. Compare with
  any trailing parenthetical stripped: WCL suffixes multi-part spells (`Stasis (Store)`) where the
  in-game name, which is what the player is shown, has no suffix.
- **no magnitudes in conditions**: assert no numeric value in any condition outside the id fields,
  `resource_type` and `health_pct`, and no `rules[].description` over 60 characters. Those two are
  game constants read from a tooltip, not field behaviour the encounter has to measure.
- unresolved-name follow-up: for any ability name a subagent reported as missing from its table, find the
  id (Wowhead spell search), verify it with a WCL `ability(id:...)` query, and patch it in.

Then read the file. The mechanical checks pass on a rulebook whose coaching copy is wrong, so spot-check
that each number in a `usage_rule` or `action` traces to an APL line or a guide sentence, and run the
top-parse sanity check from the brief over the rules.

**Replay every `filler_in_buff` rule against the sampled parses before keeping it**, since it is the one
kind whose defects are invisible on the page: for each parse count the coached filler and its
alternatives cast inside the state and outside every `except_buff_spell_ids` window, take the share, then
bench it the way the engine does (median, band `max(stddev, 0.1 * median)`) and check no parse falls under
`median - band`. A parse that fails is telling you a state is missing from the exclusions - read that
parse's violating casts, find the buff they all sit under, and add it. A rule measurable on under half the
parses is not a defect: the encounter declines to bench it and the runtime drops it, which is the right
outcome for a hero-talent build this field does not play.

When a rule fails these, send the defect back to
that spec's subagent with `SendMessage` - it still holds its context and can fix one rule without
re-authoring the file, which is far cheaper than a cold respawn. Reserve a fresh subagent for output that
misses the bar broadly.

Ingestion consumes the rulebook directly with no code-side check, so this validation pass is the last gate.

## Step 5 - publish

`frontend/public/data/specs/**` is **gitignored on every code branch** - rulebooks are never committed to
a `main`-based branch. Their source of truth is the **`gh-pages`** branch, at
`data/specs/{spec}/rulebook.json` (the shared dataset the site serves). Publish with a worktree based on
`gh-pages`:

```bash
git fetch origin gh-pages
git worktree add -b <temp-branch> <scratch>/ghpages-wt origin/gh-pages
cp frontend/public/data/specs/<Spec>/rulebook.json <scratch>/ghpages-wt/data/specs/<Spec>/rulebook.json   # per spec
git -C <scratch>/ghpages-wt add data/specs
git -C <scratch>/ghpages-wt commit -m "..."
git -C <scratch>/ghpages-wt push -u origin <temp-branch>:refs/heads/<publish-branch>
# open a PR with base gh-pages, then:
git worktree remove <scratch>/ghpages-wt
git branch -D <temp-branch>
```

Open the PR with **base `gh-pages`** (push to `gh-pages` directly only when the user explicitly says so).
Once merged, the hourly ingest overlays `data/specs` from `gh-pages` before each run and rebuilds that
spec's benches over its next passes; the site reads the same tree directly. The gh-pages writers publish
tree-based single commits, so the file content persists across their force-pushes.

The worktree commits on a **temp branch pushed to the publish branch's remote ref** because the publish
branch name is often already checked out on `main` history - a session handed a branch to work on cannot
reuse that name for a `gh-pages` worktree, and `git worktree add -b` fails outright on the collision.
Pushing a temp branch to `refs/heads/<publish-branch>` sidesteps it; the local pointer is then irrelevant,
since the PR reads the remote. Verify with `git log origin/<publish-branch> -1` rather than the local ref,
which still sits on `main` history and will make history-checking tooling report the repo's merge commits
as if they were yours.

**Keeping the PR current needs a cherry-pick, never a plain rebase.** Each `gh-pages` writer force-pushes a
single **parentless** commit, so a rebase onto the new tip replays the orphaned publish commit and reverts
whatever that writer just shipped. Cut a fresh worktree from the new `origin/gh-pages`, cherry-pick your
own commit onto it, and push it with `--force-with-lease=refs/heads/<publish-branch>:<old-sha>`. Then
confirm 0 behind / 1 ahead of `origin/gh-pages`, a diff of only rulebook files, and the other writers'
directories intact.
