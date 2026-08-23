---
name: warcraft-change
description: warcraft-learner change contract - what a code change must deliver, end to end. Covers the four change kinds (finding, rule kind, slice, page), the universal checklist (slice math, bench shape, failure handling, UI, copy, specs), the self-review checklist, and the verification commands. Load this before writing, changing, or reviewing any code under frontend/src.
---

# warcraft-learner change

**What good looks like:** a change is playable end to end - the analysis computes it, ingestion bakes it, the page renders it, the copy coaches it, and a spec pins it. Testing is not a phase; it is part of the deliverable.

**Deliverable:** the checklist below holds for your diff, the self-review checklist passes, and `npm test` + `npm run lint` + `npm run build` pass.

## Universal checklist

Every change delivers some subset of:

1. **Slice math** - named, stateless methods: protected on the slice's facade service, or public on a `domain/` service. Methods take data in and return data; IO stays behind the two API services.
2. **Bench shape** - if the change alters what ingestion must bake, update the slice's `*Bench` interface in its `data-access/*-data-source.ts` and bump `INGEST_VERSION` (`src/app/features/raid-analysis/ingest/domain/ingest-version.ts`).
3. **Failure handling** - every fallible load returns `Result<T, LoadError>`; the four render states (content / waiting / transient error / permanent error). No silent swallow.
4. **UI** - template owns styling off the `styles.scss` tokens, formatting goes through pipes, drill-down uses `wl-finding-occurrences`.
5. **Copy** - message + remedy in the terse analyst voice. Governing skill: **warcraft-writing**.
6. **Specs** - pure math tested at the lowest altitude, services end-to-end through fakes. Each "triggers" case paired with a "does not trigger at the boundary" case.
7. **WCL reads** - a new event stream or gear/talent/position field means checking the quirks table first. Governing skill: **warcraft-wcl-data**.

## Change kinds

### New finding on an existing slice

Deliver: the pure check in the slice's colocated functions, a `FindingOccurrence`-populated result, message + remedy copy, boundary-paired specs. No bench change means no `INGEST_VERSION` bump.

### New rule-engine kind

Deliver: the kind's class in `rotation-rules/kinds/` extending `RuleKind` - or `BoundedPerCastKind` / `FillerKind` for the shared evaluators - registered in `KIND_CLASSES` (`rotation-rules/rule-kinds.ts`; the mapped type will not compile with one missing), per-instance `occurrences` on the finding, boundary-paired specs. The kind must also be declared in the rulebook schema (`.claude/skills/warcraft-rulebook/rulebook.schema.json`) - bump `INGEST_VERSION`.

### New vertical slice

Follow the Burst slice (`features/raid-analysis/burst-windows/`) as the reference. Deliver: the slice's `*TransformService` + `*DataSource` token pair in `data-access/`, its `*FeatureService` in `facade/`, the feature component in `components/`, slice-local math in `domain/`, wired into the ingest orchestrator and the page shell, its tailored bench file, specs at both altitudes. Bump `INGEST_VERSION`.

### New page or shared component

Deliver: the shell (zero domain services) or leaf (inputs/outputs only), copy per **warcraft-writing**, specs per the testing rules below, and - for a page - an e2e card test per the e2e rules below.

## Architecture rules (hard)

- **Exactly two pass-through API services at runtime** - `WclApiService` and `DataFileApiService`. Bytes in, typed bytes out.
- **Services are self-contained**: inject only the two API services (or the slice `*DataSource` token), domain services, and `LoggerService`; import models. A facade owns its slice-local math as protected methods or delegates to the slice's `domain/` service. The method shape itself is eslint-enforced (`no-function-alias-members` plus the exported-function ban, whose `ignores` list the sanctioned exceptions).
- **`*DataSource` interface + `*_DATA_SOURCE` InjectionToken** - the only swap point between production (`*DataFileService`) and development/ingest (`*TransformService`).
- **`*FeatureService`** - the runtime shell, one per feature component, in the slice's `facade/`. Injects its token + the cached `WclApiService` + domain services, exposes signals; its public members are the component's surface.
- **Feature components inject their `*FeatureService`** plus shared UI services (`LoadResourceService`, `FindingRowsService`) - never a domain service.
- **Page shells - zero domain services.** Resolve selection, compose feature components, pass selection as inputs.
- **Presentational leaves - inputs/outputs only**, no services beyond framework tokens.

