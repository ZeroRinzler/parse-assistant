import { describe, it, expect } from 'vitest';
import { RotationBloodlustService } from './rotation-bloodlust-service';
import { BLOODLUST } from '../../../../../testing/spell-ids';
import { applyBuff, removeBuff } from '../../../../../testing/builders/events';
import { WclProjectionsService } from '../../../../domain/analysis/wcl-projections-service';
import { TestBed } from '@angular/core/testing';

const bloodlust = TestBed.inject(RotationBloodlustService);
const wclProjections = TestBed.inject(WclProjectionsService);

/** Fixture events build against a fight-start of 0, so stamping is a pass-through to seconds. */
const timed: WclProjectionsService['withRelativeS'] = (events, startMs) => wclProjections.withRelativeS(events, startMs);

describe('detectBloodlust', () => {
  it('detects a Bloodlust applied before the pull (negative atS)', () => {
    // WCL's fight start is the first damage event, so a pre-cast Lust lands at a negative atS.
    const PRE_PULL_BL_S = -2;
    expect(bloodlust.detectBloodlust(timed([applyBuff(BLOODLUST, PRE_PULL_BL_S)], 0))).toBe(PRE_PULL_BL_S);
  });

  it('detects a Bloodlust applied exactly at the fight start (boundary)', () => {
    const FIGHT_START_S = 0;
    expect(bloodlust.detectBloodlust(timed([applyBuff(BLOODLUST, FIGHT_START_S)], 0))).toBe(FIGHT_START_S);
  });

  it('detects a Bloodlust well inside the fight (regression guard)', () => {
    const MID_FIGHT_BL_S = 30;
    expect(bloodlust.detectBloodlust(timed([applyBuff(999, 5), applyBuff(BLOODLUST, MID_FIGHT_BL_S)], 0))).toBe(MID_FIGHT_BL_S);
  });

  it('returns null when no BL buff present', () => {
    expect(bloodlust.detectBloodlust(timed([applyBuff(999, 5)], 0))).toBeNull();
  });

  it('detects a Bloodlust whose only trace is a bare remove, back-filled to fight start', () => {
    const REMOVE_S = 40;
    expect(bloodlust.detectBloodlust(timed([removeBuff(BLOODLUST, REMOVE_S)], 0))).toBe(0);
  });
});
