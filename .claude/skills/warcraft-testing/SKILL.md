---
name: warcraft-testing
description: warcraft-learner testing conventions and harness. Covers how tests run (ng test / Vitest via the @angular/build:unit-test builder, the three-step npm test, zoneless TestBed), the functional-core/imperative-shell per-slice spec layout, tests-as-documentation naming, the hard no-magic-numbers/named-constants rule, the fluent Events/bench/rulebook builders, the end-to-end fake-WclApiService pattern, and the mountVm signal harness. Load this before writing, changing, or debugging any *.spec.ts or test setup.
---

# warcraft-learner testing

The goals are readability, speed, and trivial testability: a test reads like a statement of the business rule, runs in milliseconds, and needs no ceremony.

**Framework and layout.** Tests use [Vitest](https://vitest.dev) via Angular's official `@angular/build:unit-test` builder (configured in `angular.json`). jsdom is the DOM environment and the builder initializes the `TestBed` environment itself. The app is zoneless (no zone.js); component tests opt into zoneless change detection per-`TestBed` through the `mountVm` harness, so there is no global setup file. The builder needs Node `>= 22.22.3` (the Angular CLI floor). The `npm test` command (see CLAUDE.md) runs three suites in sequence: the frontend specs under `src/**` (TestBed-backed, via the Angular builder), the ingestion specs under `scripts/ingest/**` (plain Node Vitest), and a `tsc` typecheck of the Node scripts.

The `src/**` specs cannot run under a bare `npx vitest` - they need the `@angular/build:unit-test` builder to set up the Angular TestBed; the `scripts/**` specs are plain Node Vitest.

**Functional core, imperative shell (per slice).** There is no central analysis module. Each vertical slice (`pages/post-raid/{rotation,burst-windows,defensive,gear,map}/`) owns its math as named, pure, **total** functions colocated in its own `*.service.ts` / `*-transform.service.ts` - no Angular, no async, no IO. The service classes are thin imperative shells that fetch and call those pure functions. So every slice has two kinds of spec, colocated next to the code:

| Spec | What it covers |
|---|---|
| `*-transform.service.spec.ts` | the slice's bench math (clustering / aggregation) as pure fns, **plus** an end-to-end pass through the `*TransformService` with a fake `WclApiService` |
| `*.service.spec.ts` | the `*FeatureService`'s pure view-model fns (table-driven), **plus** an end-to-end pass with a fake `*_DATA_SOURCE` (and a fake `WclApiService` where the slice fetches the player log) |

Ingestion runs these very `*TransformService`s headlessly, so the only specs under `scripts/ingest/**` cover the discovery + orchestration helpers it still owns (`wcl-fetchers.spec.ts`, `wcl-mappers.spec.ts`, `signature.spec.ts`, `ordering.spec.ts`).

**Conventions: tests as documentation.** Colocate specs next to the unit (`burst.service.spec.ts` beside `burst.service.ts`). For rule/threshold tests, pair every "triggers" case with a "does not trigger at the boundary" case - boundary comparisons are strict (a value exactly at `mean + 2*stddev` is **not** an outlier).

**Use readable named constants, never magic numbers or raw ids (hard requirement).** Import spell/item ids from `src/testing/spell-ids.ts` (`SHADOW_BLADES`, `CLOAK_OF_SHADOWS`, `SHADOW_BLADES_DAMAGE`, ...) and give every computed threshold/timing/damage value its own named `const` with a one-line derivation comment. A bare `279043`/`31224` spell id, or an unexplained `48`/`0.5` in a spec, is a defect - name it so the test reads as documentation.

**Fluent builders (`src/testing/`).** WCL event data is massive and quirky, so never load a JSON blob - build a minimal, readable event stream:

```ts
import { Events } from 'src/testing/builders/events';
import { SHADOW_BLADES, BLOODLUST } from 'src/testing/spell-ids';

const casts = Events.cast(SHADOW_BLADES, '0:01').cast(SHADOW_BLADES, '3:05').build();
const buffs = Events.start().applyBuff(BLOODLUST, '0:15').build();
```

Times are `"m:ss"` strings; with `FIGHT_START = 0` they map straight onto the fight-relative milliseconds the slices see. Defaults: player is actor `1`, boss is `2`; `damageTaken(...)` reverses them; `positioned(x, y, deg)` takes plain yards/degrees and encodes the WCL wire units. The `bench(...)` and `rulebook(...)` fixtures default every field, so a test states only what it exercises:

```ts
import { bench } from 'src/testing/builders/bench';
import { rulebook } from 'src/testing/builders/rulebook';

const bk = bench({ perCd: { 'Shadow Blades': { avg_first_cast_s: 3, stddev_first_cast_s: 1 } } });
const rb = rulebook({ cooldowns: [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 180 }] });
```

**End-to-end through a service (fake client).** The live WCL path is unreachable from CI, so the transform/feature services are driven with a fake `WclApiService` (canned rankings + report + `Events`-built streams), exercising the whole slice pipeline in-process. For a `*FeatureService` that reads a `*_DATA_SOURCE`, provide a fake source alongside the fake `WclApiService`.

**Signal view-models in leaves (`mountVm`).** Read presentational leaves' `computed()` signals directly via the `mountVm` harness - no DOM assertions, no `detectChanges`:

```ts
import { mountVm } from 'src/testing/component-harness';

const { vm } = mountVm(WindowComparisonComponent, { windows: [/* ComparisonWindow[] */] });
expect((vm['overviewMax'] as () => number)()).toBe(300);
```

`mountVm` configures a zoneless `TestBed`, applies each `input.required` via `setInput`, and returns the instance; pass stub providers as the third argument for components that inject a service. Feature components are thin (they delegate to one `*FeatureService` in an `effect`), so their logic is covered by the service spec rather than by mounting the component.
