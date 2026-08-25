import { Injectable } from '@angular/core';

const REPORT_PATH_RE = /\/reports\/([a-zA-Z0-9]+)/;
const REPORT_CODE_RE = /^[a-zA-Z0-9]{16}$/;
const FIGHT_PARAM_RE = /[#?&]fight=(\d+|last)/;
const SOURCE_PARAM_RE = /[#?&]source=(\d+)/;

export interface ParsedReportUrl {
  code: string;
  fightId: number | 'last' | null;
  sourceId: number | null;
}

@Injectable({ providedIn: 'root' })
export class WclReportUrlService {
  /** Accepts a full report URL or a bare 16-character code; null when neither parses to a usable code. */
  parse(raw: string): ParsedReportUrl | null {
    const trimmed = raw.trim();
    const pathMatch = REPORT_PATH_RE.exec(trimmed);
    const code = pathMatch?.[1] ?? trimmed;
    if (!REPORT_CODE_RE.test(code)) return null;

    const fightRaw = FIGHT_PARAM_RE.exec(trimmed)?.[1];
    const sourceRaw = SOURCE_PARAM_RE.exec(trimmed)?.[1];
    return {
      code,
      fightId: fightRaw == null ? null : fightRaw === 'last' ? 'last' : Number(fightRaw),
      sourceId: sourceRaw == null ? null : Number(sourceRaw),
    };
  }
}
