const MINUTE_MS = 60_000;
const SEARCH_DAYS = 3;

export const DEFAULT_MAIL_TIMES = ['09:00', '12:00', '18:00'] as const;

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(instant: number, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

function offsetAt(instant: number, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

// Two passes settle the offset when a clock change falls between the guess and the answer.
export function zonedTimeToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const first = wall - offsetAt(wall, timeZone);
  return wall - offsetAt(first, timeZone);
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function parseMailTime(text: string): { hour: number; minute: number } {
  const [hour, minute] = text.split(':').map(Number);
  return { hour: hour!, minute: minute! };
}

export function mailTimesOnDay(dayInstant: number, mailTimes: readonly string[], timeZone: string): number[] {
  const { year, month, day } = zonedParts(dayInstant, timeZone);
  return mailTimes
    .map((text) => {
      const { hour, minute } = parseMailTime(text);
      return zonedTimeToInstant(year, month, day, hour, minute, timeZone);
    })
    .sort((left, right) => left - right);
}

export function nextMailTime(now: number, mailTimes: readonly string[], timeZone: string): number {
  for (let offset = 0; offset < SEARCH_DAYS; offset++) {
    const dayInstant = now + offset * 24 * 60 * MINUTE_MS;
    const next = mailTimesOnDay(dayInstant, mailTimes, timeZone).find((instant) => instant > now);
    if (next !== undefined) return next;
  }
  throw new Error('No mail time found');
}
