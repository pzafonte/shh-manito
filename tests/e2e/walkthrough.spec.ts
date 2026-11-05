import { expect, test } from '@playwright/test';
import {
  createRound,
  gather,
  joinRound,
  ko,
  newPhone,
  peekName,
  pullSlip,
  setServerClock,
  shot,
  tab,
  waitForGame,
  type Phone,
} from './helpers';

// Screenshots for the walkthrough review. Runs only when asked for, because it
// proves nothing by itself: a person has to look at the pictures.
test.skip(!process.env.WALKTHROUGH_DIR, 'Set WALKTHROUGH_DIR to capture screenshots');

const DAY_MS = 24 * 60 * 60 * 1000;
const REVEAL_OFFSET_MS = 8 * DAY_MS;

test.beforeEach(async () => {
  await setServerClock(0);
});

async function moveTime(phones: Phone[], offsetMs: number): Promise<void> {
  await setServerClock(offsetMs);
  await Promise.all(phones.map(({ context }) => context.clock.setFixedTime(Date.now() + offsetMs)));
}

test('the student: joins from a link, no bitcoin, Korean', async ({ browser }) => {
  test.setTimeout(180_000);
  const friends = await Promise.all(['민지', '서연', '지호'].map((name) => newPhone(browser, name)));
  const link = await createRound(friends[0]!);
  const student = await newPhone(browser, '하윤');
  await student.page.goto(link);
  await expect(student.page.getByLabel(ko.join.nickname)).toBeVisible();
  await shot(student.page, 'student-01-join');
  await joinRound(student, link, 'cat');
  await shot(student.page, 'student-02-waiting');
  for (const friend of friends.slice(1)) await joinRound(friend, link, 'dog');
  const phones = [...friends, student];

  await friends[0]!.page.getByRole('button', { name: ko.waiting.lock }).click();
  await expect(student.page.locator('.check-words li')).toHaveCount(3);
  await shot(student.page, 'student-03-check');
  await friends[0]!.page.getByRole('button', { name: ko.check.match }).click();
  await expect(student.page.getByRole('heading', { name: ko.draw.title })).toBeVisible();
  await shot(student.page, 'student-04-draw');
  await Promise.all(phones.map((phone) => waitForGame(phone)));
  await shot(student.page, 'student-05-home');
  await tab(student.page, ko.nav.draw).click();
  await shot(student.page, 'student-06-pull');
  await pullSlip({ ...student, page: student.page }).catch(() => undefined);
  await student.page.waitForTimeout(600);
  await shot(student.page, 'student-07-slip-folded');
  await student.page.getByRole('button', { name: ko.slip.peekLabel }).click();
  await shot(student.page, 'student-08-slip-open');
  await tab(student.page, ko.nav.send).click();
  await shot(student.page, 'student-09-send');
  await student.page.getByRole('radio', { name: ko.cards.smile }).check();
  await student.page.getByRole('button', { name: ko.send.submit }).click();
  await expect(student.page.locator('.sent')).toBeVisible();
  await shot(student.page, 'student-10-sent');
  await tab(student.page, ko.nav.inbox).click();
  await shot(student.page, 'student-11-inbox-empty');

  for (const friend of friends) {
    await tab(friend.page, ko.nav.send).click();
    await friend.page.getByRole('radio', { name: ko.cards.lunch }).check();
    await friend.page.getByRole('button', { name: ko.send.submit }).click();
    await expect(friend.page.locator('.sent')).toBeVisible();
  }
  await moveTime(phones, DAY_MS);
  await tab(student.page, ko.nav.home).click();
  await expect(student.page.getByText(ko.home.unread(1))).toBeVisible({ timeout: 15_000 });
  await shot(student.page, 'student-12-home-unread');
  await tab(student.page, ko.nav.inbox).click();
  await shot(student.page, 'student-13-inbox');
  await tab(student.page, ko.nav.reveal).click();
  await shot(student.page, 'student-14-countdown');

  await moveTime(phones, REVEAL_OFFSET_MS);
  await student.page.waitForTimeout(400);
  await tab(student.page, ko.nav.home).click();
  await tab(student.page, ko.nav.reveal).click();
  await shot(student.page, 'student-15-reveal-open');
  for (const phone of phones) {
    await tab(phone.page, ko.nav.home).click();
    await tab(phone.page, ko.nav.reveal).click();
    await phone.page.getByRole('button', { name: ko.reveal.press }).click();
  }
  await expect(student.page.locator('.pairs li')).toHaveCount(4, { timeout: 20_000 });
  await shot(student.page, 'student-16-revealed');
});

