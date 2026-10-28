import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../../test/support/fake-clock';
import { SystemClock } from './system-clock';

describe('Clock', () => {
  it('reads the wall clock through a fresh instance', () => {
    const clock = new SystemClock();
    const first = clock.now();
    const second = clock.now();

    expect(first).toBeInstanceOf(Date);
    expect(first).not.toBe(second);
    expect(second.getTime()).toBeGreaterThanOrEqual(first.getTime());
  });

  it('hands out copies so a caller cannot move the clock', () => {
    const clock = new FakeClock('2026-01-01T00:00:00.000Z');

    clock.now().setUTCFullYear(2030);

    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('travels by absolute and relative amounts', () => {
    const clock = new FakeClock('2026-01-01T00:00:00.000Z');

    clock.advanceDays(30);
    expect(clock.now().toISOString()).toBe('2026-01-31T00:00:00.000Z');

    clock.advance(1);
    expect(clock.now().toISOString()).toBe('2026-01-31T00:00:00.001Z');

    clock.set('2027-03-01T12:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2027-03-01T12:00:00.000Z');
  });

  it('returns to the real instant on reset', () => {
    const clock = new FakeClock('2000-01-01T00:00:00.000Z');

    clock.reset();

    expect(clock.now().getTime()).toBeGreaterThan(
      new Date('2020-01-01T00:00:00.000Z').getTime(),
    );
  });
});
