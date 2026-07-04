/**
 * The clip anchor a feature card emits (and the page forwards) to open the recording
 * flyover on a coaching moment. This is the live slice's cross-layer boundary shape;
 * the recording machinery and its private types live in the slice
 * (`pages/post-raid/live/live-capture.service.ts`).
 */
export interface ClipAnchor {
  /** Fight-relative start of the moment, in seconds. */
  timeS: number;
  /** Window length in seconds; 0 for a point-in-time cast, which gets pre/post roll instead. */
  windowLengthS: number;
  /** Stable per-window key, so the same window resolves the same memoized clip. */
  key: string;
}
