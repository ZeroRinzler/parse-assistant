import { Injectable, inject, signal, computed } from '@angular/core';
import * as z from '../../../../core/validation/zod-mini';
import { WclApiService } from '../../../../core/wcl/wcl-api-service';
import { WclFight, WclReport, WclTableBlob } from '../../../../core/wcl/wcl.models';
import { LoggerService } from '../../../../core/observability/logger-service';
import { JsonCodecService } from '../../../../core/validation/json-codec-service';
import { Result, Results } from '../../../../core/http/result';
import { HttpLoadErrors } from '../../../../core/http/http-load-error';
import { WclReportUrlService } from '../domain/wcl-report-url-service';
import { AbilityDiffService, AbilityTableEntry } from '../domain/ability-diff-service';
import { TargetDiffService, TargetTableEntry, TargetDiffRow } from '../domain/target-diff-service';
import { SideSelectionService } from '../domain/side-selection-service';
import { Side, SideState, ComparisonView } from '../domain/log-diff.models';

const INVALID_URL_NOTICE = 'Enter a valid Warcraft Logs report URL or 16-character report code.';
const NO_PULLS_NOTICE = 'No boss pulls found in this report.';

function emptySide(): SideState {
  return {
    code: '', title: '', report: null, fights: [], players: [],
    selectedFightId: null, selectedPlayerId: null,
    loading: false, error: null, notice: '',
  };
}

const ABILITY_TABLE_SCHEMA = z.looseObject({
  data: z.optional(z.looseObject({
    entries: z.optional(z.array(z.looseObject({
      id: z.number(),
      guid: z.optional(z.number()),
      name: z.optional(z.string()),
      total: z.number(),
    }))),
  })),
});

// The whole-pull and by-target tables key rows by actor - unlike ABILITY_TABLE_SCHEMA, `guid` there is an icon ref, not an id to read.
const ACTOR_TABLE_SCHEMA = z.looseObject({
  data: z.optional(z.looseObject({
    entries: z.optional(z.array(z.looseObject({ id: z.number(), name: z.optional(z.string()), total: z.number() }))),
  })),
});

@Injectable({ providedIn: 'root' })
export class LogDiffFeatureService {
  private readonly wclApi = inject(WclApiService);
  private readonly json = inject(JsonCodecService);
  private readonly logger = inject(LoggerService);
  private readonly urlParser = inject(WclReportUrlService);
  private readonly abilityDiff = inject(AbilityDiffService);
  private readonly targetDiff = inject(TargetDiffService);
  private readonly sideSelection = inject(SideSelectionService);

  private readonly _sideA = signal<SideState>(emptySide());
  private readonly _sideB = signal<SideState>(emptySide());
  readonly sideA = this._sideA.asReadonly();
  readonly sideB = this._sideB.asReadonly();

  readonly comparing = signal(false);
  readonly comparisonResult = signal<Result<ComparisonView> | null>(null);

  readonly comparisonValue = computed(() => {
    const result = this.comparisonResult();
    return result?.ok ? result.value : null;
  });

  // Null for a `missing` result (never produced here) or no result yet, matching LoadResourceService's own error signal.
  readonly comparisonError = computed(() => {
    const result = this.comparisonResult();
    return !result || result.ok || result.error.kind === 'missing' ? null : result.error;
  });

  readonly canCompare = computed(() => this.sideReady(this._sideA()) && this.sideReady(this._sideB()));

  // The roster narrowed to the currently selected pull's friendlyPlayers, for the player dropdown.
  readonly visibleA = computed(() => this.sideSelection.visiblePlayers(this._sideA().players, this.fightOf(this._sideA())));
  readonly visibleB = computed(() => this.sideSelection.visiblePlayers(this._sideB().players, this.fightOf(this._sideB())));

  private fightOf(s: SideState): WclFight | undefined {
    return s.fights.find(f => f.id === s.selectedFightId);
  }

  private sideSignal(side: Side) {
    return side === 'A' ? this._sideA : this._sideB;
  }

