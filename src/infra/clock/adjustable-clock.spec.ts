import { describe, expect, it } from 'vitest';
import { AdjustableClock } from './adjustable-clock';

describe('AdjustableClock', () => {
  it('follows the wall clock and reports itself as uncontrolled', () => {
    const clock = new AdjustableClock();

    const now = clock.now();

    expect(Math.abs(now.getTime() - Date.now())).toBeLessThan(1_000);
    expect(clock.controlled).toBe(false);
    expect(clock.state()).toMatchObject({ pinnedAt: null, offsetMs: 0 });
  });

  it('freezes at a pinned instant', () => {
    const clock = new AdjustableClock();
    clock.pin(new Date('2027-01-01T00:00:00.000Z'));

    const state = clock.state();

    expect(state.now.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(state.pinnedAt?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(state.offsetMs).toBe(0);
    expect(state.controlled).toBe(true);
    // The wall clock is still reported alongside, so drift is visible.
    expect(Math.abs(state.realNow.getTime() - Date.now())).toBeLessThan(1_000);
  });

  it('shifts a running clock and keeps ticking', () => {
    const clock = new AdjustableClock();
    clock.setOffset(7 * 24 * 60 * 60 * 1000);

    const state = clock.state();

    expect(state.pinnedAt).toBeNull();
    expect(state.offsetMs).toBe(604_800_000);
    expect(state.now.getTime() - state.realNow.getTime()).toBeCloseTo(
      604_800_000,
      -3,
    );
  });

  it('advances from a pin and from an offset', () => {
    const pinned = new AdjustableClock();
    pinned.pin(new Date('2027-01-01T00:00:00.000Z'));
    pinned.advance(60_000);
    expect(pinned.state().now.toISOString()).toBe('2027-01-01T00:01:00.000Z');

    const shifted = new AdjustableClock();
    shifted.setOffset(1_000);
    shifted.advance(2_000);
    expect(shifted.state().offsetMs).toBe(3_000);
  });

  it('returning to the wall clock clears both modes', () => {
    const clock = new AdjustableClock();
    clock.pin(new Date('2030-06-01T00:00:00.000Z'));
    clock.advance(1_000);

    clock.reset();

    expect(clock.controlled).toBe(false);
    expect(clock.state()).toMatchObject({ pinnedAt: null, offsetMs: 0 });
    expect(Math.abs(clock.now().getTime() - Date.now())).toBeLessThan(1_000);
  });

  it('hands out copies so callers cannot move the clock', () => {
    const clock = new AdjustableClock();
    clock.pin(new Date('2027-01-01T00:00:00.000Z'));

    clock.now().setUTCFullYear(2035);
    clock.state().now.setUTCFullYear(2035);

    expect(clock.state().now.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});
