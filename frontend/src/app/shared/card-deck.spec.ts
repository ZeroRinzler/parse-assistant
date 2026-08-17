import { describe, expect, it } from 'vitest';
import { CardDeck, CardEntry } from './card-deck';

type TestCardId = 'overview' | 'rotation' | 'gear';

// Overview has no bench, so it never counts toward benchAvailable.
const CARDS: readonly CardEntry<TestCardId>[] = [
  { id: 'overview', hasBench: false },
  { id: 'rotation', hasBench: true },
  { id: 'gear', hasBench: true },
];

function deck(availableUntilReported = false): CardDeck<TestCardId> {
  return new CardDeck(CARDS, { availableUntilReported });
}

describe('CardDeck busy', () => {
  it('starts busy before any card has reported', () => {
    expect(deck().anyBusy()).toBe(true);
  });

  it('stays busy while one card is still loading', () => {
    const cards = deck();

    cards.setBusy('overview', false);
    cards.setBusy('rotation', false);

    expect(cards.anyBusy()).toBe(true);
  });

  it('clears once every card has reported', () => {
    const cards = deck();

    for (const card of CARDS) cards.setBusy(card.id, false);

    expect(cards.anyBusy()).toBe(false);
  });

  it('goes busy again for every card on markAllBusy', () => {
    const cards = deck();
    for (const card of CARDS) cards.setBusy(card.id, false);

    cards.markAllBusy();

    expect(cards.anyBusy()).toBe(true);
  });

  it('goes busy again when one settled card reloads', () => {
    const cards = deck();
    for (const card of CARDS) cards.setBusy(card.id, false);

    cards.setBusy('gear', true);

    expect(cards.anyBusy()).toBe(true);
  });
});

describe('CardDeck benchAvailable', () => {
  it('starts unavailable when cards report their availability before they render', () => {
    expect(deck().benchAvailable()).toBe(false);
  });

  it('starts available when the page shows cards before they report', () => {
    expect(deck(true).benchAvailable()).toBe(true);
  });

  it('reports available once one benched card is', () => {
    const cards = deck();

    cards.setAvailable('rotation', true);

    expect(cards.benchAvailable()).toBe(true);
  });

  it('ignores a card that carries no bench', () => {
    const cards = deck();

    cards.setAvailable('overview', true);

    expect(cards.benchAvailable()).toBe(false);
  });

  it('reports unavailable once every benched card is', () => {
    const cards = deck(true);

    cards.setAvailable('rotation', false);
    cards.setAvailable('gear', false);

    expect(cards.benchAvailable()).toBe(false);
  });

  it('leaves availability alone when the cards go busy again', () => {
    const cards = deck();
    cards.setAvailable('rotation', true);

    cards.markAllBusy();

    expect(cards.benchAvailable()).toBe(true);
  });
});
