import { describe, it, expect } from 'vitest';
import { analyzeDamageTaken } from './damage-taken';
import { Events } from '../../../testing/builders/events';

describe('analyzeDamageTaken', () => {
  it('aggregates amount + absorbed per ability, sorted by total, with name + share', () => {
    const dt = Events.start()
      .damageTaken(101, '0:05', 600, { absorbed: 400 }) // 1000 total
      .damageTaken(202, '0:06', 250)
      .damageTaken(101, '0:07', 250)
      .build();

    const { top, total } = analyzeDamageTaken(dt, { '101': { name: 'Cleave' }, '202': { name: 'Stomp' } });

    expect(total).toBe(1500);
    expect(top[0]).toEqual({ spell_id: 101, name: 'Cleave', damage: 1250, pct: 0.833 });
    expect(top[1]).toEqual({ spell_id: 202, name: 'Stomp', damage: 250, pct: 0.167 });
  });

  it('keeps at most the top 10 abilities', () => {
    let dt = Events.start();
    for (let i = 0; i < 15; i++) dt = dt.damageTaken(500 + i, '0:05', (i + 1) * 10);

    const { top } = analyzeDamageTaken(dt.build(), {});

    expect(top).toHaveLength(10);
  });

  it('ignores zero-damage events', () => {
    const dt = Events.start().damageTaken(101, '0:05', 0).build();

    expect(analyzeDamageTaken(dt, {}).total).toBe(0);
  });
});
