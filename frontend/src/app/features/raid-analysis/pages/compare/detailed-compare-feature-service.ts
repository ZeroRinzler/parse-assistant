import { Injectable, inject, signal } from '@angular/core';
import { WclApiService } from '../../../../core/wcl/wcl-api-service';
import { PlayerDetailGroups } from '../../../../core/wcl/wcl.models';
import { LoggerService } from '../../../../core/observability/logger-service';
import { Result } from '../../../../core/http/result';
import { BenchParse } from '../../../../domain/analysis/bench-pipeline-service';
import { WclProjectionsService } from '../../../../domain/analysis/wcl-projections-service';
import { BuffPresenceService, PotionUse, WindowBuffPresence } from '../../../../domain/analysis/buff-presence-service';
import { RotationTransformService } from '../../rotation/data-access/rotation-transform-service';
import { RotationBench } from '../../rotation/data-access/rotation-data-source';
import { BurstTransformService } from '../../burst-windows/data-access/burst-transform-service';
import { BurstBench } from '../../burst-windows/data-access/burst-data-source';
import { DefensiveTransformService } from '../../defensive/data-access/defensive-transform-service';
import { DefensiveBench } from '../../defensive/data-access/defensive-data-source';
import { GearTransformService } from '../../gear/data-access/gear-transform-service';
import { GearBench } from '../../../../domain/gear/gear-bench';
import { LogDiffFeatureService } from '../../log-diff/facade/log-diff-feature-service';
import { SideState } from '../../log-diff/domain/log-diff.models';

/** Resolved once per `loadDetailed()`: side A's own selection, used as the "you" pull for every card. */
interface DetailTarget {
  spec: string;
  encounterId: number;
  benchParseFromB: BenchParse;
}

// Page-local (not a slice service): it composes rotation/burst/defensive/gear, which the slice boundary rules forbid a slice from doing itself.
@Injectable({ providedIn: 'root' })
export class DetailedCompareFeatureService {
  private readonly logger = inject(LoggerService);
  private readonly wclApi = inject(WclApiService);
  private readonly wclProjections = inject(WclProjectionsService);
  private readonly buffPresence = inject(BuffPresenceService);
  private readonly logDiff = inject(LogDiffFeatureService);

  private readonly rotationTransform = inject(RotationTransformService);
  private readonly burstTransform = inject(BurstTransformService);
  private readonly defensiveTransform = inject(DefensiveTransformService);
  private readonly gearTransform = inject(GearTransformService);

  readonly loading = signal(false);
  /** True once a load has been attempted, so the UI can tell "not requested yet" apart from "requested, different specs". */
  readonly attempted = signal(false);
  readonly sameSpec = signal(false);
  /** Side A's resolved spec, e.g. "SubtletyRogue" - what the compare cards mount as "you". */
  readonly specA = signal('');

  // Each card component resolves its own view from this bench (LoadResourceService) - this service's job stops at the bench.
  readonly rotationBench = signal<Result<RotationBench> | null>(null);
  readonly burstBench = signal<Result<BurstBench> | null>(null);
  readonly defensiveBench = signal<Result<DefensiveBench> | null>(null);
  readonly gearBench = signal<Result<GearBench> | null>(null);
  /** The peer's per-window buff/consumable presence, index-aligned with `burstBench`'s windows; null until that bench resolves ok. */
  readonly burstPeerBuffs = signal<WindowBuffPresence[] | null>(null);
  /** The peer's own combat potions, for the rotation card's "Combat potions" timeline; null until resolved. */
  readonly rotationPeerPotions = signal<PotionUse[] | null>(null);

  async loadDetailed(): Promise<void> {
    this.loading.set(true);
    this.attempted.set(true);
    this.clearResults();
    try {
      const a = this.logDiff.sideA();
      const b = this.logDiff.sideB();
      const [specA, specB] = await Promise.all([this.resolveSpec(a), this.resolveSpec(b)]);
      this.specA.set(specA);
      const same = !!specA && specA === specB;
      this.sameSpec.set(same);
      if (!same) return;

      const target = this.detailTarget(specA, a, b);
      if (!target) return;
      await Promise.all([
        this.loadRotationBench(target), this.loadBurstBench(target), this.loadDefensiveBench(target), this.loadGearBench(target),
        this.loadRotationPeerPotions(target),
      ]);
    } finally {
      this.loading.set(false);
    }
  }

  private clearResults(): void {
    this.sameSpec.set(false);
    this.specA.set('');
    this.rotationBench.set(null);
    this.burstBench.set(null);
    this.defensiveBench.set(null);
    this.gearBench.set(null);
    this.burstPeerBuffs.set(null);
    this.rotationPeerPotions.set(null);
  }

  private detailTarget(spec: string, a: SideState, b: SideState): DetailTarget | null {
    const fightA = a.fights.find(f => f.id === a.selectedFightId);
    const benchParseFromB = this.benchParseFor(b);
    if (!fightA || !benchParseFromB) return null;
    return { spec, encounterId: fightA.encounterID, benchParseFromB };
  }

