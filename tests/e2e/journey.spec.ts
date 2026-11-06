import { expect, test } from '@playwright/test';
import {
  auditBothLanguages,
  fakeWalletService,
  gather,
  INVOICE_100_SATS,
  ko,
  lockAndAgree,
  peekName,
  pullSlip,
  setServerClock,
  shot,
  tab,
  tap,
  visibleText,
  waitForGame,
  type Phone,
} from './helpers';

const DAY_MS = 24 * 60 * 60 * 1000;
const NAMES = ['미나', '하루', '소라', '보미'];
const FAR_FUTURE_MS = 8 * DAY_MS;

test.beforeEach(async () => {
  await setServerClock(0);
});

async function moveTime(phones: Phone[], offsetMs: number): Promise<void> {
  await setServerClock(offsetMs);
  await Promise.all(phones.map(({ context }) => context.clock.setFixedTime(Date.now() + offsetMs)));
}

test('a full game in Korean on four phones, from creating the round through settlement', async ({ browser }) => {
  test.setTimeout(240_000);
  const { phones } = await gather(browser, NAMES);
  const [organiser] = phones;

  await shot(organiser!.page, 'journey-01-waiting');
  await expect(organiser!.page.getByText(ko.waiting.here(4))).toBeVisible();

  await organiser!.page.getByRole('button', { name: ko.waiting.lock }).click();
  const words = await Promise.all(
    phones.map(async ({ page }) => {
      await expect(page.locator('.check-words li')).toHaveCount(3);
      return page.locator('.check-words b').allInnerTexts();
    }),
  );
  await shot(organiser!.page, 'journey-02-check');
  expect(new Set(words.map((list) => list.join())).size).toBe(1);

  await organiser!.page.getByRole('button', { name: ko.check.match }).click();
  await Promise.all(phones.map((phone) => waitForGame(phone)));
  await shot(phones[1]!.page, 'journey-03-home');

  for (const phone of phones) await pullSlip(phone);

  const targets = new Map<string, string>();
  for (const phone of phones) targets.set(phone.name, await peekName(phone));

  expect(new Set(targets.values()).size).toBe(4);
  const start = NAMES[0]!;
  const seen = new Set<string>();
  let current = start;
  do {
    seen.add(current);
    expect(targets.get(current)).not.toBe(current);
    current = targets.get(current)!;
  } while (current !== start);
  expect(seen.size).toBe(4);

  for (const phone of phones) {
    const { page } = phone;
    phone.taps = 0;
    await tab(page, ko.nav.home).click();
    phone.taps = 0;
    await tap(phone, page.getByRole('button', { name: ko.home.actionSend }));
    await tap(phone, page.getByRole('radio', { name: ko.cards.coffee }));
    await tap(phone, page.getByRole('button', { name: ko.send.submit }));
    await expect(page.locator('.sent')).toContainText('보냈어요');
    expect(phone.taps).toBeLessThanOrEqual(3);
  }
  await shot(phones[0]!.page, 'journey-04-sent');

  await tab(phones[0]!.page, ko.nav.inbox).click();
  await expect(phones[0]!.page.getByText(ko.cards.coffee)).toHaveCount(0);

  await moveTime(phones, DAY_MS);
  for (const { page } of phones) {
    await tab(page, ko.nav.inbox).click();
    await expect(page.getByText(ko.cards.coffee)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(ko.inbox.promise('100'))).toBeVisible();
  }
  await shot(phones[0]!.page, 'journey-05-inbox');

  await moveTime(phones, FAR_FUTURE_MS);
  for (const { page } of phones) {
    await tab(page, ko.nav.reveal).click();
    await page.getByRole('button', { name: ko.reveal.press }).click();
  }
  await expect(phones[0]!.page.getByRole('status').filter({ hasText: ko.reveal.revealedCount(4, 4) })).toBeVisible();
  for (const { page } of phones) await expect(page.locator('.pairs li')).toHaveCount(4, { timeout: 15_000 });
  await shot(phones[0]!.page, 'journey-06-revealed');

  const giverOf = (name: string): Phone => phones.find(({ name: giver }) => targets.get(giver) === name)!;
  for (const phone of phones) {
    await expect(phone.page.getByText(ko.reveal.giver(giverOf(phone.name).name))).toBeVisible();
  }

  const walletRequests: string[] = [];
  for (const phone of phones) await fakeWalletService(phone, walletRequests);
  for (const phone of phones) {
    await phone.page.getByLabel(ko.settle.detailLabel).fill('friend@wallet.example');
    await phone.page.getByRole('button', { name: ko.settle.detailSend }).click();
    await expect(phone.page.getByText(ko.settle.detailSent)).toBeVisible();
  }
  for (const { page } of phones) await expect(page.getByRole('button', { name: ko.settle.getInvoice })).toBeVisible();
  expect(walletRequests).toEqual([]);

  for (const { page } of phones) {
    await page.getByRole('button', { name: ko.settle.getInvoice }).click();
    await expect(page.getByRole('link', { name: ko.settle.payOpen })).toHaveAttribute('href', `lightning:${INVOICE_100_SATS}`);
    await page.getByRole('button', { name: ko.settle.paid, exact: true }).click();
    await expect(page.getByText(ko.settle.paidDone, { exact: true })).toBeVisible();
  }
  expect(walletRequests.filter((path) => path.includes('lnurlp'))).toHaveLength(4);
  expect(walletRequests.filter((path) => path === '/pay?amount=100000')).toHaveLength(4);
  await shot(phones[0]!.page, 'journey-07-paid');
  await auditBothLanguages(phones[0]!.page, 'settling');
  for (const { page } of phones) {
    await page.getByRole('button', { name: ko.settle.gotIt, exact: true }).click();
    await expect(page.getByText(ko.settle.gotDone, { exact: true })).toBeVisible();
  }
  for (const { page } of phones) await expect(page.getByText(ko.settle.theyGot)).toBeVisible();
  await shot(phones[0]!.page, 'journey-08-settled');

  await phones[0]!.page.getByRole('radio', { name: ko.cards.thanks }).first().check();
  await phones[0]!.page.getByRole('button', { name: ko.after.thanksSend }).click();
  await expect(phones[0]!.page.getByText(ko.after.thanksSent)).toBeVisible();
  const thanked = giverOf(NAMES[0]!);
  await expect(thanked.page.getByText(ko.after.thanksGot)).toBeVisible();

  await expect(phones[0]!.page.locator('.keepsake')).toContainText(targets.get(NAMES[0]!)!);
  await shot(phones[0]!.page, 'journey-09-keepsake');

  await phones[0]!.page.getByRole('button', { name: ko.after.again }).click();
  await expect(phones[0]!.page.getByRole('heading', { name: ko.waiting.title })).toBeVisible();
  await expect(phones[1]!.page.getByRole('button', { name: ko.after.againJoin })).toBeVisible();
  await phones[1]!.page.getByRole('button', { name: ko.after.againJoin }).click();
  await expect(phones[1]!.page.getByRole('heading', { name: ko.waiting.title })).toBeVisible();
  await expect(phones[0]!.page.getByText(ko.waiting.here(2))).toBeVisible();
});

