import { MAX_BUDGET_SATS } from './constants.js';

const CANONICAL_SATS = /^(0|[1-9][0-9]{0,15})$/;

export function isCanonicalSats(text: string): boolean {
  return CANONICAL_SATS.test(text);
}

export function parseSats(text: string): bigint | null {
  return isCanonicalSats(text) ? BigInt(text) : null;
}

export function isValidBudget(text: string): boolean {
  const value = parseSats(text);
  return value !== null && value <= MAX_BUDGET_SATS;
}

export function satsEnabled(budget: string): boolean {
  return parseSats(budget) !== 0n;
}

export function sumSats(amounts: readonly string[]): bigint {
  return amounts.reduce((total, amount) => total + (parseSats(amount) ?? 0n), 0n);
}
