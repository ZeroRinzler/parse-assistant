---
name: warcraft-testing
description: warcraft-learner testing conventions and harness. Covers how tests run (ng test / Vitest via the @angular/build:unit-test builder, one suite over src/** incl. the ingest specs, zoneless TestBed), the functional-core/imperative-shell per-slice spec layout, tests-as-documentation naming, the hard no-magic-numbers/named-constants rule, the shared event/rulebook fixture factories and per-slice local bench factories, the end-to-end fake-WclApiService pattern, the mountVm signal harness, and the lowest-altitude rule. Load this before writing, changing, or debugging any *.spec.ts or test setup.
---

# warcraft-learner testing

The goals are readability, speed, and trivial testability: a test reads like a statement of the business rule, runs in milliseconds, and needs no ceremony.

**Framework and layout.** Tests use [Vitest](https://vitest.dev) via Angular's official `@angular/build:unit-test` builder (configured in `angular.json`). jsdom is the DOM environment and the builder initializes the `TestBed` environment itself. The app is zoneless (no zone.js); component tests opt into zoneless change detection per-`TestBed` through the `mountVm` harness, so there is no global setup file. The builder needs Node `>= 22.22.3` (the Angular CLI floor). The `npm test` command (see CLAUDE.md) is one suite: every spec under `src/**` - including the ingest specs under `src/app/ingest/` - runs through the Angular builder.

The `src/**` specs cannot run under a bare `npx vitest` - they need the `@angular/build:unit-test` builder to set up the Angular TestBed (the pure ingest specs simply don't touch it).

**Functional core, imperative shell (per slice).** There is no central analysis module. Each vertical slice (`pages/post-raid/{rotation,burst-windows,defensive,gear,map}/`) owns its math as named, pure, **total** functions colocated in its own `*.service.ts` / `*-transform.service.ts` - no Angular, no async, no IO. The service classes are thin imperative shells that fetch and call those pure functions. So every slice has two kinds of spec, colocated next to the code:

| Spec | What it covers |
|---|---|
| `*-transform.service.spec.ts` | the slice's bench math (clustering / aggregation) as pure fns, **plus** an end-to-end pass through the `*TransformService` with a fake `WclApiService` |
| `*.service.spec.ts` | the `*FeatureService`'s pure view-model fns (table-driven), **plus** an end-to-end pass with a fake `*_DATA_SOURCE` (and a fake `WclApiService` where the slice fetches the player log) |

A slice whose transform and feature service need the same pure code keeps it in one slice-local module instead of either service (`gear-extract.ts`, `map-draw.ts`, `rotation-rules.ts`), and that module carries its own colocated spec - so its behavior is pinned once, at the altitude that owns it, rather than from whichever service happens to import it.

Ingestion runs these very `*TransformService`s, so the specs under `src/app/ingest/` cover only the orchestration helpers: discovery (`wcl-fetchers` with a fake `WclQueryClient`, `wcl-mappers`), `signature`, `ordering`, and `ingest-data-file-transport` (HttpTestingController against the file-server endpoints).

**Conventions: tests as documentation.** Colocate specs next to the unit (`burst.service.spec.ts` beside `burst.service.ts`). For rule/threshold tests, pair every "triggers" case with a "does not trigger at the boundary" case - boundary comparisons are strict (a value exactly at `mean + 2*stddev` is **not** an outlier).

**Use readable named constants, never magic numbers or raw ids (hard requirement).** Import spell/item ids from `src/testing/spell-ids.ts` (`SHADOW_BLADES`, `CLOAK_OF_SHADOWS`, `SHADOW_BLADES_DAMAGE`, ...) and give every computed threshold/timing/damage value its own named `const` with a one-line derivation comment. A bare `279043`/`31224` spell id, or an unexplained `48`/`0.5` in a spec, is a defect - name it so the test reads as documentation.

**Event fixtures (`src/testing/builders/events`).** WCL event data is massive and quirky, so never load a JSON blob - build a minimal, readable event stream from the shared plain factory functions (re-exported by the `src/testing` barrel). Each call returns one `WclEvent` (except `buffWindow`, which returns the applybuff + removebuff pair), times are fight-relative **seconds** (converted to the wire's milliseconds), and an omitted opt leaves the field absent, not `undefined`:

- `cast(spellId, atS, opts?: { source?, target? })`
- `applyBuff(spellId, atS, opts?: { target? })` / `removeBuff(...)` - a self-buff lands on its target, so `target` sets both actor fields
- `buffWindow(spellId, fromS, toS, opts?: { target? })` - the apply + remove pair for a buff active over the window
- `damage(spellId, atS, amount, opts?: { source?, target?, absorbed? })` - damage the player deals
- `damageTaken(spellId, atS, amount, opts?: { source?, absorbed? })` - `source` is the attacker; no target actor is set

```ts
// import paths are relative from a slice spec under src/app/pages/post-raid/<slice>/
import { cast, buffWindow } from '../../../../testing/builders/events';
import { SHADOW_BLADES, FEINT } from '../../../../testing/spell-ids';

const events = [cast(SHADOW_BLADES, 1), cast(SHADOW_BLADES, 185), ...buffWindow(FEINT, 10, 16)];
```

**Rulebook fixture (`src/testing/builders/rulebook`).** `rulebook(...)` defaults every field so a spec states only what it exercises: cooldown seeds (`name`, `spell_id`, `cooldown` required) become `major_cooldowns` with `align_with_bloodlust` defaulted, defensive seeds become `defensives` with `duration` defaulted, and `spec` / `rules` default when omitted.

```ts
const rb = rulebook({ cooldowns: [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 180 }] });
```

**Bench fixtures are local to each slice spec.** Each slice owns its bench type (e.g. `RotationBench` in its `*-data-source.ts`), so there is no shared bench builder: the spec declares a small local factory next to its tests that defaults every field and spreads `Partial` overrides - e.g. `function bench(over: Partial<RotationBench> = {}): RotationBench` (with a sibling `cdBench()` for the per-cooldown benchmark objects).

**Map specs build raw wire-unit events on purpose.** The map slice pins the WCL position wire format - coordinates in hundredths of a yard, facing in milliradians - so its specs construct resource events with local helpers the slice owns (e.g. `resEvent(...)` in `map-transform.service.spec.ts`), not the shared factories.

**End-to-end through a service (fake client).** The live WCL path is unreachable from CI, so the transform/feature services are driven with a fake `WclApiService` (canned rankings + report + factory-built event streams), exercising the whole slice pipeline in-process. For a `*FeatureService` that reads a `*_DATA_SOURCE`, provide a fake source alongside the fake `WclApiService`.

**Signal view-models in leaves (`mountVm`).** Read presentational leaves' `computed()` signals directly via the `mountVm` harness (`src/testing/component-harness.ts`) - no DOM assertions, no `detectChanges`:

```ts
import { mountVm } from '../../../../testing/component-harness';

const { vm } = mountVm(WindowComparisonComponent, { windows: [/* ComparisonWindow[] */] });
expect((vm['overviewMax'] as () => number)()).toBe(300);
```

`mountVm` configures a zoneless `TestBed`, applies each `input.required` via `setInput`, and returns the instance (plus a `setInput` for later updates); pass stub providers as the third argument for components that inject a service. Feature components are thin (they delegate to one `*FeatureService` in an `effect`), so their logic is covered by the service spec rather than by mounting the component.

**Altitude rule.** Test behavior exhaustively at the lowest altitude that owns it: a composite function gets exactly one composition test wiring already-tested parts together, and slice specs never re-test shared helpers that have their own colocated specs (`analysis-math`, `wcl-projections`, `gear-extract`).
