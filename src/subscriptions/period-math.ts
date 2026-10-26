import type { PlanInterval } from '@prisma/client';

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const addDays = (from: Date, days: number): Date =>
  new Date(from.getTime() + days * MS_PER_DAY);

/** Month arithmetic with the end-of-month clamp (Jan 31 + 1 month = Feb 28). */
export const addInterval = (from: Date, interval: PlanInterval): Date => {
  const months = interval === 'YEAR' ? 12 : 1;
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth() + months;
  const lastDayOfTargetMonth = new Date(
    Date.UTC(year, month + 1, 0),
  ).getUTCDate();

  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(from.getUTCDate(), lastDayOfTargetMonth),
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
};
