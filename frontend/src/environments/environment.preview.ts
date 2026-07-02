/**
 * PR preview environment (swapped in by the `preview` build configuration, layered
 * on top of `production` - see angular.json).
 *
 * Same runtime shape as production (`useLiveTransform: false`, reads ingested files),
 * but `dataBaseHref` points at the single shared prod copy of the data at the gh-pages
 * site root. Every PR preview lives under `/warcraft-learner/pr-N/`, and the data
 * (~400 MB) is byte-for-byte identical across prod and all previews. Rather than ship a
 * duplicate copy into each `pr-N/` folder, previews fetch the one canonical prod-root
 * copy at `/warcraft-learner/data/specs/` that `deploy-pages` always ships. The preview
 * folder then carries only the app shell.
 */
export const environment = {
  useLiveTransform: false,
  dataBaseHref: '/warcraft-learner/data/specs/',
};
