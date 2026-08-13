// Derived from WCL `gameData.classes` at ingest and baked to `spec-meta.json`; `SpecMetaService` hydrates itself from that file.
export interface SpecMeta {
  spec: string;
  /** No-space class form, e.g. 'DeathKnight' (WCL className for the rankings query). */
  className: string;
  /** No-space spec form, e.g. 'BeastMastery' (WCL specName for the rankings query). */
  specName: string;
  classLabel: string;
  specLabel: string;
  /** zamimg class-icon file stem (no extension), e.g. 'class_rogue'. */
  classIcon: string;
  /** zamimg spec spell-icon file stem (no extension), e.g. 'ability_stealth'; '' when none is known. */
  specIcon: string;
}
