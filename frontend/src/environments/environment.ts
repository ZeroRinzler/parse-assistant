/**
 * Production environment (default).
 *
 * `useLiveTransform: false` binds every `*_DATA_SOURCE` token to a generic
 * `FileDataSource` (reads the ingested, tailored static file). The dev override
 * lives in `environment.development.ts` and is swapped in by the `development`
 * build configuration's `fileReplacements` (see angular.json).
 *
 * `dataBaseHref` is the absolute base every deployed build fetches `data/specs/`
 * from. On gh-pages the data is a single shared copy at the site root
 * (`/warcraft-learner/data/specs/`), a sibling of every environment folder
 * (`main/`, `previews/pr-N/`). Because each environment lives at a different depth,
 * an absolute base keeps the fetch identical for all of them - `main` and every PR
 * preview read the one canonical copy, and no preview ships its own duplicate. The
 * `development` build overrides this with an empty string so `npm start` resolves
 * `data/specs/` relative to `document.baseURI` (it runs live-transform anyway).
 */
export const environment = {
  /** When true, slices compute their prepared data live in the browser instead of
   * reading ingested files - lets the whole app run with no ingestion. */
  useLiveTransform: false,
  /** Absolute base for the static data files. Empty (development) resolves
   * `data/specs/` relative to `document.baseURI`. */
  dataBaseHref: '/warcraft-learner/data/specs/',
};
