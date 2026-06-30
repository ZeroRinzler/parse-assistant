---
name: warcraft-wcl-data
description: warcraft-learner Warcraft Logs (WCL) integration quirks, auth model, and position data. Covers the intentional embedded client-credentials secret (a deliberate trade-off, NOT a leak to fix), the non-obvious WCL API quirks that have caused bugs (Midnight actor.subType / playerDetails spec resolution, positionally-indexed gear array, weapon/trinket slot indices, v1 vs v2 talent formats, permanentEnchant string, server.region string, removed gameData.spell(), event positions via includeResources and their flattened x/y/facing/mapID units), and the external-API auth table. Load this before touching WCL queries, gear/spec/talent/enchant extraction, wcl-auth, the embedded secret, or anything reading event positions.
---

# warcraft-learner WCL integration

## Browser auth model (intentional embedded secret)

The browser authenticates to WCL with the **client-credentials** grant against `/api/v2/client`, using a client id + secret **hardcoded in `core/services/wcl-auth.ts`** (and therefore shipped, public, in the static JS bundle). This is a deliberate trade-off, not a leak to fix:

- The token only reads the same **public** WCL report data the app always read; there is no private data behind it and no user-specific budget to lose. The app never required user-scoped access.
- The **only** risk is someone extracting the secret and draining the app's shared hourly rate-limit budget. Mitigation is manual: regenerate the secret at `warcraftlogs.com/api/clients/` and redeploy. WCL exposes **no API to rotate a client secret**, so this cannot be automated.
- There is **no login UI, callback route, or PKCE flow** anymore. `WclAuthService.getToken()` fetches and caches the token silently. Consequently the `userData.currentUser` "your own characters" convenience was removed end-to-end (a client token has no current user); users always supply a report code or character name.
- This is independent of the **ingestion** client credentials (`WCL_CLIENT_ID`/`WCL_CLIENT_SECRET`), which remain server-side-only GHA secrets used by the CLI.

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
| **Solving the talent format problem** | The gear/rotation transform services fire a parallel `encounterRankings` query per ranked player to get the `v2:` talent key, overwriting the `v1:` key from `characterRankings`. |
| **`server.region` may be a string** | In `characterRankings` JSON blob, `server.region` is sometimes `"EU"` (string) rather than `{slug: "eu"}`. Handle both forms. |
| **`gameData.spell()` was removed** | Spell icons and names must come from `masterData.abilities` in the report response. |
| **Event positions need `includeResources: true`** | The default `events` response carries no coordinates. Passing `includeResources: true` attaches the actor's resource snapshot, which includes position. Adds bandwidth, so it is off by default and only requested by the positioning feature. |
| **Position is flattened onto the event, not nested** | With resources on, `x`, `y`, `facing`, `mapID` (plus `hitPoints`, etc.) appear at the **top level** of the event - there is no `sourceResources`/`targetResources` object. Each event describes **one** actor; `resourceActor` says which (`1` = source, `2` = target). Attribute the coords to `resourceActor === 2 ? targetID : sourceID`. |
| **Events default to friendly only** | The `events` query defaults to `hostilityType: Friendlies`, so an all-source `Casts` fetch returns only the raid. Boss/add casts (and their positions) require a separate fetch with `hostilityType: Enemies`. |
| **Position/facing units** | `x`/`y` are in hundredths of a yard (`/100` -> yards). `facing` is in milliradians (`/1000` -> radians) and its zero-point does not match a screen "up" axis - apply a `-π/2` offset so "behind the boss" renders behind (see `FACING_OFFSET_RAD` in `positioning-core.ts`). |
| **`mapID` marks the phase/sub-map** | Coordinates are only comparable between actors sharing a `mapID`; it changes across phases that swap maps. Filter to a common `mapID` before computing relative positions. |

## External APIs

| API | Auth | Where used |
|---|---|---|
| Warcraft Logs v2 (GraphQL, `/api/v2/client`) | Client credentials (browser; embedded secret, see "Browser auth model") | Report events, character rankings, gear lookup |
| Warcraft Logs v2 (GraphQL, `/api/v2/client`) | Client credentials (CLI/GHA only, never browser) | The transform services fetching parses (via the shared `WclApiService` under the Node transport, driven by `scripts/ingest/orchestrator.ts`) |

## Event positions

The on-disk `positions/{enc_id}.json` shape is not duplicated here - read it from `core/models/positioning.models.ts` (written by `MapTransformService.getMapData`, consumed by `core/services/positioning-core.ts`). The non-obvious part that bites is the **raw WCL units** stored in each row (x/y in hundredths of a yard, facing in milliradians) - the position/facing-unit quirks in the table above explain the conversions the frontend applies.
