# Rulebook generation reference - recipes and procedures

Operational detail for the warcraft-rulebook skill. Read the section for the step you are executing; each section stands alone.

## When a patch lands

Regenerate once **both** the SimC profile and the rotation guide have caught up to the live patch. Either one alone leaves a gap: an APL without the guide gives conditions with no coaching copy, a guide without the APL gives prose with no thresholds.

Then check the sampled encounter has real parse volume on the current partition. Ids come from parses (2d), so a reworked ability cannot earn a row until people have played it, and a spec prepped on a near-empty partition ships ids for the patch that just ended. If volume is thin, sample the previous tier's zone and note it, or wait.

## WCL token and spec universe (Step 1)

Get one WCL client-credentials token up front and reuse it for the whole session - one OAuth handshake, never one per spec or per dispatch. Credentials: the embedded public pair in `frontend/src/environments/wcl-public-client.ts`. POST `grant_type=client_credentials` to `https://www.warcraftlogs.com/oauth/token`, then POST GraphQL to `https://www.warcraftlogs.com/api/v2/client` with `Authorization: ****** the spec universe live from WCL:

```
query { gameData { classes { name slug specs { name slug } } } }
```

Each `spec.slug + class.slug` is the folder key (e.g. `Subtlety` + `Rogue` -> `SubtletyRogue`; `Devourer` + `DemonHunter` -> `DevourerDemonHunter`). Ask the user which specs to do - accept "all", a class, a role ("healers"), or explicit names - resolve to folder keys, and confirm the list before starting the prep.

Steps 1 and 3 (of the SKILL.md flow) both need one **rankable encounter id**, so resolve it once per session. Query `worldData{expansions{id name zones{id name encounters{id name}}}}` and read the current expansion's zones; never dump `worldData{zones{...}}`, which returns every zone ever. The newest raid zone usually has no fight data yet and a zone can appear two or three times (live, PTR, beta) with different ids, so probe a few encounter ids for a non-empty `rankings` array and take the first that answers, falling back to the previous tier's zone. Record which encounter you used: the parse counts in the notes are counted against it.

## 2a. `<spec>.simc.txt` - the SimulationCraft APL

(DPS and tanks; SimC ships no healer or Augmentation Evoker profile.)

```
https://raw.githubusercontent.com/simulationcraft/simc/<branch>/profiles/<TIER>/<TIER>_<ClassName>_<SpecName>.simc
```

Discover `<branch>` and `<TIER>` **once per session** and reuse them for every spec:

- `<branch>` is SimC's **current-expansion branch** - `midnight` now. **Never use `main` or the repo default: they carry no current profiles (`.../simc/main/profiles/...` 404s).** If unsure, it is the current WoW expansion lowercased with no spaces; confirm it resolves before fetching.
- `<TIER>` is the profile dir for the tier **live right now**, e.g. **`MID1`**. Probe `MID1`, `MID2`, ... and take the highest one matching the live patch, checked against the patch the guide pages state. SimC opens the next tier during its PTR cycle, so a dir that resolves can describe a patch no sampled parse was played on. The path moves every tier; discover it, do not hard-trust it.
- `<ClassName>_<SpecName>` are **underscore-separated words** (`Rogue_Subtlety`, `Hunter_Beast_Mastery`, `Death_Knight_Frost`). A wrong form 404s cleanly, so probe the underscore form first.

`api.github.com` is blocked behind some egress proxies; probe `raw.githubusercontent.com` paths directly. When a base spec file 404s under every form, that spec has no profile this tier and the agent works from the guide and the table alone.

**Strip the file to action lists only.** Drop the header block (talents, gear, consumables, trinkets,
legendaries), comments, and empty lines. Keep every line that starts with `actions` or `actions.`,
including the sub-list definitions, and keep its conditions (`if=`, `buff.X.up`,
`cooldown.X.remains`, resource gates) verbatim - they are the raw material for `major_cooldowns`,
`opener_priority`, and the rule conditions.

**Never trim the filler lines** - the terminal unconditioned action at the bottom of each sub-list
and the gates just above it. They are the `filler_in_buff` raw material, and every buff named in a
filler gate goes on the ability-table candidate list. What the agent does with them is defined in
`.claude/agents/rulebook-author.md`.

## 2b. `<spec>.guide.txt` - the rotation guide, stripped to text

What the file must contain is a current-patch rotation page reduced to a few KB of text with **every ability's spell id inlined next to its name** (`Name(spell=12345)`). Two sources carry that; use Wowhead when it is reachable and Icy Veins when it is not.

Wowhead:

```
https://www.wowhead.com/guide/classes/<class-kebab>/<spec-kebab>/<subpage>-pve-<role>
```

- `<class-kebab>`: `rogue`, `paladin`, `demon-hunter`, `death-knight` (hyphenated for two-word classes).
- `<spec-kebab>`: `subtlety`, `holy`, `devourer`, `beast-mastery`.
- `<subpage>`: `rotation-cooldowns` (the key page); add `overview` / `talent-builds` only if the rotation page leaves gaps.
- `<role>`: `dps` / `healer` / `tank`. If a role suffix 404s, try the others.

The pages are server-rendered but hundreds of KB, so keep the `guide-body` block, drop tags, and save the text. The priority lists, openers and AoE sequences ship a second time inside a `WH.markup.printHtml("...")` JS string literal where each ability is a `[spell=<id>]` code: extract the longest such literal per page, resolve the codes to `Name(spell=<id>)` with one batched `gameData` query, and append that block. Plain `href="...wowhead.com/spell=<id>"` anchors are nearly absent from these pages, so do not rely on them.

**Wowhead's guide pages return 403 to some egress** (CloudFront blocks datacenter ranges), while `nether.wowhead.com` tooltips - a different host - stay reachable, so a working tooltip fetch says nothing about the guide pages. When the guide pages are blocked, take Icy Veins, whose rotation pages track the same patch and attach ids as `data-wowhead="spell=<id>"` on every ability:

```
https://www.icy-veins.com/wow/<spec-kebab>-<class-kebab>-pve-<dps|healing|tank>-rotation-cooldowns-abilities
```

Strip from its `guide-page-content` block, rewriting each `<span data-wowhead="spell=<id>">Name</span>` to
`Name(spell=<id>)` first so the ids survive tag removal. Healers use `healing`, not `healer`.

**Keep only the rotation and cooldowns sections.** After tag removal, drop paragraphs about talents, stat
priority, BiS lists, encounter navigation, macros outside rotation, and non-rotation mechanics. Keep the
opener, single-target rotation, AoE rotation, cooldown usage, and hero-talent variant sections. The
stripped file should be a few KB of text with ability ids inline, nothing more.

## 2c. spec icon stems - one lookup for every spec

`spec_icon` is a required field and its value is a zamimg icon file stem (e.g. `ability_stealth`). Read all of them at once from the game's own data:

```
https://wago.tools/db2/ChrSpecialization/csv      # Name_lang, ClassID, SpellIconFileID
https://wago.tools/db2/ManifestInterfaceData/csv  # ID -> FileName (about 9 MB)
```

Join `SpellIconFileID` to `ID` and lowercase the filename without its extension. Match a spec by name **plus `ClassID`** - spec names repeat across classes - using 1 Warrior, 2 Paladin, 3 Hunter, 4 Rogue, 5 Priest, 6 DeathKnight, 7 Shaman, 8 Mage, 9 Warlock, 10 Monk, 11 Druid, 12 DemonHunter, 13 Evoker. This resolves specs too new for the guides to describe. Confirm each stem with a HEAD against `https://wow.zamimg.com/images/wow/icons/large/<stem>.jpg`.

