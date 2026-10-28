import { describe, expect, it } from 'vitest';
import { AppException } from '../../common/errors/app.exception';
import { AdjustableClock } from './adjustable-clock';
import { ClockControl } from './clock-control.service';
import { SystemClock } from './system-clock';

const expectDisabled = (action: () => unknown): void => {
  try {
    action();
    throw new Error('expected the clock to be locked');
  } catch (error) {
    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).type).toBe('ClockControlDisabled');
    expect((error as AppException).status).toBe(404);
  }
};

describe('ClockControl', () => {
  it('moves the bound adjustable clock', () => {
    const adjustable = new AdjustableClock();
    const control = new ClockControl(adjustable, adjustable);

    expect(control.enabled).toBe(true);

    const pinned = control.setNow(new Date('2027-01-01T00:00:00.000Z'));
    expect(pinned).toMatchObject({ enabled: true, controlled: true });
    expect(pinned.now.toISOString()).toBe('2027-01-01T00:00:00.000Z');

    const advanced = control.advance(90_000);
    expect(advanced.now.toISOString()).toBe('2027-01-01T00:01:30.000Z');

    const shifted = control.setOffset(3_600_000);
    expect(shifted.pinnedAt).toBeNull();
    expect(shifted.offsetMs).toBe(3_600_000);

    const reset = control.reset();
    expect(reset).toMatchObject({ controlled: false, offsetMs: 0 });
  });

  it('refuses every write when control is off', () => {
    const system = new SystemClock();
    const control = new ClockControl(system, null);

    expect(control.enabled).toBe(false);
    // Reads still work, so the console can tell "off" from "on the wall clock".
    expect(control.snapshot()).toMatchObject({
      enabled: false,
      controlled: false,
      pinnedAt: null,
      offsetMs: 0,
    });

    expectDisabled(() => control.setNow(new Date('2027-01-01T00:00:00.000Z')));
    expectDisabled(() => control.setOffset(1_000));
    expectDisabled(() => control.advance(1_000));
    expectDisabled(() => control.reset());
  });
});