test('a wallet service that fails is not a dead end', async ({ browser }) => {
  test.setTimeout(120_000);
  const { phones } = await gather(browser, ['Ann', 'Ben', 'Cal', 'Dee']);
  await lockAndAgree(phones);
  await Promise.all(phones.map((phone) => waitForGame(phone)));
  for (const phone of phones) await pullSlip(phone);

  const giver = phones[0]!;
  const targetName = await peekName(giver);
  const target = phones.find(({ name }) => name === targetName)!;
  await tab(giver.page, ko.nav.send).click();
  await giver.page.getByRole('radio', { name: ko.cards.smile }).check();
  await giver.page.getByRole('button', { name: ko.send.submit }).click();
  await expect(giver.page.locator('.sent')).toBeVisible();

  await giver.context.route('https://wallet.example/**', (route) => route.abort());
  await moveTime(phones, FAR_FUTURE_MS);
  for (const { page } of [giver, target]) {
    await tab(page, ko.nav.home).click();
    await tab(page, ko.nav.reveal).click();
  }

  await target.page.getByLabel(ko.settle.detailLabel).fill('friend@wallet.example');
  await target.page.getByRole('button', { name: ko.settle.detailSend }).click();
  await giver.page.getByRole('button', { name: ko.settle.getInvoice }).click();
  await expect(giver.page.getByText(ko.settle.invoiceUnreachable)).toBeVisible();
  await expect(giver.page.getByRole('link', { name: ko.settle.payOpen })).toHaveAttribute('href', 'lightning:friend@wallet.example');
  await expect(giver.page.getByRole('button', { name: ko.settle.paid, exact: true })).toBeVisible();

  await target.page.getByRole('button', { name: ko.settle.changeDetail }).click();
  await target.page.getByLabel(ko.settle.detailLabel).fill(INVOICE_100_SATS);
  await target.page.getByRole('button', { name: ko.settle.detailSend }).click();
  await expect(giver.page.getByRole('link', { name: ko.settle.payOpen })).toHaveAttribute('href', `lightning:${INVOICE_100_SATS}`);
});