  private async loadRotationBench(target: DetailTarget): Promise<void> {
    this.rotationBench.set(await this.rotationTransform.getBenchFromParse(target.spec, target.encounterId, target.benchParseFromB));
  }

  // Log B's own potion casts, fetched straight from its Buffs stream - the rotation card's bench comparison never carries raw events.
  private async loadRotationPeerPotions(target: DetailTarget): Promise<void> {
    this.rotationPeerPotions.set(await this.peerPotions(target.benchParseFromB));
  }

  protected async peerPotions(peer: BenchParse): Promise<PotionUse[] | null> {
    try {
      const { report, fight, player } = peer;
      const abilityNames = new Map<number, string>();
      for (const ability of report.masterData?.abilities ?? []) abilityNames.set(ability.gameID, ability.name);
      const buffs = await this.wclApi.getAllEvents(peer.ranking.report_code, fight.id, 'Buffs', fight.startTime, fight.endTime, player.id);
      return this.buffPresence.potionUses(this.wclProjections.withRelativeS(buffs, fight.startTime), player.id, abilityNames);
    } catch (cause) {
      this.logger.logWarn('DetailedCompareFeatureService.peerPotions', cause);
      return null;
    }
  }

  private async loadBurstBench(target: DetailTarget): Promise<void> {
    const bench = await this.burstTransform.getBenchFromParse(target.spec, target.encounterId, target.benchParseFromB);
    this.burstBench.set(bench);
    this.burstPeerBuffs.set(bench.ok ? await this.loadBurstPeerBuffs(target.benchParseFromB, bench.value) : null);
  }

  // The same cooldown ids for every window (recommended anywhere in the fight), so the comparison rows stay identical across windows.
  protected fightCooldownIds(bench: BurstBench): number[] {
    const ids = new Set<number>();
    for (const w of bench.windows) {
      for (const name of w.common_cds) {
        const id = bench.cd_spell_ids[name];
        if (id != null) ids.add(id);
      }
    }
    return [...ids];
  }

  // Log B's own buff presence per burst window, so the burst card can show it beside Player A's for the same windows.
  protected async loadBurstPeerBuffs(peer: BenchParse, bench: BurstBench): Promise<WindowBuffPresence[] | null> {
    try {
      const { report, fight, player } = peer;
      const abilityNames = new Map<number, string>();
      for (const ability of report.masterData?.abilities ?? []) abilityNames.set(ability.gameID, ability.name);
      const buffs = await this.wclApi.getAllEvents(peer.ranking.report_code, fight.id, 'Buffs', fight.startTime, fight.endTime, player.id);
      const cooldownIds = this.fightCooldownIds(bench);
      return this.buffPresence.windowsPresence(
        this.wclProjections.withRelativeS(buffs, fight.startTime), player.id, abilityNames,
        bench.windows.map(w => ({ startS: w.time_s, endS: w.time_s + w.window_length_s, cooldownIds })),
      );
    } catch (cause) {
      this.logger.logWarn('DetailedCompareFeatureService.loadBurstPeerBuffs', cause);
      return null;
    }
  }

  private async loadDefensiveBench(target: DetailTarget): Promise<void> {
    this.defensiveBench.set(await this.defensiveTransform.getBenchFromParse(target.spec, target.encounterId, target.benchParseFromB));
  }

  private async loadGearBench(target: DetailTarget): Promise<void> {
    this.gearBench.set(await this.gearTransform.getBenchFromParse(target.spec, target.encounterId, target.benchParseFromB));
  }

  // Mirrors the post-raid shell's own spec resolution (actor.subType is class-only since Midnight): spec comes from playerDetails.
  protected async resolveSpec(side: SideState): Promise<string> {
    if (!side.code || side.selectedFightId == null || side.selectedPlayerId == null) return '';
    try {
      const groups = await this.wclApi.getPlayerDetails(side.code, side.selectedFightId);
      return this.specOf(groups, side.selectedPlayerId);
    } catch (cause) {
      this.logger.logWarn('DetailedCompareFeatureService.resolveSpec', cause);
      return '';
    }
  }

  protected specOf(groups: PlayerDetailGroups, playerId: number): string {
    for (const role of ['dps', 'healers', 'tanks', 'unknown']) {
      for (const player of (groups[role] ?? [])) {
        if (player.id !== playerId) continue;
        const className = player.type.replace(/ /g, '');
        const spec = ((player.specs ?? [])[0]?.spec ?? '').replace(/ /g, '');
        return spec && className ? spec + className : '';
      }
    }
    return '';
  }

  // Builds a BenchParse straight from already-resolved side data (no ranking lookup - this is exactly which report/fight/player to use).
  protected benchParseFor(side: SideState): BenchParse | null {
    const report = side.report;
    const fight = report?.fights.find(f => f.id === side.selectedFightId);
    const actor = report?.masterData?.actors.find(a => a.id === side.selectedPlayerId);
    if (!report || !fight || !actor) return null;
    return {
      ranking: { player: actor.name, server: actor.server, report_code: side.code, fight_id: fight.id },
      report, fight, player: actor,
    };
  }
}
