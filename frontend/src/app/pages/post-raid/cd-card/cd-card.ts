import { Component, computed, input, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { AnalysisFinding } from '../../../core/models/analysis.models';
import { SpellIconComponent } from '../../../shared/components/spell-icon/spell-icon';

interface CdBucket { issues: AnalysisFinding[]; holds: AnalysisFinding[]; success?: AnalysisFinding; }

const SEVERITY_ORDER = ['critical', 'warning', 'info', 'success'];
const CAT_LABEL: Record<string, string> = {
  lost_cooldown: 'lost cast',
  cooldown_delay: 'held',
  cooldown_alignment: 'BL miss',
  cast_efficiency: 'downtime',
  hold_suggestion: 'hold tip',
};

@Component({
  selector: 'wl-cd-card',
  imports: [MatIconModule, SpellIconComponent],
  templateUrl: './cd-card.html',
  styleUrl: './cd-card.scss',
})
export class CdCardComponent {
  readonly name = input.required<string>();
  readonly bucket = input.required<CdBucket>();
  readonly spellId = input<number | null>(null);

  protected readonly expanded = signal(true);

  protected readonly hasCritical = computed(() => this.bucket().issues.some(f => f.severity === 'critical'));
  protected readonly hasIssue = computed(() => this.bucket().issues.length > 0 || this.bucket().holds.length > 0);

  protected readonly metaItems = computed(() => {
    const items: string[] = [];
    for (const f of this.bucket().issues) {
      const lbl = CAT_LABEL[f.category];
      if (lbl) items.push(lbl);
    }
    if (this.bucket().holds.length) items.push(`${this.bucket().holds.length} hold tip${this.bucket().holds.length > 1 ? 's' : ''}`);
    return items;
  });

  protected readonly allFindings = computed(() => [...this.bucket().issues, ...this.bucket().holds]);

  protected toggleExpanded(): void {
    if (this.hasIssue()) this.expanded.update(v => !v);
  }

  protected formatMs(ms: number | undefined): string {
    if (ms == null) return '';
    const s = ms / 1000;
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }
}
