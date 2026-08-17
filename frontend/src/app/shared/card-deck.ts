import { Signal, WritableSignal, computed, signal } from '@angular/core';

/** One analysis card in a page shell's registry; `hasBench` marks the cards whose availability keeps the empty-bench banner hidden. */
export interface CardEntry<Id extends string> {
  readonly id: Id;
  readonly hasBench: boolean;
}

/** The busy/available state of a page shell's analysis cards, folded from its card registry so a new card is one registry entry. */
export class CardDeck<Id extends string> {
  private readonly busySignals: Record<Id, WritableSignal<boolean>>;
  private readonly availableSignals: Record<Id, WritableSignal<boolean>>;

  readonly anyBusy: Signal<boolean>;
  readonly benchAvailable: Signal<boolean>;

  constructor(cards: readonly CardEntry<Id>[], options: { availableUntilReported: boolean }) {
    this.busySignals = {} as Record<Id, WritableSignal<boolean>>;
    this.availableSignals = {} as Record<Id, WritableSignal<boolean>>;
    for (const card of cards) {
      this.busySignals[card.id] = signal(true);
      this.availableSignals[card.id] = signal(options.availableUntilReported);
    }
    const busy = cards.map(card => this.busySignals[card.id]);
    const bench = cards.filter(card => card.hasBench).map(card => this.availableSignals[card.id]);
    this.anyBusy = computed(() => busy.some(state => state()));
    this.benchAvailable = computed(() => bench.some(state => state()));
  }

  setBusy(id: Id, busy: boolean): void {
    this.busySignals[id].set(busy);
  }

  setAvailable(id: Id, available: boolean): void {
    this.availableSignals[id].set(available);
  }

  markAllBusy(): void {
    for (const id of Object.keys(this.busySignals) as Id[]) this.busySignals[id].set(true);
  }
}
