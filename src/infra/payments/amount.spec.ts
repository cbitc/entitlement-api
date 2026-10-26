import { describe, expect, it } from 'vitest';
import { centsToYuan, yuanToCents } from './amount';

describe('money conversion', () => {
  it('renders cents as a two-decimal yuan amount', () => {
    expect(centsToYuan(0)).toBe('0.00');
    expect(centsToYuan(5)).toBe('0.05');
    expect(centsToYuan(9900)).toBe('99.00');
    expect(centsToYuan(12345)).toBe('123.45');
  });

  it('parses yuan into integer cents without floating point drift', () => {
    expect(yuanToCents('0.00')).toBe(0);
    expect(yuanToCents('99')).toBe(9900);
    expect(yuanToCents('99.9')).toBe(9990);
    expect(yuanToCents('123.45')).toBe(12345);
  });

  it('round-trips every amount exactly', () => {
    for (const cents of [1, 7, 99, 100, 999, 9900, 299000, 123456]) {
      expect(yuanToCents(centsToYuan(cents))).toBe(cents);
    }
  });

  it('rejects malformed amounts', () => {
    expect(() => yuanToCents('12.345')).toThrow();
    expect(() => yuanToCents('abc')).toThrow();
  });
});
