import { expect, test } from '@playwright/test';
import {
  auditBothLanguages,
  createRound,
  en,
  expectNoSidewaysScroll,
  gather,
  inviteLink,
  joinRound,
  ko,
  lockAndAgree,
  newPhone,
  peekName,
  pullSlip,
  setServerClock,
  tab,
  tap,
  visibleText,
  waitForGame,
} from './helpers';

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_LOAD_BUDGET_BYTES = 300 * 1024;

test.beforeEach(async () => {
  await setServerClock(0);
});

test('the screens before a game starts pass the shared rules in both languages', async ({ browser }) => {
  test.setTimeout(120_000);
  const visitor = await newPhone(browser, 'Visitor');
  await visitor.page.goto('/');
  await expect(visitor.page.getByRole('button', { name: ko.landing.start })).toBeVisible();
  await auditBothLanguages(visitor.page, 'landing');

  await visitor.page.getByRole('button', { name: ko.landing.howTo }).click();
  await auditBothLanguages(visitor.page, 'how to play, no round');
  await visitor.page.getByRole('button', { name: ko.menu.close }).click();

  await visitor.page.getByRole('button', { name: ko.landing.start }).click();
  await auditBothLanguages(visitor.page, 'create');

  const { phones, link } = await gather(browser, ['Kim', 'Lee', 'Park', 'Choi']);
  const guest = await newPhone(browser, 'Guest');
  await guest.page.goto(link);
  await expect(guest.page.getByLabel(ko.join.nickname)).toBeVisible();
  await auditBothLanguages(guest.page, 'join');

  await lockAndAgree(phones);
  await guest.page.reload();
  await expect(guest.page.getByRole('heading', { name: ko.noKeys.title })).toBeVisible();
  await auditBothLanguages(guest.page, 'no keys');
});

test('every new round has sats, with no way to turn them off', async ({ browser }) => {
  test.setTimeout(120_000);
  const organiser = await newPhone(browser, 'Host');
  const { page } = organiser;
  await page.goto('/');
  await page.getByRole('button', { name: ko.landing.start }).click();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByText(ko.create.adultsNote)).toBeVisible();

  const budget = page.getByLabel(ko.create.budget);
  await expect(budget).toHaveValue('5000');
  await page.getByLabel(ko.create.nickname).fill('Host');
  await page.getByRole('radio', { name: ko.stickers.rabbit }).check();
  await budget.fill('0');
  await page.getByRole('button', { name: ko.create.submit, exact: true }).click();
  await expect(page.getByText(ko.create.budgetBad)).toBeVisible();

  await budget.fill('2000');
  await page.getByRole('button', { name: ko.create.submit, exact: true }).click();
  await expect(page.getByRole('heading', { name: ko.waiting.title })).toBeVisible();
  const link = await inviteLink(page);
  const others = await Promise.all(['Two', 'Three', 'Four'].map((name) => newPhone(browser, name)));
  for (const other of others) await joinRound(other, link);
  const phones = [organiser, ...others];
  await lockAndAgree(phones);
  await Promise.all(phones.map((each) => waitForGame(each)));

  await pullSlip(organiser);
  await tab(page, ko.nav.send).click();
  await expect(page.getByText(ko.send.left('2,000'))).toBeVisible();
  await expect(page.getByRole('radio', { name: ko.send.noPromise })).toBeVisible();
});

test('joining takes one text field and two taps', async ({ browser }) => {
  const organiser = await newPhone(browser, '가람');
  const link = await createRound(organiser);
  const player = await newPhone(browser, '나래');
  await player.page.goto(link);
  await expect(player.page.getByLabel(ko.join.nickname)).toBeVisible();
  expect(await player.page.locator('input:not([type="radio"]), textarea, select').count()).toBe(1);
  await expect(player.page.getByText(ko.join.explain)).toBeVisible();

  await player.page.getByLabel(ko.join.nickname).fill('나래');
  await tap(player, player.page.getByRole('radio', { name: ko.stickers.cat }));
  await tap(player, player.page.getByRole('button', { name: ko.join.submit, exact: true }));
  await expect(player.page.getByRole('heading', { name: ko.waiting.title })).toBeVisible();
  expect(player.taps).toBe(2);
});

