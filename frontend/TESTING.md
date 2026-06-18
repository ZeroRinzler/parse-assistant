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
npm test            # run the whole suite (ng test -> Vitest)
npm run test:watch  # watch mode
```

The framework-free suites (everything under `src/app/core/analysis/**` and the
builders) are plain TypeScript and can also be run directly with
`npx vitest run src/app/core src/testing` for a fast inner loop.

> Note: the `@angular/build:unit-test` builder requires Node `>= 22.22.3`
> (Angular CLI's floor). On older patch releases `ng test` refuses to start;
> bump Node to run the full suite.

## Architecture: functional core, imperative shell

The CPU-bound analysis is a set of **pure functions** under
`src/app/core/analysis/`, with no Angular, no async, no I/O:

| Module | What it owns |
|---|---|
| `bench-stats.ts` | The statistical atoms (`isOutlierAbove`, `expectedUses`, ...) |
| `rule-engine.ts` | `cast_without_prior` / `hold_cooldown_for_anchor` evaluation |
| `cooldown-analysis.ts` | Lost casts, opener delay, BL alignment, gaps, efficiency |
| `defensive-analysis.ts` | Buff-window-centric defensive findings |
| `burst-windows.ts` | Player damage mapped onto top-parse windows |
| `damage-taken.ts` | Damage-taken-by-ability aggregation |
| `compute-analysis.ts` | `computeAnalysis` - composes the above (the worker entry) |

The **imperative shell** stays thin and is the only part that touches Angular:

- `analysis.worker.ts` - calls `computeAnalysis` off the main thread.
- `core/analysis/run-analysis.ts` - `runAnalysis(src, compute, args)` holds the
  fetch sequencing, depending only on the `AnalysisDataSource` seam
  (`analysis-data-source.ts`), not on Angular services.
- `services/analysis-engine.ts` - adapts the WCL/encounter services to
  `AnalysisDataSource` and owns the worker plumbing.

This means the rule math is tested with plain data (no `TestBed`, no mocks) and
the fetch orchestration is tested with a `vi.fn()`-backed fake data source.

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
  fight-relative milliseconds the engine sees.
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

## Conventions: tests as documentation

- **Colocate** specs next to the unit (`bench-stats.spec.ts` beside `bench-stats.ts`).
- `describe` names the unit: `'isOutlierAbove'`, `'evaluateRules / cast_without_prior'`.
- `it` is a behavior sentence, no "should": `it('flags a value more than 2 sigma above the mean')`.
- For rule tests, put the **rule definition and the events that trigger it in the
  same `it` body**, and pair every "triggers" case with a "does not trigger at
  the boundary" case. Boundary comparisons are strict: a value exactly at
  `mean + 2*stddev` is **not** an outlier.

## Statistical testing

Every bench comparison is one named predicate in `bench-stats.ts`, tested as pure
arithmetic - no events, no rulebook:

```ts
// mean 10, stddev 2, 2 sigma -> threshold 14
expect(isOutlierAbove(15, 10, 2)).toBe(true);
expect(isOutlierAbove(14, 10, 2)).toBe(false); // exactly at the threshold
```

The cooldown/defensive analyses call these atoms, so a higher-level test only
needs to assert that the right finding appears for a given bench fixture.

## Signal view-models

Read `computed()` signals directly via `mountVm` (no DOM assertions, no
`detectChanges` - so `ngOnInit`/`ngOnChanges` network code never runs):

```ts
import { mountVm } from 'src/testing/component-harness';

const { vm } = mountVm(WindowComparisonComponent, { windows: [/* ComparisonWindow[] */] });
expect((vm['overviewMax'] as () => number)()).toBe(300);
```

`mountVm` configures a zoneless `TestBed`, applies each `input.required` via
`setInput`, and returns the instance. Pass stub providers as the third argument
for components that inject services doing I/O.

### Injection-heavy pages: extract a `.vm.ts`

`mountVm` fits components whose state is driven by `input()`. The page
components (`post-raid`, `pre-fight`) instead inject ~8 services in their
constructor and load state through async WCL fetches, so mounting them just to
read a `computed()` would mean stubbing the whole service graph. For these, the
**pure view-model derivations live in a sibling `*.vm.ts`** (e.g.
`pre-fight.vm.ts`, `post-raid.vm.ts`): plain functions from data models
(`Rulebook`, `EncounterBench`, `CharacterGear`, ...) to the row shapes the
template renders. The component's `computed()`s become one-line wrappers:

```ts
// pre-fight.ts
protected readonly cdPlan = computed(() => buildCdPlan(this.rulebook(), this.bench()));
```

```ts
// pre-fight.vm.spec.ts - no TestBed, no service stubs
const rb = rulebook({ cooldowns: [{ name: 'Burst', spell_id: SHADOW_BLADES, cooldown: 90, align_with_bloodlust: true }] });
expect(buildCdPlan(rb, bench({ perCd: { Burst: { bl_pct: 80 } } }))[0].bloodlustPct).toBe(80);
```

This is the same functional-core/imperative-shell split as the analysis engine:
the derivation logic is tested as pure data-in/data-out, and the component is
left as a thin wrapper that wires signals to those functions.

## Before & after

The σ-thresholds used to be inline expressions repeated across the monolith:

```ts
// before - analysis-core.ts (one of several copies)
if (firstS > b.avg_first_cast_s + 2 * sdF) { /* push warning */ }
```

Now the comparison has a single named definition and a focused test:

```ts
// after - bench-stats.ts
export function isOutlierAbove(value: number, mean: number, stddev: number, sigmas = 2): boolean {
  return value > mean + sigmas * stddev;
}
```

```ts
// after - cooldown-analysis.spec.ts (reads like the requirement)
it('warns when the opener is later than the top-parse mean + 2 sigma', () => {
  const bk = bench({ perCd: { 'Shadow Blades': { avg_first_cast_s: 3, stddev_first_cast_s: 1 } } });
  const casts = Events.cast(SHADOW_BLADES, '0:10').cast(SHADOW_BLADES, '3:10').build();

  const result = analyzeCooldowns('Rogue', 'Sub', 0, parseClock('5:00'), casts, [], cds, [], bk);

  expect(result.findings.find((f) => f.category === 'cooldown_delay')?.severity).toBe('warning');
});
```
