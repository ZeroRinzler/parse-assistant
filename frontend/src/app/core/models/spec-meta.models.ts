/**
 * Spec metadata for one WCL spec folder: the class/spec the folder maps to, display
 * labels, and zamimg icon stems. Derived from WCL `gameData.classes` at ingest and baked
 * to `spec-meta.json`; the runtime hydrates it from that file (see `core/spec-meta.ts`).
 */
export interface SpecMeta {
  /** Folder key, e.g. 'SubtletyRogue'. */
  spec: string;
  /** No-space class form, e.g. 'DeathKnight' (WCL className for the rankings query). */
  className: string;
  /** No-space spec form, e.g. 'BeastMastery' (WCL specName for the rankings query). */
  specName: string;
  /** Display label, e.g. 'Death Knight'. */
  classLabel: string;
  /** Display label, e.g. 'Subtlety'. */
  specLabel: string;
  /** zamimg class-icon file stem (no extension), e.g. 'class_rogue'. */
  classIcon: string;
  /** zamimg spec spell-icon file stem (no extension), e.g. 'ability_stealth'; '' when none is known. */
  specIcon: string;
}
