/**
 * Production environment (default).
 *
 * `useLiveTransform: false` binds every `*_DATA_SOURCE` token to a generic
 * `FileDataSource` (reads the ingested, tailored static file). The dev override
 * lives in `environment.development.ts` and is swapped in by the `development`
 * build configuration's `fileReplacements` (see angular.json).
 */
export const environment = {
  /** When true, slices compute their prepared data live in the browser instead of
   * reading ingested files - lets the whole app run with no ingestion. */
  useLiveTransform: false,
};
