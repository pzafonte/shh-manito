import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { COPY, type Copy, type Language } from '../../apps/web/src/copy';

export const ko = COPY.ko;
export const en = COPY.en;

const ORIGIN = 'http://127.0.0.1:3210';
const SHOT_DIR = process.env.WALKTHROUGH_DIR;

export interface Phone {
  context: BrowserContext;
  page: Page;
  name: string;
  taps: number;
}

export async function setServerClock(offsetMs: number): Promise<void> {
  await fetch(`${ORIGIN}/__test/clock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ offsetMs }),
  });
}

export async function shot(page: Page, name: string): Promise<void> {
  if (!SHOT_DIR) return;
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOT_DIR, `${name}.png`), fullPage: true });
}

export async function newPhone(browser: Browser, name: string, options: Parameters<Browser['newContext']>[0] = {}): Promise<Phone> {
  const context = await browser.newContext({ baseURL: ORIGIN, ...options });
  const page = await context.newPage();
  page.on('pageerror', (error) => {
    throw new Error(`${name}: ${error.message}`);
  });
  return { context, page, name, taps: 0 };
}

export async function tap(phone: Phone, target: ReturnType<Page['getByRole']>): Promise<void> {
  phone.taps += 1;
  await target.click();
}

export interface RoundOptions {
  copy?: Copy;
}

export async function createRound(phone: Phone, options: RoundOptions = {}): Promise<string> {
  const copy = options.copy ?? ko;
  const { page } = phone;
  await page.goto('/');
  await page.getByRole('button', { name: copy.landing.start }).click();
  await page.getByLabel(copy.create.nickname).fill(phone.name);
  await page.getByRole('radio', { name: copy.stickers.rabbit }).check();
  await page.getByRole('button', { name: copy.create.submit, exact: true }).click();
  await expect(page.getByRole('heading', { name: copy.waiting.title })).toBeVisible();
  return inviteLink(page, copy);
}

export async function inviteLink(page: Page, copy: Copy = ko): Promise<string> {
  await page.getByRole('button', { name: copy.waiting.copy, exact: true }).first().click();
  return page.evaluate(() => navigator.clipboard.readText());
}

export async function joinRound(phone: Phone, link: string, sticker: keyof Copy['stickers'] = 'bear', copy: Copy = ko): Promise<void> {
  const { page } = phone;
  await page.goto(link);
  await page.getByLabel(copy.join.nickname).fill(phone.name);
  await tap(phone, page.getByRole('radio', { name: copy.stickers[sticker] }));
  await tap(phone, page.getByRole('button', { name: copy.join.submit, exact: true }));
  await expect(page.getByRole('heading', { name: copy.waiting.title })).toBeVisible();
}

export async function gather(browser: Browser, names: string[], options: RoundOptions = {}): Promise<{ phones: Phone[]; link: string }> {
  const copy = options.copy ?? ko;
  const locale = copy === en ? 'en-GB' : 'ko-KR';
  const phones = await Promise.all(names.map((name) => newPhone(browser, name, { locale })));
  const link = await createRound(phones[0]!, options);
  const stickers = ['bear', 'cat', 'dog', 'fox', 'tiger', 'panda'] as const;
  for (const [index, phone] of phones.slice(1).entries()) {
    await joinRound(phone, link, stickers[index % stickers.length], copy);
  }
  return { phones, link };
}

export async function lockAndAgree(phones: Phone[], copy: Copy = ko): Promise<void> {
  const organiser = phones[0]!.page;
  await organiser.getByRole('button', { name: copy.waiting.lock }).click();
  await expect(organiser.getByRole('button', { name: copy.check.match })).toBeVisible();
  await organiser.getByRole('button', { name: copy.check.match }).click();
}

export async function waitForGame(phone: Phone, copy: Copy = ko): Promise<void> {
  await expect(phone.page.getByRole('navigation', { name: copy.navLabel })).toBeVisible({ timeout: 45_000 });
}

export function tab(page: Page, name: string): ReturnType<Page['getByRole']> {
  return page.getByRole('navigation').getByRole('button', { name, exact: false });
}

export async function pullSlip(phone: Phone, copy: Copy = ko): Promise<void> {
  await tab(phone.page, copy.nav.draw).click();
  await phone.page.getByRole('button', { name: copy.draw.pull }).click();
  await expect(phone.page.getByRole('button', { name: copy.slip.peekLabel })).toBeVisible();
}

export async function peekName(phone: Phone, copy: Copy = ko): Promise<string> {
  const { page } = phone;
  await tab(page, copy.nav.draw).click();
  const peek = page.getByRole('button', { name: copy.slip.peekLabel });
  await peek.click();
  const name = await page.locator('.slip-name').innerText();
  await expect(page.locator('.slip-name')).toBeHidden({ timeout: 7_000 });
  return name;
}

export async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText);
}

export function languageOf(copy: Copy): Language {
  return copy === ko ? 'ko' : 'en';
}

export const INVOICE_100_SATS = `lnbc1u1p${'q'.repeat(60)}`;

// Stands in for a recipient's wallet service, which would be a third party on the
// real internet. The browser still applies its real security policy to the request.
export async function fakeWalletService(phone: Phone, requests: string[]): Promise<void> {
  await phone.context.route('https://wallet.example/**', async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    const body = url.pathname.startsWith('/.well-known/lnurlp/')
      ? { tag: 'payRequest', callback: 'https://wallet.example/pay', minSendable: 1000, maxSendable: 1_000_000_000, metadata: '[]' }
      : { pr: INVOICE_100_SATS, routes: [] };
    await route.fulfill({ json: body, headers: { 'access-control-allow-origin': '*' } });
  });
}

export const BANNED_WORDS = /\b(keys?|hash(es)?|encrypt\w*|onions?|tokens?|protocols?|mix\w*)\b|암호|해시|토큰|프로토콜|믹스|어니언|공개키|비밀키|개인키/i;

export const NON_ALLOWED_ABSOLUTES = /anonymous|untraceable|trustless|익명 보장|추적 불가/i;

export async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

interface ControlIssue {
  control: string;
  problem: string;
}

export async function controlIssues(page: Page): Promise<ControlIssue[]> {
  return page.evaluate(() => {
    const MIN_TARGET = 44;
    const issues: { control: string; problem: string }[] = [];
    const controls = [...document.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [role="button"]')];
    for (const control of controls) {
      const wrapper = control.closest('label');
      const target = control instanceof HTMLInputElement && wrapper ? wrapper : control;
      const box = target.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const labelled =
        control.getAttribute('aria-label') ||
        control.textContent?.trim() ||
        wrapper?.textContent?.trim() ||
        (control as HTMLInputElement).labels?.[0]?.textContent?.trim();
      const description = control.outerHTML.slice(0, 80);
      if (!labelled) issues.push({ control: description, problem: 'no accessible name' });
      if (box.height < MIN_TARGET || box.width < MIN_TARGET) {
        issues.push({ control: description, problem: `target ${Math.round(box.width)}x${Math.round(box.height)}` });
      }
    }
    return issues;
  });
}

// Checks one screen against every rule that applies everywhere.
export async function auditScreen(page: Page, label: string): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished),
    ).then(() => undefined),
  );
  await expectNoSidewaysScroll(page);
  expect(await controlIssues(page), label).toEqual([]);
  const text = await visibleText(page);
  expect(text, `${label}: banned word`).not.toMatch(BANNED_WORDS);
  expect(text, `${label}: absolute claim`).not.toMatch(NON_ALLOWED_ABSOLUTES);
}

export async function auditBothLanguages(page: Page, label: string): Promise<void> {
  await auditScreen(page, `${label} ko`);
  await page.getByRole('button', { name: ko.languageToggleLabel }).click();
  await auditScreen(page, `${label} en`);
  await page.getByRole('button', { name: en.languageToggleLabel }).click();
}
