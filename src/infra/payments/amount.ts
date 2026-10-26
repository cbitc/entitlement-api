/**
 * Money crosses the API boundary in integer cents, while providers speak
 * decimal yuan. Keep both conversions in one place so rounding is auditable.
 */
export const centsToYuan = (cents: number): string => {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
};

export const yuanToCents = (yuan: string): number => {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(yuan.trim());
  if (!match) {
    throw new Error(`Invalid yuan amount "${yuan}"`);
  }

  const [, sign, whole, fraction = ''] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return sign === '-' ? -cents : cents;
};
