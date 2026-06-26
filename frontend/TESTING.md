# Testing guide

How we test `warcraft-learner`. The goals are **readability, speed, and trivial
testability**: a test should read like a statement of the business rule, run in
milliseconds, and need no ceremony to set up.

## Framework & how to run

We use [Vitest](https://vitest.dev) via Angular's official
`@angular/build:unit-test` builder (configured in `angular.json`). jsdom is the
default DOM environment, and the builder initializes the `TestBed` environment
itself. The app is zoneless (no zone.js); component tests opt into zoneless
change detection per-`TestBed` through the `mountVm` harness, so no global setup
file is needed.

```bash
npm test            # ng test (Vitest) + scripts Vitest + scripts typecheck
npm run test:watch  # watch mode for the frontend suite
```

`npm test` runs three things in sequence:

1. `ng test` - the frontend specs under `src/**` (TestBed-backed; needs the Angular builder).
2. `vitest run --config vitest.scripts.config.ts` - the ingestion specs under `scripts/ingest/**`.
3. `tsc -p tsconfig.scripts.json --noEmit` - typechecks the Node scripts.

> The `src/**` specs cannot be run with a bare `npx vitest` - they need the
> `@angular/build:unit-test` builder to set up the Angular TestBed environment.
> Use `ng test` for those. The `scripts/**` specs are plain Node Vitest.

> Note: the builder requires Node `>= 22.22.3` (Angular CLI's floor).

## Architecture: functional core, imperative shell (per slice)

There is no central analysis module. Each **vertical slice**
(`pages/post-raid/{rotation,burst-windows,defensive,gear,map}/`) owns its math as
**named, pure, total functions colocated in its own `*.service.ts` and
`*-transform.service.ts`** - no Angular, no async, no I/O. The service classes are
thin imperative shells that fetch and call those pure functions. This is the same
functional-core / imperative-shell split as before, now per use case and
self-contained (each slice reimplements what it needs rather than importing shared
analysis; ingestion runs these same slices, so there is no second copy to keep in sync).

So every slice has two kinds of spec, colocated next to the code:

| Spec | What it covers |
|---|---|
| `*-transform.service.spec.ts` | the slice's bench math (clustering / aggregation) as pure fns, **plus** an end-to-end pass through the `*TransformService` with a fake `WclApiService` |
| `*.service.spec.ts` | the `*FeatureService`'s pure view-model fns (table-driven), **plus** an end-to-end pass with a fake `*_DATA_SOURCE` (and a fake `WclApiService` where the slice fetches the player log) |

Ingestion runs these very `*TransformService`s headlessly (it has no separate analysis
copy), so the only specs under `scripts/ingest/**` cover the discovery helpers it still
owns: `wcl-fetchers.spec.ts`, `wcl-mappers.spec.ts`, `code-hash.spec.ts`, and
`signature.spec.ts`.

A pure function gets a focused table-driven test; the service end-to-end test
asserts the assembled view-model from canned inputs - no network, no `TestBed`
service graph.

## The fluent builders (`src/testing/`)

WCL event data is massive and quirky. Never load a JSON blob - build a minimal,
readable event stream:

```ts
import { Events } from 'src/testing/builders/events';
import { SHADOW_BLADES, BLOODLUST } from 'src/testing/spell-ids';

const casts = Events.cast(SHADOW_BLADES, '0:01').cast(SHADOW_BLADES, '3:05').build();
const buffs = Events.start().applyBuff(BLOODLUST, '0:15').build();
```

- Times are `"m:ss"` strings; with `FIGHT_START = 0` they map straight onto the
  fight-relative milliseconds the slices see.
- Defaults: the player is actor `1`, the boss is `2`. `damageTaken(...)` reverses
  them. `positioned(x, y, deg)` takes plain yards/degrees and encodes the WCL
  wire units (hundredths of a yard, milliradians, `resourceActor`).

Bench and rulebook fixtures default every field, so a test states only what it
exercises:

```ts
import { bench } from 'src/testing/builders/bench';
import { rulebook } from 'src/testing/builders/rulebook';

const bk = bench({ perCd: { 'Shadow Blades': { avg_first_cast_s: 3, stddev_first_cast_s: 1 } } });
const rb = rulebook({ cooldowns: [{ name: 'Shadow Blades', spell_id: SHADOW_BLADES, cooldown: 180 }] });
```

The remaining ingestion specs (discovery helpers) use plain inline fakes and fixtures -
there is no separate ingest builder toolkit.

## Conventions: tests as documentation

- **Colocate** specs next to the unit (`burst.service.spec.ts` beside `burst.service.ts`).
- `describe` names the unit: `'burstWindowStatus'`, `'findParseWindows'`.
- `it` is a behavior sentence, no "should": `it('flags a value more than 2 sigma above the mean')`.
- For rule/threshold tests, pair every "triggers" case with a "does not trigger at
  the boundary" case. Boundary comparisons are strict: a value exactly at
  `mean + 2*stddev` is **not** an outlier.

## Testing the pure functions

Every calculated field is a named pure function in the slice's service file,
tested as data-in / data-out - no events, no `TestBed`:

```ts
// burst.service.spec.ts - the window status glyph
expect(burstWindowStatus(650, 1000, 800, 100, false)).toEqual({ status: 'bad', icon: 'error' });
expect(burstWindowStatus(1000, 1000, 800, 100, false)).toEqual({ status: 'good', icon: 'check_circle' });
```

The transform's clustering is tested the same way (`findParseWindows`,
`clusterParseWindows`), and the feature service's bucketing / row-building fns as
table-driven cases.

## End-to-end through a service (fake client)

The live WCL path is unreachable from CI, so the transform/feature services are
driven with a fake `WclApiService` (canned rankings + report + `Events`-built
streams). This exercises the whole slice pipeline in-process:

```ts
TestBed.configureTestingModule({
  providers: [
    { provide: WclApiService, useValue: wclFake as unknown as WclApiService },
    { provide: DataFileApiService, useValue: filesFake as unknown as DataFileApiService },
  ],
});
const bench = await TestBed.inject(BurstTransformService).getBurstBench('SubtletyRogue', 1);
expect(bench!.windows[0].common_cds).toContain('Shadow Blades');
```

For a `*FeatureService` that reads a `*_DATA_SOURCE`, provide a fake source:

```ts
const source = { getBurstBench: () => Promise.resolve(benchFixture) };
TestBed.configureTestingModule({ providers: [
  { provide: BURST_DATA_SOURCE, useValue: source },
  { provide: WclApiService, useValue: wclFake as unknown as WclApiService },
] });
const view = await TestBed.inject(BurstFeatureService).loadPlayerView('SubtletyRogue', 1, 'rep', 1, 10);
expect(view.windows[0].overview.playerPct).toBe(950);
```

## Signal view-models in leaves

Read presentational leaves' `computed()` signals directly via `mountVm` (no DOM
assertions, no `detectChanges`):

```ts
import { mountVm } from 'src/testing/component-harness';

const { vm } = mountVm(WindowComparisonComponent, { windows: [/* ComparisonWindow[] */] });
expect((vm['overviewMax'] as () => number)()).toBe(300);
```

`mountVm` configures a zoneless `TestBed`, applies each `input.required` via
`setInput`, and returns the instance. Pass stub providers as the third argument
for components that inject a service. Feature components are thin (they delegate
to one `*FeatureService` in an `effect`), so their logic is covered by the
service spec rather than by mounting the component.
