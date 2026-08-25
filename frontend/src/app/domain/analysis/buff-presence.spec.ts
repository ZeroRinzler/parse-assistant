import { describe, it, expect } from 'vitest';
import { BuffPresenceService } from './buff-presence-service';
import { WclProjectionsService, TimedEvent } from './wcl-projections-service';
import { applyBuff, removeBuff } from '../../../testing/builders/events';
import { WclEvent } from '../../core/wcl/wcl.models';
import { TestBed } from '@angular/core/testing';

const buffPresence = TestBed.inject(BuffPresenceService);
const wclProjections = TestBed.inject(WclProjectionsService);

const PLAYER_ID = 1;
const CASTER_ID = 2;
const POWER_INFUSION_ID = 10060;
const BLOODLUST_ID = 2825;
// Not a real game id: BuffPresenceService matches potions by name, never by id.
const POTION_ID = 900001;
const TRUESHOT_ID = 288613;

const timed = (events: WclEvent[]): TimedEvent[] => wclProjections.withRelativeS(events, 0);

const WINDOW = { startS: 0, endS: 20, cooldownIds: [] };

describe('windowsPresence', () => {
  it('flags a self-cast potion by name, not id', () => {
    const events = timed([applyBuff(POTION_ID, 5, { target: PLAYER_ID })]);
    const names = new Map([[POTION_ID, 'Potion of Unbridled Fury']]);
    const out = buffPresence.windowsPresence(events, PLAYER_ID, names, [WINDOW]);
    expect(out[0]).toEqual({ potion: true, powerInfusion: false, bloodlust: false, cooldowns: {} });
  });

  it('does not credit the player a potion for the same buff applied by someone else', () => {
    const events = timed([applyBuff(POTION_ID, 5, { target: PLAYER_ID, source: CASTER_ID })]);
    const names = new Map([[POTION_ID, 'Potion of Unbridled Fury']]);
    const out = buffPresence.windowsPresence(events, PLAYER_ID, names, [WINDOW]);
    expect(out[0]?.potion).toBe(false);
  });

  it('flags Power Infusion applied by another player', () => {
    const events = timed([applyBuff(POWER_INFUSION_ID, 5, { target: PLAYER_ID, source: CASTER_ID })]);
    const out = buffPresence.windowsPresence(events, PLAYER_ID, new Map(), [WINDOW]);
    expect(out[0]?.powerInfusion).toBe(true);
  });

  it('flags Bloodlust from any of its equivalent ids', () => {
    const events = timed([applyBuff(BLOODLUST_ID, 5, { target: PLAYER_ID, source: CASTER_ID })]);
    const out = buffPresence.windowsPresence(events, PLAYER_ID, new Map(), [WINDOW]);
    expect(out[0]?.bloodlust).toBe(true);
  });

  it('excludes an aura that starts exactly at the window end (exclusive boundary)', () => {
    const events = timed([applyBuff(POWER_INFUSION_ID, WINDOW.endS, { target: PLAYER_ID, source: CASTER_ID })]);
    const out = buffPresence.windowsPresence(events, PLAYER_ID, new Map(), [WINDOW]);
    expect(out[0]?.powerInfusion).toBe(false);
  });

  it('includes an aura that starts just before the window ends', () => {
    const events = timed([applyBuff(POWER_INFUSION_ID, WINDOW.endS - 1, { target: PLAYER_ID, source: CASTER_ID })]);
    const out = buffPresence.windowsPresence(events, PLAYER_ID, new Map(), [WINDOW]);
    expect(out[0]?.powerInfusion).toBe(true);
  });

  it('returns one presence entry per window, in order', () => {
    const events = timed([
      applyBuff(BLOODLUST_ID, 5, { target: PLAYER_ID, source: CASTER_ID }),
      removeBuff(BLOODLUST_ID, 15, { target: PLAYER_ID }),
    ]);
    const out = buffPresence.windowsPresence(events, PLAYER_ID, new Map(), [WINDOW, { ...WINDOW, startS: 100, endS: 120 }]);
    expect(out.map(p => p.bloodlust)).toEqual([true, false]);
  });

  it('reports the window\'s own recommended cooldowns by spell id, self-cast', () => {
    const events = timed([applyBuff(TRUESHOT_ID, 5, { target: PLAYER_ID })]);
    const out = buffPresence.windowsPresence(events, PLAYER_ID, new Map(), [{ ...WINDOW, cooldownIds: [TRUESHOT_ID] }]);
    expect(out[0]?.cooldowns).toEqual({ [TRUESHOT_ID]: true });
  });

  it('flags a requested cooldown missing when it never went up in the window', () => {
    const out = buffPresence.windowsPresence([], PLAYER_ID, new Map(), [{ ...WINDOW, cooldownIds: [TRUESHOT_ID] }]);
    expect(out[0]?.cooldowns).toEqual({ [TRUESHOT_ID]: false });
  });
});
