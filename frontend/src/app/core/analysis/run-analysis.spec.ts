import { describe, it, expect, vi } from 'vitest';
import { runAnalysis } from './run-analysis';
import { AnalysisDataSource } from './analysis-data-source';
import { AnalysisInput } from './compute-analysis';
import { WclFight } from '../models/wcl.models';

const fight = (over: Partial<WclFight> = {}): WclFight => ({
  id: 1,
  name: 'Test Boss',
  startTime: 1000,
  endTime: 301_000,
  kill: true,
  encounterID: 42,
  attempt: 1,
  duration_s: 300,
  friendlyPlayers: [10],
  ...over,
});

/** A fake data source whose returns are fully controllable per test. */
function fakeSource(over: Partial<AnalysisDataSource> = {}): AnalysisDataSource {
  return {
    getEvents: vi.fn(async () => []),
    getPlayerDetails: vi.fn(async () => ({ 10: 'SubtletyRogue', name_10: 'Stabby' })),
    getRulebook: vi.fn(async () => null),
    getBench: vi.fn(async () => null),
    ...over,
  };
}

const captureInput = () => {
  const calls: AnalysisInput[] = [];
  const compute = vi.fn(async (input: AnalysisInput) => {
    calls.push(input);
    return { player: input.playerName, spec: input.spec } as never;
  });
  return { compute, calls };
};

describe('runAnalysis', () => {
  it('fetches all four event streams and assembles them with the resolved spec', async () => {
    const src = fakeSource();
    const { compute, calls } = captureInput();

    await runAnalysis(src, compute, { reportCode: 'abc', fight: fight(), playerId: 10, masterAbilities: [] });

    expect(src.getEvents).toHaveBeenCalledTimes(4);
    expect(calls[0]).toMatchObject({ spec: 'SubtletyRogue', playerName: 'Stabby', fStart: 1000, fEnd: 301_000 });
  });

  it('throws a descriptive error when the player spec cannot be resolved', async () => {
    const src = fakeSource({ getPlayerDetails: vi.fn(async () => ({})) });
    const { compute } = captureInput();

    await expect(runAnalysis(src, compute, { reportCode: 'abc', fight: fight(), playerId: 10, masterAbilities: [] })).rejects.toThrow(
      'Could not resolve spec for player 10 in report abc.',
    );
  });

  it('skips the bench fetch when the fight has no encounterID', async () => {
    const src = fakeSource();
    const { compute } = captureInput();

    await runAnalysis(src, compute, { reportCode: 'abc', fight: fight({ encounterID: 0 }), playerId: 10, masterAbilities: [] });

    expect(src.getBench).not.toHaveBeenCalled();
    expect(src.getRulebook).toHaveBeenCalledOnce();
  });

  it('falls back to "Player N" when no name is present for the player', async () => {
    const src = fakeSource({ getPlayerDetails: vi.fn(async () => ({ 10: 'SubtletyRogue' })) });
    const { compute, calls } = captureInput();

    await runAnalysis(src, compute, { reportCode: 'abc', fight: fight(), playerId: 10, masterAbilities: [] });

    expect(calls[0].playerName).toBe('Player 10');
  });
});