## 2d. `<spec>.abilities.tsv` - the WCL-verified ability-id table

Build one `name <tab> spell_id <tab> icon <tab> base_cd_s <tab> note` table per spec; the agent picks **every** id it writes from this table, so grounding happens here, once, at prep time - ingestion does not re-check ids.

The `note` column is what makes the table usable rather than merely correct. A spec routinely has several live ids sharing one name, and the agent cannot tell them apart from the name: the cast id and the aura id differ (Improved Garrote casts nothing and its logged buff is not its talent id), a reworked ability keeps its old id alive alongside the new one (both Crimson Tempest ids return "Crimson Tempest"), and a talent id is not what shows up in a log. Write the note in the vocabulary the agent's Inputs section defines (`CAST` / `SELF AURA` / `TARGET AURA` / `NOT observed` / `SAME NAME as id(s) X,Y`), with the sampled-parse count.

**A guide's inline id for a state buff is frequently not the id the logs carry**, and the name gate cannot tell: Balance Druid's guide writes `Eclipse (Solar)(spell=326053)`, `ability(id:326053)` answers "Eclipse (Solar)", and every log in the tier records the buff as **48517**. A rule built on the advertised id matches nothing and silently reads as followed on every pull. So an aura id only earns its row by appearing in a parse's `Buffs` or `Debuffs` table; when a guide names one the tables do not, keep the observed id and record the guide's in the note.

