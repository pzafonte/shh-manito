import { describe, expect, it } from 'vitest';
import { isCanonicalSats, isValidBudget, parseSats, sumSats } from './money.js';

describe('sats', () => {
  it('accepts only canonical decimal strings', () => {
    expect(isCanonicalSats('0')).toBe(true);
    expect(isCanonicalSats('21000')).toBe(true);
    for (const text of ['', '01', '-1', '1.5', '1e3', ' 1', '0x10']) expect(isCanonicalSats(text)).toBe(false);
  });

  it('parses to bigint and adds without losing precision', () => {
    expect(parseSats('9007199254740993')).toBe(9007199254740993n);
    expect(sumSats(['9007199254740993', '1'])).toBe(9007199254740994n);
  });

  it('caps the budget', () => {
    expect(isValidBudget('1000000')).toBe(true);
    expect(isValidBudget('1000001')).toBe(false);
  });
});
