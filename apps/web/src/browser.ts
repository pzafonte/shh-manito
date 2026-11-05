import type { Language } from './copy';

const EXTERNAL_OPEN = 'kakaotalk://web/openExternal?url=';

export function isKakaoInApp(): boolean {
  return /KAKAOTALK/i.test(navigator.userAgent);
}

// Unofficial and known not to work everywhere, so it is only ever an offer next to
// instructions for doing it by hand. Encoding keeps the # inside the url parameter.
export function externalOpenUrl(url: string): string {
  return `${EXTERNAL_OPEN}${encodeURIComponent(url)}`;
}

export function phoneLanguage(): Language {
  const tag = navigator.language?.toLowerCase() ?? '';
  return tag.startsWith('en') ? 'en' : 'ko';
}

export function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function absoluteLink(fragment: string): string {
  return `${location.origin}${location.pathname}${fragment}`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // In-app browsers often have no clipboard API.
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'offscreen';
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  }
}

export async function shareText(text: string, url: string): Promise<'shared' | 'copied' | 'failed'> {
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ text, url });
      return 'shared';
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'failed';
    }
  }
  return (await copyText(`${text} ${url}`)) ? 'copied' : 'failed';
}

function icsDate(instant: number): string {
  return new Date(instant).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function icsEscape(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll(';', '\\;').replaceAll(',', '\\,').replaceAll('\n', '\\n');
}

export function downloadCalendar(title: string, start: number): void {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//shh-manito//EN',
    'BEGIN:VEVENT',
    `UID:${crypto.randomUUID()}@shh-manito`,
    `DTSTAMP:${icsDate(Date.now())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(start + 30 * 60 * 1000)}`,
    `SUMMARY:${icsEscape(title)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  const url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/calendar' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'reveal-day.ics';
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function formatTime(instant: number, language: Language): string {
  return new Intl.DateTimeFormat(language, { hour: 'numeric', minute: '2-digit' }).format(instant);
}

export function formatDayTime(instant: number, language: Language): string {
  return new Intl.DateTimeFormat(language, {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(instant);
}

export function formatSats(value: bigint | string, language: Language): string {
  return new Intl.NumberFormat(language).format(BigInt(value));
}

export function nextFridayEvening(now: Date): Date {
  const FRIDAY = 5;
  const MIN_DAYS_AHEAD = 3;
  const date = new Date(now);
  let days = (FRIDAY - date.getDay() + 7) % 7;
  if (days < MIN_DAYS_AHEAD) days += 7;
  date.setDate(date.getDate() + days);
  date.setHours(17, 0, 0, 0);
  return date;
}

export function toLocalInput(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
