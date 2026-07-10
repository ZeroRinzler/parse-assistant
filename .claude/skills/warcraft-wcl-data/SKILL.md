---
name: warcraft-wcl-data
description: warcraft-learner Warcraft Logs (WCL) integration quirks, auth model, and position data. Covers the intentional embedded client-credentials secret (a deliberate trade-off, NOT a leak to fix), the non-obvious WCL API quirks that have caused bugs (Midnight actor.subType / playerDetails spec resolution, positionally-indexed gear array, weapon/trinket slot indices, v1 vs v2 talent formats, permanentEnchant string, server.region string, removed gameData.spell(), event positions via includeResources and their flattened x/y/facing/mapID units), and the external-API auth table. Load this before touching WCL queries, gear/spec/talent/enchant extraction, wcl-auth, the embedded secret, or anything reading event positions.
---

# warcraft-learner WCL integration

## Browser auth model (intentional embedded secret)

The browser authenticates to WCL with the **client-credentials** grant against `/api/v2/client`, using a client id + secret **hardcoded in `src/environments/wcl-public-client.ts`** (surfaced through each environment file's `wclClientId`/`wclClientSecret`, read by `core/services/wcl-auth.ts` - and therefore shipped, public, in the static JS bundle). This is a deliberate trade-off, not a leak to fix:

- The token only reads the same **public** WCL report data the app always read; there is no private data behind it and no user-specific budget to lose. The app never required user-scoped access.
- The **only** risk is someone extracting the secret and draining the app's shared hourly rate-limit budget. Mitigation is manual: regenerate the secret at `warcraftlogs.com/api/clients/` and redeploy. WCL exposes **no API to rotate a client secret**, so this cannot be automated.
- There is **no login UI, callback route, or PKCE flow** anymore. `WclAuthService.getToken()` fetches and caches the token silently. Consequently the `userData.currentUser` "your own characters" convenience was removed end-to-end (a client token has no current user); users always supply a report code or character name.
- **Ingestion authenticates the same way**: the ingest environment carries the same embedded pair, so the hourly CI ingest, local ingest runs, and the deployed app all share one WCL client and its hourly rate-limit budget (the orchestrator's budget gate keeps ingest from draining it). To ingest on a dedicated client's budget, edit the pair in `environment.ingest.ts` locally - never commit a private pair.

## WCL API quirks

Non-obvious things that have caused bugs - read before touching gear extraction or spec resolution.

| Quirk | Detail |
|---|---|
| **`actor.subType` changed in Midnight** | Now returns class-only (`Rogue`). Use `playerDetails(fightIDs:[...])` to get full spec info. `WclApiService.getPlayerDetails` (via `buildSpecMap`) handles the conversion; the post-raid shell resolves spec from it. |
| **Gear array is positionally indexed** | WCL returns gear as a bare array; the array index (0-based) IS the slot number. No `slot` field. |
| **Weapon slots shifted in Midnight** | Gear array has 17 entries (0-16). Weapons at index 15 (MH) and 16 (OH). Index 14 is Back/Cloak. |
| **Trinket slots are 12 and 13** | Confirmed from `encounterRankings` responses. |
| **`permanentEnchant` is a string** | Numeric ID returned as string. `permanentEnchantName` is never populated. Enchant names resolved via `gameData.enchant(id)` in the gear transform service. |
| **Two incompatible talent formats** | `characterRankings` -> old format (`{talentID, points}` list) -> `v1:` key. `encounterRankings` -> Midnight format (nested `nodeId` dict) -> `v2:` key. ID spaces are incompatible; cannot compare directly. |
| **Resolving the talent key** | Both the bench and the analyzed player's `v2:` talent key come from each parse's CombatantInfo `talentTree` (the nested `nodeID` dict, via `talentKeyFromTree` in `gear-extract.ts`), so they are the same format and compare directly. |
| **`server.region` may be a string** | In `characterRankings` JSON blob, `server.region` is sometimes `"EU"` (string) rather than `{slug: "eu"}`. Handle both forms. |
| **No `gameData.spell()`; use `masterData.abilities`** | Spell icons and names come from `masterData.abilities` in the report response, or `gameData.ability(id)` by id (which resolves any real id but returns `null` for a nonexistent one - see the ingest rulebook spell-id gate). |
| **Melee auto-attack is event ability id `1`** | Physical auto-attacks carry `abilityGameID: 1`, so melee legitimately appears in a burst/defensive damage breakdown. But id 1 is not a real spell: `gameData.ability(1)` resolves the stale game spell 1 - "Word of Recall (OLD)", icon `trade_engineering` - so its name, icon, and Wowhead link (`wowhead.com/spell=1`) all point at Word of Recall. `normalizeAbilityId` (`shared/analysis/wcl-projections.ts`) maps the id-1 sentinel to the real Auto Attack spell (`6603`) when a breakdown `spell_id` is built, so every downstream lookup resolves correctly through the real spell. |
| **Negative ability ids are synthetic, sourceless events** | Some event `abilityGameID`s are negative (e.g. `-32` on a priest log) - WCL synthesizes them for sourceless / spell-less events (pet melee, environmental damage) that no real game spell backs, so `gameData.ability` resolves none of them and a card would warn `ability id missing from ability map`. This convention is not publicly documented by WCL. `normalizeAbilityId` (`shared/analysis/wcl-projections.ts`) folds every negative id onto `WCL_SYNTHETIC_SOURCE_FALLBACK_ID` (game spell `291807`, literally named "I Don't Know") when a breakdown `spell_id` is built - the same mechanism that maps the melee id-1 sentinel to Auto Attack - so the collapsed sources render as one resolvable, clickable row. |
| **`Buffs` filter is aura-target, not caster** | A `Buffs` events fetch with `sourceID` = the player returns the auras that are ON the player, whoever applied them - so Bloodlust/Heroism/Time Warp (cast by another raider) appears on a non-shaman's OWN `Buffs` stream. This is why rotation BL detection works for every spec by scanning the player's Buffs for the BL ability ids. |
| **Event positions need `includeResources: true`** | The default `events` response carries no coordinates. Passing `includeResources: true` attaches the actor's resource snapshot, which includes position. Adds bandwidth, so it is off by default and only requested by the positioning feature. |
| **Position is flattened onto the event, not nested** | With resources on, `x`, `y`, `facing`, `mapID` (plus `hitPoints`, etc.) appear at the **top level** of the event - there is no `sourceResources`/`targetResources` object. Each event describes **one** actor; `resourceActor` says which (`1` = source, `2` = target). Attribute the coords to `resourceActor === 2 ? targetID : sourceID`. |
| **Events default to friendly only** | The `events` query defaults to `hostilityType: Friendlies`, so ANY enemy-side fetch returns nothing without `hostilityType: Enemies` - even one that names an enemy `sourceID` (the hostility filter is applied first). The map slice fetches enemy casts with `hostilityType: Enemies` and builds the boss/add position trails from them (see `MapTransformService.fetchPositionEvents`). |
| **Position/facing units** | `x`/`y` are in hundredths of a yard (`/100` -> yards). `facing` is in milliradians (`/1000` -> radians) and its zero-point does not match a screen "up" axis - apply a `-π/2` offset so "behind the boss" renders behind (see `FACING_OFFSET_RAD` in `map.service.ts`, used by `map-draw.ts`). |
| **`mapID` marks the phase/sub-map** | Coordinates are only comparable between actors sharing a `mapID`; it changes across phases that swap maps. Filter to a common `mapID` before computing relative positions. |

## External APIs

| API | Auth | Where used |
|---|---|---|
| Warcraft Logs v2 (GraphQL, `/api/v2/client`) | Client credentials (browser; embedded secret, see "Browser auth model") | Report events, character rankings, gear lookup |
| Warcraft Logs v2 (GraphQL, `/api/v2/client`) | Client credentials (browser; the same embedded pair) | The transform services fetching parses during ingest (via the shared `WclApiService`, driven by `src/app/ingest/ingest-orchestrator.service.ts`) |

## Event positions

The on-disk `positions/{enc_id}.json` shape is not duplicated here - read it from `core/models/positioning.models.ts` (written by `MapTransformService.getBench`, consumed by the map slice: `map.service.ts` state + the `map-draw.ts` drawing geometry). The non-obvious part that bites is the **raw WCL units** stored in each row (x/y in hundredths of a yard, facing in milliradians) - the position/facing-unit quirks in the table above explain the conversions the frontend applies.
