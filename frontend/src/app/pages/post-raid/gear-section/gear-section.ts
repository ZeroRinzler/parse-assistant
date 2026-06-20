import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { CharacterGear } from '../../../core/models/wcl.models';
import { EncounterGearStats } from '../../../core/models/encounter.models';
import { GameIconComponent } from '../../../shared/components/game-icon/game-icon';
import {
  GearStatus, slotName, statusIcon, statusClass,
  buildEnchantRows, enchantStatusOf, EnchantRow,
  buildTalentBuilds, talentStatusOf, TalentBuildRow,
  buildGemCheck, GemCheck,
  buildBenchEnchantRows, BenchEnchantRow,
  buildBenchTrinketRows, BenchTrinketRow,
} from '../../../shared/gear/gear-comparison';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-gear-section',
  imports: [MatCardModule, MatChipsModule, MatIconModule, GameIconComponent],
  templateUrl: './gear-section.html',
})
export class GearSectionComponent {
  readonly playerGear = input<CharacterGear | null>(null);
  readonly topGear = input<EncounterGearStats | null>(null);

  protected readonly enchantRows = computed<EnchantRow[]>(() =>
    buildEnchantRows(this.playerGear(), this.topGear()));
  protected readonly enchantStatus = computed<GearStatus>(() =>
    enchantStatusOf(this.enchantRows()));
  protected readonly talentBuilds = computed<TalentBuildRow[]>(() =>
    buildTalentBuilds(this.topGear(), this.playerGear()?.talent_key ?? ''));
  protected readonly talentStatus = computed(() =>
    talentStatusOf(this.topGear(), this.playerGear()?.talent_key ?? ''));
  protected readonly gemCheck = computed<GemCheck | null>(() =>
    buildGemCheck(this.topGear(), this.playerGear()?.gem_count));

  // Bench-only display used when playerGear has not yet loaded.
  protected readonly benchEnchantRows = computed<BenchEnchantRow[]>(() =>
    buildBenchEnchantRows(this.topGear()));
  protected readonly benchTrinketRows = computed<BenchTrinketRow[]>(() =>
    buildBenchTrinketRows(this.topGear()));

  protected readonly slotName = slotName;
  protected readonly statusIcon = statusIcon;
  protected readonly statusClass = statusClass;
}