1. Collect candidate ids from three places:
   - the spell links extracted from the guide HTML (2b) - exact name-to-id pairs;
   - the sampled parses' kits filtered to **exact** APL action-name matches: `masterData{abilities{gameID name icon}}` from each `report.code` obtained via `worldData{encounter(id:E){characterRankings(className:C specName:S metric:dps)}}` (metric `hps` for healers), kept only when the normalized name (lowercase, underscores to spaces, apostrophes stripped) equals an APL action token. Substring matching against guide prose is wrong - common ability names ("Charge", "Judgment", "Execute") match ordinary sentences and drag other classes' spells into the table. The parse kit matters most for healers, whose SimC profile does not exist;
   - domain-knowledge candidates for the spec's cooldowns and defensives the rotation sources do not mention (the rotation guide page typically covers no defensives at all): name plus best-guess id. These are safe only because of the name gate in step 2.
2. Verify the union with **one batched** `gameData` query per spec (`query{gameData{ a<ID>: ability(id:<ID>){id name icon} ... }}` - `ability` lives under `gameData`); a `null` means the id does not exist - drop it. For every memory-sourced candidate, also require the returned name to equal the expected name - a real id attached to the wrong ability (a renamed or reworked spell) fails the gate and is dropped.
3. **Observe 3 to 5 top parses to separate casts from auras**, because step 2 cannot: the name gate passes a retired id, a talent id and an aura id equally, since all three return the right name. For each of the top rankings take its `report.code` + `fightID`, resolve the player's `sourceID` from `playerDetails(fightIDs:[F])`, then pull three tables for that source and union the results across parses, recording per id how many parses it appeared in:

   ```
   table(dataType:Casts   fightIDs:[F] sourceID:S)   # data.entries -> the cast ids actually pressed
   table(dataType:Buffs   fightIDs:[F] sourceID:S)   # data.auras   -> self aura ids + uptime
   table(dataType:Debuffs fightIDs:[F] sourceID:S)   # data.auras   -> aura ids, direction not guaranteed
   ```

   An id in `Casts` is a cast id; an id in `Buffs`/`Debuffs` is an aura id; a name-verified id in none of them is a talent or an unplayed build, and the note must say so rather than implying it is castable. When a name maps to two live ids, the one in `Casts` is the current one.

   **One parse is not enough evidence.** Cast tables are routinely partial and any single player's build leaves out abilities the spec generally presses, so a lone sample silently deletes real cooldowns from the rulebook. An id missing from every parse is evidence, missing from one is noise, and the count in the note lets the author weigh it. Sampling is nearly free - a full 40-spec run at 5 parses each stays well inside the 3600 points/hour budget - so spend it here.

   `Debuffs` filtered by `sourceID` does not reliably narrow to auras that source applied; it can return auras sitting on the player instead. Treat those ids as auras, and confirm from the guide that the spec actually applies one to enemies before using it for `aura_uptime_below` with `on: "target"`.
4. Fill `base_cd_s` from the Wowhead tooltip endpoint - `https://nether.wowhead.com/tooltip/spell/<id>` returns JSON whose `tooltip` HTML carries "`N sec/min cooldown`". Tooltip cooldowns are **base, pre-talent** values; they anchor the agent's `cooldown` numbers, which otherwise have no source at all. The same tooltip text carries the **buff/dot duration and the effect percentages**, so parse those in the same pass - they are what makes a `usage_rule` concrete. Fetch the whole id set from **one script** that requests concurrently and prints one line per id; a shell loop of backgrounded `curl` subshells re-prints its own body for every job it reaps and buries the results in noise.
5. **Filter the table before dispatch.** Drop any row whose name does not appear in the stripped APL
   action tokens, the stripped guide's `Name(spell=...)` references, or the defensive/cooldown candidate
   list. Keep aura ids for every buff token named in an APL condition (`buff.X.up`) even if the name only
   appears inside a condition. The goal is ~40 relevant rows, not every verified candidate.

## Validation recipes (Step 4)

Run the checks as **one script over all the files**, not a command per file per check:

