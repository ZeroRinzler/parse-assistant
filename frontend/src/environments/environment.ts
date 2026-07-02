/**
 * Production environment (default).
 *
 * `useLiveTransform: false` binds every `*_DATA_SOURCE` token to a generic
 * `FileDataSource` (reads the ingested, tailored static file). The dev override
 * lives in `environment.development.ts` and is swapped in by the `development`
 * build configuration's `fileReplacements` (see angular.json).
 *
 * `dataBaseHref` controls where the static `data/specs/` files are fetched from.
 * Empty string (prod/dev) resolves `data/specs/` relative to `document.baseURI`, so
 * each deploy folder reads its own copy. The `preview` build overrides it with an
 * absolute path so PR previews reuse the single shared prod-root copy instead of
 * shipping their own (see `environment.preview.ts`).
 */
export const environment = {
  /** When true, slices compute their prepared data live in the browser instead of
   * reading ingested files - lets the whole app run with no ingestion. */
  useLiveTransform: false,
  /** Absolute base for the static data files, or empty to resolve relative to
   * `document.baseURI`. Empty (prod/dev) keeps the per-folder relative behavior. */
  dataBaseHref: '',
};
