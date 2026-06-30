/**
 * The one contract every per-use-case slice's data source satisfies: read the slice's
 * prepared, ready-to-render bench for an encounter. Two adapters cross this seam -
 * `FileDataSource<T>` (production: reads the ingest-baked tailored file) and the slice's
 * own `*TransformService` (the dev `useLiveTransform` flag / ingestion: computes it live).
 *
 * `T` is the slice's own bench shape (e.g. `RotationBench`, `BurstBench`, `MapData`). The
 * per-slice `*_DATA_SOURCE` token is typed `InjectionToken<DataSource<XBench>>`, so each
 * feature service injects a source already narrowed to its bench.
 */
export interface DataSource<T> {
  getBench(spec: string, encounterId: number): Promise<T | null>;
}