- schema check: `python3 -c "import json,jsonschema; jsonschema.validate(json.load(open('<file>')), json.load(open('.claude/skills/warcraft-rulebook/rulebook.schema.json')))"` (`pip install jsonschema` first if the import fails).
- dash scan: no U+2014 / U+2013 / U+2212 anywhere in the file.
- **id cross-check**: walk every `spell_id` in `major_cooldowns`, `defensives` and each condition's id fields (including the `spell_ids` / `spend_spell_ids` / `alternative_spell_ids` / `except_buff_spell_ids` arrays) and assert the id is in that spec's table **and** that the name written beside it matches the table's name for that id. This catches a transposed pair that the schema cannot see, since both fields are individually well-typed. Compare with any trailing parenthetical stripped: WCL suffixes multi-part spells (`Stasis (Store)`) where the in-game name, which is what the player is shown, has no suffix.
- **no magnitudes in conditions**: assert no numeric value in any condition outside the id fields, `resource_type`, `health_pct` and `max_stacks`, and no `rules[].description` over 60 characters. Those three are game constants read from a tooltip, not field behaviour the encounter has to measure.
- unresolved-name follow-up: for any ability name an agent reported as missing from its table, find the id (Wowhead spell search), verify it with a WCL `ability(id:...)` query, and patch it in.

Then read the file. The mechanical checks pass on a rulebook whose coaching copy is wrong, so spot-check that each number in a `usage_rule` or `action` traces to an APL line or a guide sentence, and run the top-parse sanity check from the rulebook-author agent's quality bar over the rules.

**Replay every `filler_in_buff` rule against the sampled parses before keeping it** - its defects are invisible on the page. For each parse count the coached filler and its alternatives cast inside the state and outside every `except_buff_spell_ids` window, take the share, bench it the way the engine does (median, band `max(stddev, 0.1 * median)`), and check no parse falls under `median - band`. A failing parse means a state is missing from the exclusions: read that parse's violating casts, find the buff they all sit under, and add it. A rule measurable on under half the parses is not a defect - the encounter declines to bench it and the runtime drops it, the right outcome for a hero-talent build the field does not play.

When a rule fails these, send the defect back to that spec's dispatch if it still holds context - fixing one rule in-place is far cheaper than a cold re-run. Otherwise re-dispatch `rulebook-author` for that spec alone with the defect appended to its prompt; reserve a fresh dispatch for output that misses the bar broadly.

## Publish recipe (Step 5)

`frontend/public/data/specs/**` is **gitignored on every code branch** - rulebooks are never committed to a `main`-based branch. Their source of truth is the **`gh-pages`** branch, at `data/specs/{spec}/rulebook.json` (the shared dataset the site serves). Publish with a worktree based on `gh-pages`:

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

Open the PR with **base `gh-pages`** (push to `gh-pages` directly only when the user explicitly says so). Once merged, the hourly ingest overlays `data/specs` from `gh-pages` before each run and rebuilds that spec's benches over its next passes; the site reads the same tree directly. The gh-pages writers publish tree-based single commits, so the file content persists across their force-pushes.

**A publish is two PRs.** The skip check keys on `INGEST_VERSION` plus the top-parse set, never on the rulebook, so on a settled encounter the new file is overlaid and then skipped and the benches keep serving the old rules. Open a second PR against `main` bumping `INGEST_VERSION` (`frontend/src/app/ingest/ingest-version.ts`); one bump covers every spec in the run. Order does not matter, but the publish is not done until both land.

The worktree commits on a **temp branch pushed to the publish branch's remote ref** because the publish branch name is often already checked out on `main` history and `git worktree add -b` fails outright on the collision. Pushing a temp branch to `refs/heads/<publish-branch>` sidesteps it; the local pointer is irrelevant since the PR reads the remote. Verify with `git log origin/<publish-branch> -1`, not the local ref - it still sits on `main` history and makes history-checking tooling report the repo's merge commits as yours.

**Keeping the PR current needs a cherry-pick, never a plain rebase.** Each `gh-pages` writer force-pushes a single **parentless** commit, so a rebase onto the new tip replays the orphaned publish commit and reverts whatever that writer just shipped. Cut a fresh worktree from the new `origin/gh-pages`, cherry-pick your own commit onto it, and push with `--force-with-lease=refs/heads/<publish-branch>:<old-sha>`. Then confirm 0 behind / 1 ahead of `origin/gh-pages`, a diff of only rulebook files, and the other writers' directories intact.
