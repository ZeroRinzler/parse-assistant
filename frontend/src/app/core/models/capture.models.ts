// The live slice's cross-layer boundary shape; the recording machinery and its private types live in `pages/post-raid/live/live-capture.service.ts`.
export interface ClipAnchor {
  timeS: number;
  /** Window length in seconds; 0 for a point-in-time cast, which gets pre/post roll instead. */
  windowLengthS: number;
  /** Stable per-window key, so the same window resolves the same memoized clip. */
  key: string;
}
