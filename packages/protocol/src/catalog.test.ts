import { describe, expect, it } from 'vitest';
import { isPaymentDetail } from './catalog.js';

describe('payment details', () => {
  it.each(['someone@example.com', 'a.b_c-d@sub.example.co.kr', `lnbc1u1p${'q'.repeat(30)}`])('accepts %s', (detail) => {
    expect(isPaymentDetail(detail)).toBe(true);
  });

  it.each([
    'you are mean',
    'someone@localhost',
    // An address makes other players' phones send a request, so it must name a real
    // domain rather than a machine on their network.
    'someone@192.168.0.1',
    'someone@10.0.0.1',
    '../../x@example.com',
    'lno1qqqqqqqqqqqqqqqqqqqqqqqqqqqq',
  ])('refuses %s', (detail) => {
    expect(isPaymentDetail(detail)).toBe(false);
  });
});