  async loadSide(side: Side, rawUrl: string): Promise<void> {
    const state = this.sideSignal(side);
    this.comparisonResult.set(null);
    const parsed = this.urlParser.parse(rawUrl);
    if (!parsed) {
      state.set({ ...emptySide(), notice: INVALID_URL_NOTICE });
      return;
    }

    state.set({ ...emptySide(), loading: true });
    try {
      const report = await this.wclApi.getReport(parsed.code);
      const fights = this.sideSelection.buildFights(report.fights);
      if (!fights.length) {
        state.set({ ...emptySide(), code: parsed.code, title: report.title, notice: NO_PULLS_NOTICE });
        return;
      }

      const players = this.sideSelection.buildPlayers(report.masterData?.actors);
      const selectedFightId = this.sideSelection.targetFightId(fights, parsed.fightId);
      const fight = fights.find(f => f.id === selectedFightId);
      const visible = this.sideSelection.visiblePlayers(players, fight);
      const selectedPlayerId = this.sideSelection.targetPlayerId(visible, parsed.sourceId);

      state.set({
        code: parsed.code, title: report.title, report, fights, players,
        selectedFightId, selectedPlayerId, loading: false, error: null, notice: '',
      });
    } catch (cause) {
      this.logger.logWarn('LogDiffFeatureService.loadSide', cause);
      const result = HttpLoadErrors.toLoadError(cause, 'log-diff.load-side');
      if (result.ok) return; // toLoadError never returns ok; this narrows the union
      state.set({
        ...emptySide(),
        error: result.error.kind === 'missing' ? null : result.error,
        notice: result.error.kind === 'missing' ? result.error.message : '',
      });
    }
  }

  selectFight(side: Side, fightId: number): void {
    this.comparisonResult.set(null);
    this.sideSignal(side).update(s => {
      const fight = s.fights.find(f => f.id === fightId);
      const visible = this.sideSelection.visiblePlayers(s.players, fight);
      return { ...s, selectedFightId: fightId, selectedPlayerId: visible[0]?.id ?? null };
    });
  }

  selectPlayer(side: Side, playerId: number): void {
    this.comparisonResult.set(null);
    this.sideSignal(side).update(s => ({ ...s, selectedPlayerId: playerId }));
  }

  protected sideReady(s: SideState): boolean {
    return !!s.code && s.selectedFightId != null && s.selectedPlayerId != null;
  }

  async compare(): Promise<void> {
    const a = this._sideA();
    const b = this._sideB();
    if (!this.sideReady(a) || !this.sideReady(b)) return;

    this.comparing.set(true);
    this.comparisonResult.set(null);
    try {
      this.comparisonResult.set(await this.buildComparison(a, b));
    } catch (cause) {
      this.logger.logWarn('LogDiffFeatureService.compare', cause);
      this.comparisonResult.set(HttpLoadErrors.toLoadError(cause, 'log-diff.compare'));
    } finally {
      this.comparing.set(false);
    }
  }

  private async buildComparison(a: SideState, b: SideState): Promise<Result<ComparisonView>> {
    const target = this.comparisonTarget(a, b);
    if (!target) return Results.permanent('Selected pull not found.', 'log-diff.compare');
    const { fightA, fightB, playerIdA, playerIdB } = target;

    const [tableA, tableB, wholeTableA, wholeTableB, targetTableA, targetTableB] = await Promise.all([
      this.wclApi.getDamageDoneTableForSource(a.code, fightA.id, playerIdA),
      this.wclApi.getDamageDoneTableForSource(b.code, fightB.id, playerIdB),
      this.wclApi.getDamageDoneTable(a.code, fightA.id),
      this.wclApi.getDamageDoneTable(b.code, fightB.id),
      this.wclApi.getDamageByTargetForSource(a.code, fightA.id, playerIdA, fightA.startTime, fightA.endTime),
      this.wclApi.getDamageByTargetForSource(b.code, fightB.id, playerIdB, fightB.startTime, fightB.endTime),
    ]);
    const entriesA = this.tableEntries(tableA);
    const entriesB = this.tableEntries(tableB);
    if (!entriesA || !entriesB) return Results.permanent('Damage table missing for one of the pulls.', 'log-diff.damage-table');
    // WCL's own per-player total, not our sum of the per-ability rows: the two can diverge (rows grouped by ability vs by actor).
    const totalDpsA = this.playerTotalDps(wholeTableA, playerIdA, this.durationS(fightA));
    const totalDpsB = this.playerTotalDps(wholeTableB, playerIdB, this.durationS(fightB));
    if (totalDpsA == null || totalDpsB == null) return Results.permanent('Damage table missing for one of the pulls.', 'log-diff.damage-table');

    const rows = this.abilityDiff.buildRows(entriesA, this.durationS(fightA), entriesB, this.durationS(fightB));
    const targetRows = this.buildTargetRows(targetTableA, a.report, targetTableB, b.report);
    return Results.ok({
      playerA: a.players.find(p => p.id === playerIdA)?.name ?? '',
      playerB: b.players.find(p => p.id === playerIdB)?.name ?? '',
      totalDpsA, totalDpsB,
      rows, targetRows,
    });
  }