test('the organiser in a hurry: sets it all up, sats on', async ({ browser }) => {
  test.setTimeout(180_000);
  const organiser = await newPhone(browser, '준호');
  await organiser.page.goto('/');
  await shot(organiser.page, 'organiser-01-landing');
  await organiser.page.getByRole('button', { name: ko.landing.start }).click();
  await shot(organiser.page, 'organiser-02-create');
  await organiser.page.getByRole('checkbox', { name: ko.create.satsToggle }).check();
  await organiser.page.getByLabel(ko.create.nickname).fill('준호');
  await organiser.page.getByRole('radio', { name: ko.stickers.rabbit }).check();
  await shot(organiser.page, 'organiser-03-create-sats');
  await organiser.page.getByRole('button', { name: ko.create.submit, exact: true }).click();
  await expect(organiser.page.getByRole('heading', { name: ko.waiting.title })).toBeVisible();
  await shot(organiser.page, 'organiser-04-waiting');
  await organiser.page.getByRole('button', { name: ko.waiting.qrShow }).click();
  await expect(organiser.page.locator('img.qr')).toBeVisible();
  await shot(organiser.page, 'organiser-05-qr');
  await organiser.page.getByRole('button', { name: ko.waiting.qrHide }).click();
  await organiser.page.getByRole('button', { name: ko.waiting.copy, exact: true }).first().click();
  const link = await organiser.page.evaluate(() => navigator.clipboard.readText());

  const others = await Promise.all(['은지', '태양', '수아', '도윤'].map((name) => newPhone(browser, name)));
  for (const other of others) await joinRound(other, link, 'fox');
  await expect(organiser.page.getByText(ko.waiting.here(5))).toBeVisible();
  await shot(organiser.page, 'organiser-06-ready');

  await others[3]!.page.close();
  await organiser.page.getByRole('button', { name: ko.waiting.lock }).click();
  await expect(organiser.page.getByRole('button', { name: ko.draw.nudge })).toBeVisible();
  await shot(organiser.page, 'organiser-07-stalled');
  await organiser.page.getByRole('button', { name: ko.draw.remove('도윤') }).click();
  await shot(organiser.page, 'organiser-08-remove-confirm');
  await organiser.page.getByRole('button', { name: ko.draw.removeYes }).click();
  await expect(organiser.page.getByRole('button', { name: ko.check.match })).toBeVisible();
  await shot(organiser.page, 'organiser-09-check');
  await organiser.page.getByRole('button', { name: ko.check.match }).click();
  const phones = [organiser, ...others.slice(0, 3)];
  await Promise.all(phones.map((phone) => waitForGame(phone)));
  await shot(organiser.page, 'organiser-10-home');

  await organiser.page.getByRole('button', { name: ko.menu.open }).click();
  await shot(organiser.page, 'organiser-11-menu');
  await organiser.page.getByRole('button', { name: ko.menu.server }).click();
  await shot(organiser.page, 'organiser-12-server');
  await organiser.page.getByRole('button', { name: ko.menu.close }).click();
  await organiser.page.getByRole('button', { name: ko.menu.open }).click();
  await organiser.page.getByRole('button', { name: ko.menu.howTo }).click();
  await shot(organiser.page, 'organiser-13-howto');
});

test('the older coworker: large text, sats on, through settling', async ({ browser }) => {
  test.setTimeout(180_000);
  const { phones } = await gather(browser, ['김부장', '이과장', '박대리', '최사원'], { sats: true });
  const [coworker] = phones as [Phone, ...Phone[]];
  const { page } = coworker;
  const big = async (): Promise<void> => {
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
  };
  await big();
  await shot(page, 'coworker-01-waiting');
  await page.getByRole('button', { name: ko.waiting.lock }).click();
  await expect(page.getByRole('button', { name: ko.check.match })).toBeVisible();
  await shot(page, 'coworker-02-check');
  await page.getByRole('button', { name: ko.check.match }).click();
  await Promise.all(phones.map((phone) => waitForGame(phone)));
  await shot(page, 'coworker-03-home');
  for (const phone of phones) await pullSlip(phone);
  await shot(page, 'coworker-04-slip');
  const targets = new Map<string, string>();
  for (const phone of phones) targets.set(phone.name, await peekName(phone));

  await tab(page, ko.nav.send).click();
  await shot(page, 'coworker-05-send');
  for (const phone of phones) {
    await tab(phone.page, ko.nav.send).click();
    await phone.page.getByRole('radio', { name: ko.cards.coffee }).check();
    await phone.page.getByRole('button', { name: ko.send.submit }).click();
    await expect(phone.page.locator('.sent')).toBeVisible();
  }
  await moveTime(phones, DAY_MS);
  await tab(page, ko.nav.inbox).click();
  await expect(page.getByText(ko.cards.coffee).first()).toBeVisible({ timeout: 15_000 });
  await shot(page, 'coworker-06-inbox');

  await moveTime(phones, REVEAL_OFFSET_MS);
  await page.waitForTimeout(400);
  for (const phone of phones) {
    await tab(phone.page, ko.nav.home).click();
    await tab(phone.page, ko.nav.reveal).click();
    await phone.page.getByRole('button', { name: ko.reveal.press }).click();
  }
  await expect(page.locator('.pairs li')).toHaveCount(4, { timeout: 20_000 });
  await shot(page, 'coworker-07-revealed');
  for (const phone of phones) {
    await phone.page.getByLabel(ko.settle.detailLabel).fill('friend@example.com');
    await phone.page.getByRole('button', { name: ko.settle.detailSend }).click();
    await expect(phone.page.getByText(ko.settle.detailSent)).toBeVisible();
  }
  await expect(page.getByRole('link', { name: ko.settle.payOpen })).toBeVisible();
  await shot(page, 'coworker-08-settle');
});
