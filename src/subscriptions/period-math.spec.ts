import { describe, expect, it } from 'vitest';
import { addDays, addInterval } from './period-math';

describe('period arithmetic', () => {
  it('adds whole days without drifting across a DST boundary', () => {
    const start = new Date('2026-03-28T10:15:30.123Z');

    expect(addDays(start, 3).toISOString()).toBe('2026-03-31T10:15:30.123Z');
  });

  it('clamps to the last day of a shorter month', () => {
    const start = new Date('2026-01-31T08:00:00.000Z');

    expect(addInterval(start, 'MONTH').toISOString()).toBe(
      '2026-02-28T08:00:00.000Z',
    );
  });

  it('keeps the day of month when it exists in the target month', () => {
    const start = new Date('2026-03-15T23:59:59.999Z');

    expect(addInterval(start, 'MONTH').toISOString()).toBe(
      '2026-04-15T23:59:59.999Z',
    );
  });

  it('treats a year as twelve months and clamps a leap day', () => {
    const leapDay = new Date('2028-02-29T12:00:00.000Z');

    expect(addInterval(leapDay, 'YEAR').toISOString()).toBe(
      '2029-02-28T12:00:00.000Z',
    );
  });

  it('rolls over the year boundary', () => {
    const december = new Date('2026-12-10T00:00:00.000Z');

    expect(addInterval(december, 'MONTH').toISOString()).toBe(
      '2027-01-10T00:00:00.000Z',
    );
  });
});
