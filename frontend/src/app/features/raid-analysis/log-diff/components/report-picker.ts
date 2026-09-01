import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { WclFight, WclPlayer } from '../../../../core/wcl/wcl.models';
import { LoadState, RenderableLoadError } from '../../../../shared/components/load-state/load-state';
import { FormatDurationPipe } from '../../../../shared/pipes/format-duration-pipe';
import { ClassIconPipe } from '../../../../shared/pipes/class-icon-pipe';
import { ArtIcon } from '../../../../shared/components/art-icon/art-icon';

/** One side of the comparison: paste a report URL, then pick the pull and the player - inputs/outputs only, no injected services. */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'wl-report-picker',
  imports: [
    ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, MatIconModule,
    LoadState, FormatDurationPipe, ClassIconPipe, ArtIcon,
  ],
  templateUrl: './report-picker.html',
  host: { class: 'block' },
})
export class ReportPicker {
  readonly label = input.required<string>();
  readonly fights = input<WclFight[]>([]);
  readonly players = input<WclPlayer[]>([]);
  readonly selectedFightId = input<number | null>(null);
  readonly selectedPlayerId = input<number | null>(null);
  readonly loading = input(false);
  readonly error = input<RenderableLoadError | null>(null);
  readonly notice = input('');

  readonly urlSubmit = output<string>();
  readonly fightChange = output<number>();
  readonly playerChange = output<number>();

  protected readonly urlControl = new FormControl('', { nonNullable: true });

  protected readonly selectedPlayer = computed(() => this.players().find(p => p.id === this.selectedPlayerId()) ?? null);

  protected submit(): void {
    const value = this.urlControl.value.trim();
    if (value) this.urlSubmit.emit(value);
  }

  protected onFightChange(fightId: number): void {
    this.fightChange.emit(fightId);
  }

  protected onPlayerChange(playerId: number): void {
    this.playerChange.emit(playerId);
  }
}