## UI rules (hard)

- **Styling is Angular Material + Tailwind utilities over `frontend/src/styles.scss`** - the one stylesheet, holding the design tokens and the `badge-*` / `fill-*` / `icon-*` / `chip-onplan` classes.
- **Templates and `styles.scss` reach a color through a token** - a Tailwind arbitrary value (`text-[var(--success)]`) or a `badge-*` class.
- **`computed()` exposes semantic state only**; the template maps that state to a class.
- **All formatting goes through Angular pipes** (`FormatDurationPipe`, `FormatDamagePipe`, `DecimalPipe`, `FormatSpecPipe`).
- **A rule finding's drill-down is `wl-finding-occurrences`** (`shared/components/finding-table/`): populate `occurrences` on the finding and the UI work is done.

## Failure-handling rules (hard)

- Every fallible load returns `Result<T, LoadError>` - never `T | null`, never an escaping throw.
- The error channel is the three-variant `LoadError` union: `missing` (404, not an error), `transient` (network/5xx, retried once by the interceptor), `permanent` (200 but semantically unusable, carries an `id` and is `logWarn`ed).
- `try/catch` lives only in the imperative shell; the catch `logWarn`s then returns `toLoadError(cause, id)` (`core/http/http-load-error.ts`).
- Pure core functions signal failure with `missing(...)` / `permanent(...)`, never by throwing.
- Components apply the `Result`, keep one `available` signal (`= result.ok`) and one `error` signal (null for `missing`), and render content or one `wl-load-state`.

## Testing rules (hard)

- **Altitude rule:** test behavior exhaustively at the lowest altitude that owns it. A composite gets exactly one composition test; never re-test shared helpers from slice specs. A service under test is resolved with `TestBed.inject`; protected members are read through the bracket-access loophole.
- **Named constants, never magic numbers or raw ids.** Spell/item ids come from `src/testing/spell-ids.ts`; every computed value gets a named `const` with a one-line derivation.
- **Boundary comparisons are strict** and tested as such: a value exactly at `mean + 2*stddev` is not an outlier - pair the cases.
- **Never load a WCL JSON blob** - build minimal event streams from the factories in `src/testing/builders/events.ts`.
- **Bench fixtures are local to each slice spec**: a small `bench(over: Partial<RotationBench>)` factory that defaults every field and spreads overrides.
- **Presentational leaves:** read `computed()` signals via `mountVm` (`src/testing/component-harness.ts`) - no DOM assertions.
- **Feature components are thin** - their logic is covered by the service spec, not by mounting them.

## E2E rules (for page changes)

- **One WCL analysis per run** - the suite runs in `mode: 'serial'` over one shared `page`, `retries: 0`.
- **Production configuration only** - `playwright.config.ts` serves the production build so slices read ingested files.
- **Static copy exact, computed values by shape or existence** - never pin a number, name, or timestamp that comes from the log or bench.
- **One happy-path test per use-case card**, located by its `wl-*` tag.

## Self-review checklist

Before committing, verify:

- [ ] Every new behavior has a spec at the lowest altitude that owns it
- [ ] Each "triggers" case is paired with a "does not trigger at the boundary" case
- [ ] `INGEST_VERSION` bumped exactly when what ingestion bakes changes: bench shape, measured values, or a republished rulebook
- [ ] Every finding populates `occurrences` (or explains why not)
- [ ] All copy passes the terse-analyst voice rules in **warcraft-writing**
- [ ] `npm test`, `npm run lint`, and `npm run build` pass
- [ ] Templates reach every color through a token, and all formatting goes through pipes
- [ ] Every fallible load returns `Result<T, LoadError>` and renders one `wl-load-state`
- [ ] Every comment the diff adds passes the CLAUDE.md gate, audited one by one: it names the concrete mistake a reader makes without it, in one line - summaries, narration, restated code, and fixture descriptions are deleted, not kept

## Verification

```bash
cd frontend
npm test
npm run lint
npm run build
```

E2e spends one WCL analysis per run - run `npm run e2e` only when the change touches a rendered page, and read the e2e rules above first.
