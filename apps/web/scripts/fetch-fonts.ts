// Run once by hand when the fixed headings change: pnpm exec tsx apps/web/scripts/fetch-fonts.ts
//
// Downloads subsets holding only the glyphs that fixed text uses, so a Korean font
// costs tens of kilobytes rather than megabytes. The files are committed, so nothing
// third-party is ever fetched at runtime. Anything outside a subset falls back to
// the system font, which is also what nicknames use on purpose.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COPY } from '../src/copy';

const FONTS = join(dirname(fileURLToPath(import.meta.url)), '../public/fonts');
const MODERN_BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const BASE_CHARACTERS = `0123456789!?.,:;'"“”‘’()-–…⋯ ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz`;
const DISPLAY_KEY = /title|Title|submit|^start$|^send$|^save$|^share$|^lock$|^match$|^pull$|^press$|^action|^again|^gotIt$|^paid$|^restart$|^joinNew$|^ready$|^preparing$|^yourPerson$|^payOpen$|^countdown$|^thanksSend$|^detailSend$|^retry$/;

function stringsUnder(value: unknown, wanted: (key: string) => boolean, inside = false): string[] {
  if (typeof value === 'string') return inside ? [value] : [];
  if (typeof value === 'function') {
    return inside ? [String((value as (...args: unknown[]) => unknown)('', '', ''))] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item) => stringsUnder(item, wanted, inside));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => stringsUnder(item, wanted, inside || wanted(key)));
  }
  return [];
}

function characters(strings: string[]): string {
  return [...new Set([...BASE_CHARACTERS, ...strings.join('')])].sort().join('');
}

async function download(family: string, file: string, text: string): Promise<void> {
  const query = new URLSearchParams({ family, text, display: 'swap' });
  const css = await (await fetch(`https://fonts.googleapis.com/css2?${query}`, { headers: { 'user-agent': MODERN_BROWSER } })).text();
  const url = /url\((https:[^)]+)\)/.exec(css)?.[1];
  if (!url) throw new Error(`No font in response for ${family}`);
  const font = Buffer.from(await (await fetch(url)).arrayBuffer());
  writeFileSync(join(FONTS, file), font);
  console.log(`${file}: ${text.length} characters, ${font.length} bytes`);
}

const languages = Object.values(COPY);
const display = languages.flatMap((copy) => [
  copy.brand,
  ...Object.values(copy.nav),
  ...stringsUnder(copy, (key) => DISPLAY_KEY.test(key)),
]);
const hand = languages.flatMap((copy) => [
  copy.tagline,
  copy.draw.bagLabel,
  ...Object.values(copy.cards),
  ...copy.send.ideas,
]);

mkdirSync(FONTS, { recursive: true });
await download('Do Hyeon', 'do-hyeon-subset.woff2', characters(display));
await download('Gamja Flower', 'gamja-flower-subset.woff2', characters(hand));
