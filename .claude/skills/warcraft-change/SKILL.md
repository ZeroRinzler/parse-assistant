---
name: warcraft-change
description: warcraft-learner change contract - what a code change must deliver, end to end. Covers the four change kinds (finding, rule kind, slice, page), the universal checklist (slice math, bench shape, failure handling, UI, copy, specs), the self-review checklist, and the verification commands. Load this before writing, changing, or reviewing any code under frontend/src.
---

# warcraft-learner change

**What good looks like:** a change is playable end to end - the analysis computes it, ingestion bakes it, the page renders it, the copy coaches it, and a spec pins it. Testing is not a phase; it is part of the deliverable.

**Deliverable:** the checklist below holds for your diff, the self-review checklist passes, and `npm test` + `npm run lint` + `npm run build` pass.

## Universal checklist

Every change delivers some subset of:

1. **Slice math** - named, pure, total functions colocated in the slice's own `*.service.ts` (or its slice-local module). No Angular, `inject()`, or IO in the pure layer.
2. **Bench shape** - if the change alters what ingestion must bake, update the slice's `*Bench` interface in its `*-data-source.ts` and bump `INGEST_VERSION` (`src/app/ingest/ingest-version.ts`).
3. **Failure handling** - every fallible load returns `Result<T, LoadError>`; the four render states (content / waiting / transient error / permanent error). No silent swallow.
4. **UI** - template owns styling, formatting goes through pipes, drill-down uses `wl-finding-occurrences`. No hardcoded colors.
5. **Copy** - message + remedy in the terse analyst voice. Governing skill: **warcraft-writing**.
6. **Specs** - pure math tested at the lowest altitude, services end-to-end through fakes. Each "triggers" case paired with a "does not trigger at the boundary" case.
7. **WCL reads** - a new event stream or gear/talent/position field means checking the quirks table first. Governing skill: **warcraft-wcl-data**.

## Change kinds

### New finding on an existing slice

Deliver: the pure check in the slice's colocated functions, a `FindingOccurrence`-populated result, message + remedy copy, boundary-paired specs. No bench change means no `INGEST_VERSION` bump.

### New rule-engine kind

Deliver: the kind's block in `RULE_KINDS` (`rotation-rules.ts` - streams, measure, evaluator, applicability, label; the mapped type will not compile with one missing), per-instance `occurrences` on the finding (extend `evaluateBoundedPerCast` or `fillerOccurrences` before writing a bespoke builder), boundary-paired specs. The kind must also be declared in the rulebook schema (`.claude/skills/warcraft-rulebook/rulebook.schema.json`) - bump `INGEST_VERSION`.

### New vertical slice

Follow the Burst slice (`pages/post-raid/burst-windows/`) as the reference. Deliver: the slice's `*TransformService` + `*DataSource` token pair + `*FeatureService` + feature component, wired into the ingest orchestrator and the page shell, its tailored bench file, specs at both altitudes. Bump `INGEST_VERSION`.

### New page or shared component

Deliver: the shell (zero domain services) or leaf (inputs/outputs only), copy per **warcraft-writing**, specs per the testing rules below, and - for a page - an e2e card test per the e2e rules below.

## Architecture rules (hard)

- **Exactly two pass-through API services at runtime** - `WclApiService` and `DataFileApiService`. Bytes in, typed bytes out.
- **Services are self-contained**: import only the two API services (or the slice `*DataSource` token) + models + `logWarn`. Each service owns its math as named, pure, total functions colocated in its own `*.service.ts`.
- **`*DataSource` interface + `*_DATA_SOURCE` InjectionToken** - the only swap point between production (`*DataFileService`) and development/ingest (`*TransformService`).
- **`*FeatureService`** - the runtime shell, one per feature component. Injects its token + the cached `WclApiService`, calls colocated pure functions, exposes signals. No arithmetic.
- **Feature components inject exactly one service**: their `*FeatureService`.
- **Page shells - zero domain services.** Resolve selection, compose feature components, pass selection as inputs.
- **Presentational leaves - inputs/outputs only**, no services beyond framework tokens.

## UI rules (hard)

- **Styling: Angular Material + Tailwind utilities only; zero per-component style files.** The one stylesheet is `frontend/src/styles.scss` (design tokens, `badge-*` / `fill-*` / `seg-*` / `icon-*` / `chip-onplan` classes).
- **No hardcoded colors anywhere** - only `styles.scss` tokens via Tailwind arbitrary values (`text-[var(--success)]`) or `badge-*` classes.
- **Component TS never produces CSS classes or style strings**; the template owns all styling. `computed()` exposes semantic state only.
- **All formatting goes through Angular pipes** (`FormatDurationPipe`, `FormatDamagePipe`, `DecimalPipe`, `FormatSpecPipe`).
- **A rule finding's drill-down is `wl-finding-occurrences`** (`shared/components/finding-table/`): populate `occurrences` on the finding and the UI work is done.
- **External `templateUrl` for anything beyond trivial markup** (roughly <10 lines inline).

## Failure-handling rules (hard)

- Every fallible load returns `Result<T, LoadError>` - never `T | null`, never an escaping throw.
- The error channel is the three-variant `LoadError` union: `missing` (404, not an error), `transient` (network/5xx, retried once by the interceptor), `permanent` (200 but semantically unusable, carries an `id` and is `logWarn`ed).
- `try/catch` lives only in the imperative shell; the catch `logWarn`s then returns `toLoadError(cause, id)` (`core/http-load-error.ts`).
- Pure core functions signal failure with `missing(...)` / `permanent(...)`, never by throwing.
- Components apply the `Result`, keep one `available` signal (`= result.ok`) and one `error` signal (null for `missing`), and render content or one `wl-load-state`.

## Testing rules (hard)

- **Altitude rule:** test behavior exhaustively at the lowest altitude that owns it. A composite gets exactly one composition test; never re-test shared helpers from slice specs.
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
- [ ] No hardcoded colors, no CSS classes in component TS, all formatting through pipes
- [ ] Every fallible load returns `Result<T, LoadError>` and renders one `wl-load-state`

## Verification

```bash
cd frontend
npm test
npm run lint
npm run build
```

E2e spends one WCL analysis per run - run `npm run e2e` only when the change touches a rendered page, and read the e2e rules above first.
