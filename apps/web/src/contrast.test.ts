import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const STYLES = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8');
const WCAG_AA_TEXT = 4.5;
const PANEL_WARM = '#fff8d6';

function token(name: string): string {
  const value = new RegExp(`--${name}: (#[0-9a-f]{6});`).exec(STYLES)?.[1];
  if (!value) throw new Error(`No colour token ${name}`);
  return value;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
  const [red, green, blue] = channels.map((value) =>
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first: string, second: string): number {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((left, right) => right - left) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

describe('contrast', () => {
  const ink = ['paper', 'card', 'marker', 'pink', 'mint', 'kraft', 'tape', 'grid'];

  it.each(ink)('ink on %s meets AA', (background) => {
    expect(contrast(token('ink'), token(background))).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
  });

  it.each(['paper', 'card', 'grid'])('soft ink on %s meets AA', (background) => {
    expect(contrast(token('ink-soft'), token(background))).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
  });

  it('soft ink on a warm panel meets AA', () => {
    expect(contrast(token('ink-soft'), PANEL_WARM)).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
  });

  it.each(['night-fg', 'night-soft'])('%s on the night page meets AA', (foreground) => {
    expect(contrast(token(foreground), token('night'))).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
  });

  it('a chosen promise, light on ink, meets AA', () => {
    expect(contrast(token('card'), token('ink'))).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
  });
});
