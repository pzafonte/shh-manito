import { CARD_IDS, STICKER_IDS } from '@shh-manito/protocol';
import { describe, expect, it } from 'vitest';
import { CHECK_WORDS, COPY, type Copy } from './copy';

const WORDS_NEEDED = 256;
const BANNED = /\b(keys?|hash(es)?|encrypt\w*|onions?|tokens?|protocols?|mix\w*)\b|암호|해시|토큰|프로토콜|믹스|어니언/i;
const ABSOLUTE_PROMISES = /\b(anonymous|untraceable|trustless)\b/i;

function allStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'function') return [String((value as (...args: unknown[]) => unknown)('X', 'Y', 'Z'))];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(allStrings);
  return [];
}

function withoutServerPage(copy: Copy): Omit<Copy, 'serverSees'> {
  const { serverSees: _serverSees, ...main } = copy;
  return main;
}

describe.each(['ko', 'en'] as const)('%s copy', (language) => {
  const copy = COPY[language];

  it('keeps technical words out of everything but the server page', () => {
    for (const line of allStrings(withoutServerPage(copy))) expect(line).not.toMatch(BANNED);
  });

  it('never promises anonymity as an absolute', () => {
    for (const line of allStrings(copy)) expect(line).not.toMatch(ABSOLUTE_PROMISES);
  });

  it('has words for every card and sticker', () => {
    for (const id of CARD_IDS) expect(copy.cards[id]).toBeTruthy();
    for (const id of STICKER_IDS) expect(copy.stickers[id]).toBeTruthy();
  });
});

describe('the four starting cards', () => {
  it('are worded as given', () => {
    expect(COPY.ko.cards.lunch).toBe('점심 꼭 챙겨 먹어요');
    expect(COPY.ko.cards.coffee).toBe('커피 한 잔 사 드릴게요');
    expect(COPY.ko.cards.welldone).toBe('오늘도 수고했어요');
    expect(COPY.ko.cards.smile).toBe('덕분에 웃었어요');
  });
});

describe('check words', () => {
  it('has one word for each value of a byte', () => {
    expect(CHECK_WORDS).toHaveLength(WORDS_NEEDED);
  });

  it('has no repeats in either language, so a match means a match', () => {
    expect(new Set(CHECK_WORDS.map(([korean]) => korean)).size).toBe(WORDS_NEEDED);
    expect(new Set(CHECK_WORDS.map(([, english]) => english)).size).toBe(WORDS_NEEDED);
  });

  it('stays clear of technical and money words, in case they appear on any screen', () => {
    const money = /bitcoin|\bsats?\b|wallet|lightning|비트코인|사토시|지갑|라이트닝/i;
    for (const pair of CHECK_WORDS) {
      for (const word of pair) {
        expect(word).not.toMatch(BANNED);
        expect(word).not.toMatch(money);
      }
    }
  });
});