  // Non-fatal by design: the by-target breakdown is supplementary, so a table WCL can't serve just leaves this block empty.
  protected buildTargetRows(
    tableA: WclTableBlob | null, reportA: WclReport | null, tableB: WclTableBlob | null, reportB: WclReport | null,
  ): TargetDiffRow[] {
    const entriesA = this.targetTableEntries(tableA, this.actorNameMap(reportA));
    const entriesB = this.targetTableEntries(tableB, this.actorNameMap(reportB));
    if (!entriesA || !entriesB) {
      this.logger.logWarn('LogDiffFeatureService.buildTargetRows', { entriesA, entriesB });
      return [];
    }
    return this.targetDiff.buildRows(entriesA, entriesB);
  }

  // null means the table was unusable; a valid table missing this player's row is a real 0 (e.g. a healer).
  protected playerTotalDps(blob: WclTableBlob | null, playerId: number, durationS: number): number | null {
    if (durationS <= 0) return 0;
    if (!blob) return null;
    const parsed = typeof blob === 'string'
      ? this.json.parseJson(ACTOR_TABLE_SCHEMA, blob, 'log-diff.playerTotalDps')
      : blob;
    const entries = parsed?.data?.entries;
    if (!Array.isArray(entries)) return null;
    return (entries.find(entry => entry.id === playerId)?.total ?? 0) / durationS;
  }

  // null means an unusable table; a valid table with no rows (a target with no damage recorded) is a real empty breakdown.
  protected targetTableEntries(blob: WclTableBlob | null, actorNames: Map<number, string>): TargetTableEntry[] | null {
    if (!blob) return null;
    const parsed = typeof blob === 'string'
      ? this.json.parseJson(ACTOR_TABLE_SCHEMA, blob, 'log-diff.targetTableEntries')
      : blob;
    const entries = parsed?.data?.entries;
    if (!Array.isArray(entries)) return null;
    // WCL's by-target rows may already carry a name; masterData.actors (already cached on the side) backs it up when they don't.
    return entries.map(entry => ({ targetId: entry.id, name: entry.name ?? actorNames.get(entry.id) ?? '', total: entry.total }));
  }

  protected actorNameMap(report: WclReport | null): Map<number, string> {
    const map = new Map<number, string>();
    for (const actor of report?.masterData?.actors ?? []) map.set(actor.id, actor.name);
    return map;
  }

  private comparisonTarget(
    a: SideState, b: SideState,
  ): { fightA: WclFight; fightB: WclFight; playerIdA: number; playerIdB: number } | null {
    const fightA = a.fights.find(f => f.id === a.selectedFightId);
    const fightB = b.fights.find(f => f.id === b.selectedFightId);
    const playerIdA = a.selectedPlayerId;
    const playerIdB = b.selectedPlayerId;
    if (!fightA || !fightB || playerIdA == null || playerIdB == null) return null;
    return { fightA, fightB, playerIdA, playerIdB };
  }

  protected durationS(fight: WclFight): number {
    return (fight.endTime - fight.startTime) / 1000;
  }

  // null means an unusable table (absent/unparseable/no entries array); a valid table can still have an empty entry list.
  protected tableEntries(blob: WclTableBlob | null): AbilityTableEntry[] | null {
    if (!blob) return null;
    const parsed = typeof blob === 'string'
      ? this.json.parseJson(ABILITY_TABLE_SCHEMA, blob, 'log-diff.tableEntries')
      : blob;
    const entries = parsed?.data?.entries;
    if (!Array.isArray(entries)) return null;
    return entries.map(entry => ({ abilityId: entry.guid ?? entry.id, name: entry.name ?? '', total: entry.total }));
  }
}