test('every main screen passes the shared rules in both languages', async ({ browser }) => {
  test.setTimeout(180_000);
  const { phones } = await gather(browser, ['Alpha', 'Bravo', 'Charlie', 'Delta']);
  const [organiser, player] = phones as [Phone, Phone, ...Phone[]];
  const { page } = organiser;

  await auditBothLanguages(page, 'waiting');
  await auditBothLanguages(player.page, 'waiting, player');

  await page.getByRole('button', { name: ko.waiting.lock }).click();
  await expect(page.getByRole('button', { name: ko.check.match })).toBeVisible();
  await auditBothLanguages(page, 'check');
  await page.getByRole('button', { name: ko.check.match }).click();
  await Promise.all(phones.map((phone) => waitForGame(phone)));

  await auditBothLanguages(page, 'home');
  await pullSlip(organiser);
  await auditBothLanguages(page, 'slip');

  await tab(page, ko.nav.send).click();
  await auditBothLanguages(page, 'send');
  await page.getByRole('button', { name: ko.send.ideaToggle }).click();
  await auditBothLanguages(page, 'send with idea');

  await tab(page, ko.nav.inbox).click();
  await auditBothLanguages(page, 'inbox empty');

  await tab(page, ko.nav.reveal).click();
  await auditBothLanguages(page, 'reveal countdown');

  await page.getByRole('button', { name: ko.menu.open }).click();
  await page.getByRole('button', { name: ko.menu.howTo }).click();
  await auditBothLanguages(page, 'how to play');
  await page.getByRole('button', { name: ko.menu.close }).click();

  await page.getByRole('button', { name: ko.menu.open }).click();
  await page.getByRole('button', { name: ko.menu.personal }).click();
  await auditBothLanguages(page, 'personal link');
  await page.getByRole('button', { name: ko.menu.close }).click();

  await page.getByRole('button', { name: ko.menu.open }).click();
  await page.getByRole('button', { name: ko.menu.server }).click();
  expect(await visibleText(page)).toContain('해시');
  await page.getByRole('button', { name: ko.menu.close }).click();

  await moveTime(phones, FAR_FUTURE_MS);
  await page.waitForTimeout(500);
  await tab(page, ko.nav.home).click();
  await tab(page, ko.nav.reveal).click();
  await page.getByRole('button', { name: ko.reveal.press }).click();
  await expect(page.locator('.pairs li')).toHaveCount(1, { timeout: 15_000 });
  await auditBothLanguages(page, 'reveal after');
  await expect(page.getByRole('heading', { name: ko.settle.title })).toBeVisible();
});

test('lockAndAgree helper leaves a drawn round ready', async ({ browser }) => {
  const { phones } = await gather(browser, ['Eins', 'Zwei', 'Drei', 'Vier']);
  await lockAndAgree(phones);
  await Promise.all(phones.map((phone) => waitForGame(phone)));
});