test('a taken nickname gets a kind answer and a suggestion', async ({ browser }) => {
  const organiser = await newPhone(browser, '다솜');
  const link = await createRound(organiser);
  const copycat = await newPhone(browser, '다솜');
  await copycat.page.goto(link);
  await copycat.page.getByLabel(ko.join.nickname).fill('다솜');
  await copycat.page.getByRole('radio', { name: ko.stickers.fox }).check();
  await copycat.page.getByRole('button', { name: ko.join.submit, exact: true }).click();
  await expect(copycat.page.getByText(ko.join.taken('다솜'))).toBeVisible();
  await copycat.page.getByRole('button', { name: ko.join.useSuggestion('다솜2') }).click();
  await copycat.page.getByRole('button', { name: ko.join.submit, exact: true }).click();
  await expect(copycat.page.getByRole('heading', { name: ko.waiting.title })).toBeVisible();
});

test('the waiting room updates by itself and says how many more are needed', async ({ browser }) => {
  const organiser = await newPhone(browser, '라온');
  const link = await createRound(organiser);
  await expect(organiser.page.getByText(ko.waiting.needMore(3))).toBeVisible();
  await expect(organiser.page.getByRole('button', { name: ko.waiting.lock })).toBeDisabled();
  const friend = await newPhone(browser, '마루');
  await joinRound(friend, link);
  await expect(organiser.page.getByText(ko.waiting.needMore(2))).toBeVisible();
  await expect(organiser.page.getByText('마루')).toBeVisible();
});

test('the name stays off the screen until someone peeks', async ({ browser }) => {
  test.setTimeout(120_000);
  const { phones } = await gather(browser, ['Oak', 'Birch', 'Maple', 'Cedar']);
  await lockAndAgree(phones);
  const [phone] = phones;
  await Promise.all(phones.map((each) => waitForGame(each)));
  await pullSlip(phone!);

  const { page } = phone!;
  expect(await page.locator('.slip-name').count()).toBe(0);
  const target = await peekName(phone!);
  expect(['Birch', 'Maple', 'Cedar']).toContain(target);

  for (const section of [ko.nav.home, ko.nav.draw, ko.nav.send]) {
    await tab(page, section).click();
    expect(await visibleText(page)).not.toContain(target);
    expect(await page.title()).not.toContain(target);
    expect(await page.locator('body').ariaSnapshot()).not.toContain(target);
  }

  await tab(page, ko.nav.draw).click();
  const peek = page.getByRole('button', { name: ko.slip.peekLabel });
  const box = (await peek.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.locator('.slip-name')).toHaveText(target);
  await page.waitForTimeout(400);
  await page.mouse.up();
  await expect(page.locator('.slip-name')).toHaveCount(0);

  await peek.click();
  await expect(page.locator('.slip-name')).toHaveText(target);
  await expect(page.locator('.slip-name')).toHaveCount(0, { timeout: 7_000 });
});

test('a personal link restores slip, inbox and promises in a fresh browser', async ({ browser }) => {
  test.setTimeout(120_000);
  const { phones } = await gather(browser, ['Rain', 'Snow', 'Wind', 'Sun']);
  await lockAndAgree(phones);
  await Promise.all(phones.map((each) => waitForGame(each)));
  for (const phone of phones) await pullSlip(phone);

  const [phone] = phones;
  const target = await peekName(phone!);
  const { page } = phone!;
  await tab(page, ko.nav.send).click();
  await page.getByRole('radio', { name: ko.cards.smile }).check();
  await page.getByRole('button', { name: ko.send.submit }).click();
  await expect(page.locator('.sent')).toBeVisible();

  const giver = phones.find(({ name }) => name !== phone!.name);
  for (const other of phones.slice(1)) {
    await tab(other.page, ko.nav.send).click();
    await other.page.getByRole('radio', { name: ko.cards.rest }).check();
    await other.page.getByRole('button', { name: ko.send.submit }).click();
    await expect(other.page.locator('.sent')).toBeVisible();
  }
  expect(giver).toBeDefined();

  await setServerClock(DAY_MS);
  await page.getByRole('button', { name: ko.menu.open }).click();
  await page.getByRole('button', { name: ko.menu.personal }).click();
  await page.getByRole('button', { name: ko.personal.copy }).click();
  const personalLink = await page.evaluate(() => navigator.clipboard.readText());
  expect(personalLink).toContain('#me=');

  const fresh = await newPhone(browser, 'Rain again');
  await fresh.context.clock.setFixedTime(Date.now() + DAY_MS);
  await fresh.page.goto(personalLink);
  await waitForGame(fresh);
  expect(fresh.page.url()).not.toContain('#me=');

  await tab(fresh.page, ko.nav.draw).click();
  await fresh.page.getByRole('button', { name: ko.draw.pull }).click();
  expect(await peekName(fresh)).toBe(target);

  await tab(fresh.page, ko.nav.inbox).click();
  await expect(fresh.page.getByText(ko.cards.rest)).toBeVisible();

  await tab(fresh.page, ko.nav.send).click();
  await expect(fresh.page.getByText(ko.cards.smile, { exact: true }).last()).toBeVisible();
  await expect(fresh.page.getByRole('listitem').filter({ hasText: ko.cards.smile })).toHaveCount(1);
});

