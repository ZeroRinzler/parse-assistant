/**
 * Development environment (swapped in by the `development` build configuration).
 *
 * `useLiveTransform: true` binds every implemented `*_DATA_SOURCE` token to its
 * `*TransformService`, so each slice computes its prepared data live from WCL in the
 * browser - `npm start` runs with zero ingested files. Slower (a burst render fetches
 * the top parses + their Casts/DamageDone), dev only. Production stays on the file
 * source (`environment.ts`).
 */
export const environment = {
  useLiveTransform: true,
  /** Empty resolves `data/specs/` relative to `document.baseURI` (per-folder copy);
   * see `environment.ts` for the shared-copy override used by preview builds. */
  dataBaseHref: '',
};
