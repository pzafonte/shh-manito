import { describe, expect, it } from 'vitest';
import { nextMailTime, zonedTimeToInstant } from './mailtime.js';

const SEOUL = 'Asia/Seoul';
const TIMES = ['09:00', '12:00', '18:00'];

function seoul(day: number, hour: number, minute = 0): number {
  return zonedTimeToInstant(2026, 11, day, hour, minute, SEOUL);
}

describe('nextMailTime', () => {
  it('finds the next post later today', () => {
    expect(nextMailTime(seoul(3, 10), TIMES, SEOUL)).toBe(seoul(3, 12));
  });

  it('rolls over to the first post tomorrow', () => {
    expect(nextMailTime(seoul(3, 19), TIMES, SEOUL)).toBe(seoul(4, 9));
  });

  it('treats a card sent exactly at post time as next post', () => {
    expect(nextMailTime(seoul(3, 12), TIMES, SEOUL)).toBe(seoul(3, 18));
  });

  it('uses the wall clock of the round, whatever the server zone', () => {
    expect(new Date(seoul(3, 9)).toISOString()).toBe('2026-11-03T00:00:00.000Z');
  });

  it('keeps wall-clock time across a clock change', () => {
    const zone = 'America/New_York';
    const beforeChange = zonedTimeToInstant(2026, 3, 7, 19, 0, zone);
    const next = nextMailTime(beforeChange, ['09:00'], zone);
    expect(new Date(next).toISOString()).toBe('2026-03-08T13:00:00.000Z');
  });
});