test('the invite link in a browser with no keys, after the lock, explains and adds nobody', async ({ browser }) => {
  test.setTimeout(120_000);
  const { phones, link } = await gather(browser, ['Mars', 'Venus', 'Earth', 'Saturn']);
  await lockAndAgree(phones);
  await Promise.all(phones.map((each) => waitForGame(each)));

  const stranger = await newPhone(browser, 'Pluto');
  await stranger.page.goto(link);
  await expect(stranger.page.getByRole('heading', { name: ko.noKeys.title })).toBeVisible();
  await expect(stranger.page.getByText(ko.noKeys.body)).toBeVisible();
  await expect(stranger.page.getByLabel(ko.noKeys.personalLabel)).toBeVisible();
  await expect(stranger.page.getByRole('button', { name: ko.join.submit, exact: true })).toHaveCount(0);

  await stranger.page.getByLabel(ko.noKeys.personalLabel).fill('nonsense');
  await stranger.page.getByRole('button', { name: ko.noKeys.personalGo }).click();
  await expect(stranger.page.getByText(ko.noKeys.personalBad)).toBeVisible();

  const organiser = phones[0]!.page;
  await tab(organiser, ko.nav.inbox).click();
  await expect(organiser.getByRole('option')).toHaveCount(4);
});

test('a reload in the middle of the draw recovers', async ({ browser }) => {
  test.setTimeout(120_000);
  const { phones } = await gather(browser, ['Red', 'Blue', 'Gold', 'Pink']);
  const organiser = phones[0]!.page;
  await organiser.getByRole('button', { name: ko.waiting.lock }).click();
  await expect(organiser.getByRole('button', { name: ko.check.match })).toBeVisible();
  await phones[2]!.page.close();
  await organiser.getByRole('button', { name: ko.check.match }).click();
  await expect(organiser.getByRole('heading', { name: ko.draw.title })).toBeVisible();
  await organiser.reload();
  await phones[1]!.page.reload();
  phones[2]!.page = await phones[2]!.context.newPage();
  await phones[2]!.page.goto('/');
  await Promise.all(phones.map((phone) => waitForGame(phone)));
  await expect(organiser.getByRole('navigation', { name: ko.navLabel })).toBeVisible();
});

test('a card sent offline goes out when the connection returns', async ({ browser }) => {
  test.setTimeout(120_000);
  const { phones } = await gather(browser, ['Mint', 'Sage', 'Dill', 'Basil']);
  await lockAndAgree(phones);
  await Promise.all(phones.map((each) => waitForGame(each)));
  const [phone] = phones;
  await pullSlip(phone!);
  const { page, context } = phone!;
  await tab(page, ko.nav.send).click();
  await context.setOffline(true);
  await page.getByRole('radio', { name: ko.cards.cheer }).check();
  await page.getByRole('button', { name: ko.send.submit }).click();
  await expect(page.locator('.sent')).toHaveText(ko.send.queued);
  await expect(page.getByText(ko.send.waiting)).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText(ko.send.waiting)).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText(/도착$/)).toBeVisible();
});

