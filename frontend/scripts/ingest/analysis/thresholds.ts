/**
 * Aggregation thresholds (fractions of the sample / member count) shared across
 * the Transform layer. Mirrored in CLAUDE.md's "Analysis thresholds" section -
 * keep the two in sync.
 */

/** Min cluster size (fraction of samples) to surface a burst/defensive window. */
export const CLUSTER_MIN_FRAC = 0.35;

/** Min fraction of parsers holding at a cast index to emit a hold target. */
export const HOLD_TRIGGER_FRAC = 0.4;

/** "More than half the member parses" - ability inclusion and majority-hold. */
export const MEMBER_MAJORITY_FRAC = 0.5;