test('the organiser can nudge and remove someone who never opens the link', async ({ browser }) => {
  test.setTimeout(120_000);
  const { phones } = await gather(browser, ['Ash', 'Elm', 'Fir', 'Yew', 'Ivy']);
  const organiser = phones[0]!.page;
  await phones[4]!.page.close();
  await organiser.getByRole('button', { name: ko.waiting.lock }).click();
  await expect(organiser.getByRole('button', { name: ko.draw.remove('Ivy') })).toHaveCount(0);
  await expect(organiser.getByRole('button', { name: ko.draw.nudge })).toBeVisible();
  await organiser.getByRole('button', { name: ko.draw.nudge }).click();
  await expect(organiser.getByText(ko.draw.nudged)).toBeVisible();
  const message = await organiser.evaluate(() => navigator.clipboard.readText());
  expect(message).toContain('Ivy');
  expect(message).toContain('#join=');

  await organiser.getByRole('button', { name: ko.draw.remove('Ivy') }).click();
  await organiser.getByRole('button', { name: ko.draw.removeYes }).click();
  await organiser.getByRole('button', { name: ko.check.match }).click();
  await Promise.all(phones.slice(0, 4).map((phone) => waitForGame(phone)));
});

test('the first load stays within the size budget', async ({ browser }) => {
  const phone = await newPhone(browser, 'Budget');
  let total = 0;
  phone.page.on('requestfinished', (request) => {
    void request.sizes().then((sizes) => {
      total += sizes.responseBodySize + sizes.responseHeadersSize;
    });
  });
  await phone.page.goto('/', { waitUntil: 'networkidle' });
  await phone.page.waitForTimeout(300);
  expect(total).toBeGreaterThan(50_000);
  expect(total).toBeLessThan(FIRST_LOAD_BUDGET_BYTES);
});

test('nothing is fetched from anywhere but the app itself', async ({ browser }) => {
  const phone = await newPhone(browser, 'Local');
  const hosts = new Set<string>();
  phone.page.on('request', (request) => hosts.add(new URL(request.url()).host));
  const link = await createRound(phone);
  expect(link).toContain('#join=');
  expect([...hosts]).toEqual(['127.0.0.1:3210']);
});

test('language follows the phone, with Korean when it cannot be told', async ({ browser }) => {
  const english = await newPhone(browser, 'En', { locale: 'en-GB' });
  await english.page.goto('/');
  await expect(english.page.getByRole('button', { name: en.landing.start })).toBeVisible();

  const french = await newPhone(browser, 'Fr', { locale: 'fr-FR' });
  await french.page.goto('/');
  await expect(french.page.getByRole('button', { name: ko.landing.start })).toBeVisible();

  await french.page.getByRole('button', { name: ko.languageToggleLabel }).click();
  await expect(french.page.getByRole('button', { name: en.landing.start })).toBeVisible();
  await french.page.waitForTimeout(300);
  await french.page.reload();
  await expect(french.page.getByRole('button', { name: en.landing.start })).toBeVisible();
});

test('KakaoTalk: warns inside the in-app browser and offers a way out', async ({ browser }) => {
  const organiser = await newPhone(browser, 'Host');
  const link = await createRound(organiser);

  const inApp = await newPhone(browser, 'InApp', {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 KAKAOTALK 10.0',
  });
  await inApp.page.goto(link);
  await expect(inApp.page.getByText(ko.inApp.title)).toBeVisible();
  const escape = inApp.page.getByRole('link', { name: ko.inApp.openOutside });
  await expect(escape).toHaveAttribute('href', /^kakaotalk:\/\/web\/openExternal\?url=.*%23join%3D/);
  await expect(inApp.page.getByText(ko.inApp.manual)).toBeVisible();

  await inApp.page.goto('/');
  await inApp.page.reload();
  await expect(inApp.page.getByText(ko.inApp.cutLinkTitle)).toBeVisible();
  await inApp.page.getByLabel(ko.landing.pasteLabel).fill(link);
  await inApp.page.getByRole('button', { name: ko.landing.pasteGo }).click();
  await expect(inApp.page.getByLabel(ko.join.nickname)).toBeVisible();
});

test('the layout survives 200% text and respects reduced motion', async ({ browser }) => {
  test.setTimeout(120_000);
  const { phones } = await gather(browser, ['Long', 'Tall', 'Wide', 'Deep']);
  await lockAndAgree(phones);
  await Promise.all(phones.map((each) => waitForGame(each)));
  const [phone] = phones;
  await pullSlip(phone!);
  const { page } = phone!;
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  for (const section of [ko.nav.home, ko.nav.draw, ko.nav.send, ko.nav.inbox, ko.nav.reveal]) {
    await tab(page, section).click();
    await expectNoSidewaysScroll(page);
  }

  const calm = await newPhone(browser, 'Calm', { reducedMotion: 'reduce' });
  await calm.page.goto('/');
  const running = await calm.page.evaluate(() => document.getAnimations().length);
  expect(running).toBe(0);
});
