import { describe, expect, it } from 'vitest';
import { fromB64, toB64 } from './bytes.js';
import { generateAgreementKey, randomBytes, shuffled } from './crypto.js';
import { circleOrder, phaseOf } from './fold.js';
import { decodeBoxPublic, encodeBoxPublic, onionBytesAtLayer, peelAndShuffle, wrapOnion } from './onion.js';
import { assertOneCircle, drawnRound, FakeServer, lockAndCheck, openRound, organiser, settle, targetsByPlayer } from './testing/harness.js';

const ROUND = toB64(new Uint8Array(16));
const FAIRNESS_ROUNDS = 240;

async function fakeBox(): Promise<{ ecdh: string; ecdsa: string }> {
  return {
    ecdh: toB64((await generateAgreementKey(false)).publicRaw),
    ecdsa: toB64((await generateAgreementKey(false)).publicRaw),
  };
}

describe('onion', () => {
  it('peels one layer at a time back to the box keys', async () => {
    const mixers = [await generateAgreementKey(false), await generateAgreementKey(false)];
    const box = await fakeBox();
    const onion = await wrapOnion(ROUND, 1, mixers.map((key) => toB64(key.publicRaw)), box);
    const first = await peelAndShuffle(ROUND, 1, 0, mixers[0]!, [onion]);
    const second = await peelAndShuffle(ROUND, 1, 1, mixers[1]!, first!);
    expect(decodeBoxPublic(fromB64(second![0]!))).toEqual(box);
  });

  it('will not open under another attempt or position', async () => {
    const mixer = await generateAgreementKey(false);
    const onion = await wrapOnion(ROUND, 1, [toB64(mixer.publicRaw)], await fakeBox());
    expect(await peelAndShuffle(ROUND, 2, 0, mixer, [onion])).toBeNull();
    expect(await peelAndShuffle(ROUND, 1, 1, mixer, [onion])).toBeNull();
  });

  it('grows by exactly one layer per player', () => {
    expect(onionBytesAtLayer(30, 0)).toBe(130 + 93 * 30);
    expect(onionBytesAtLayer(30, 30)).toBe(130);
  });

  it('a mix step really shuffles', async () => {
    const mixer = await generateAgreementKey(false);
    const mixKeys = [toB64(mixer.publicRaw)];
    const boxes = await Promise.all(Array.from({ length: 6 }, fakeBox));
    const onions = await Promise.all(boxes.map((box) => wrapOnion(ROUND, 1, mixKeys, box)));
    const order = boxes.map((box) => box.ecdh);
    let unchanged = 0;
    const firstPositions = new Set<number>();
    for (let run = 0; run < 40; run++) {
      const peeled = await peelAndShuffle(ROUND, 1, 0, mixer, onions);
      const ecdh = peeled!.map((item) => decodeBoxPublic(fromB64(item)).ecdh);
      if (ecdh.join() === order.join()) unchanged++;
      firstPositions.add(order.indexOf(ecdh[0]!));
    }
    expect(unchanged).toBeLessThan(3);
    expect(firstPositions.size).toBeGreaterThan(3);
  });
});

describe('the circle', () => {
  it('does not depend on the order the last mixer chose', async () => {
    const boxes = await Promise.all(Array.from({ length: 8 }, fakeBox));
    const seed = randomBytes(32);
    const expected = await circleOrder(seed, boxes);
    for (let run = 0; run < 5; run++) expect(await circleOrder(seed, shuffled(boxes))).toEqual(expected);
  });

  it('changes with the seed', async () => {
    const boxes = await Promise.all(Array.from({ length: 8 }, fakeBox));
    const first = await circleOrder(randomBytes(32), boxes);
    const second = await circleOrder(randomBytes(32), boxes);
    expect(first).not.toEqual(second);
    expect(encodeBoxPublic(first[0]!).length).toBe(130);
  });
});

describe('a whole draw', () => {
  it.each([4, 5, 12])('gives %i players one circle with no self-draw', async (count) => {
    const players = await drawnRound(new FakeServer(), count);
    assertOneCircle(players);
    for (const { client } of players) expect(client.phase).toBe('playing');
  });

  it('holds at 30 players', async () => {
    const players = await drawnRound(new FakeServer(), 30);
    assertOneCircle(players);
  }, 120_000);

  it('every phone reaches the same state', async () => {
    const players = await drawnRound(new FakeServer(), 6);
    const hashes = new Set(players.map(({ client }) => client.state.final!.slipsHash));
    expect(hashes.size).toBe(1);
  });

  it('shows the same check words on every phone before the draw', async () => {
    const server = new FakeServer();
    const players = await openRound(server, 5);
    await lockAndCheck(server, players);
    const words = players.map(({ client }) => client.state.check!.words!.join());
    expect(new Set(words).size).toBe(1);
    expect(phaseOf(organiser(players).state)).toBe('checking');
  });

  it('draws fairly: each player is equally likely to draw each other player', async () => {
    const counts = new Map<number, number>();
    for (let run = 0; run < FAIRNESS_ROUNDS; run++) {
      const players = await drawnRound(new FakeServer(), 4);
      const targets = targetsByPlayer(players);
      const index = players.findIndex(({ client }) => client.local.fp === targets.get(players[0]!.client.local.fp));
      counts.set(index, (counts.get(index) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual([1, 2, 3]);
    const expected = FAIRNESS_ROUNDS / 3;
    for (const count of counts.values()) expect(Math.abs(count - expected)).toBeLessThan(expected * 0.35);
  }, 180_000);

  it('never needs a tap once the words are agreed', async () => {
    const server = new FakeServer();
    const players = await openRound(server, 4);
    await lockAndCheck(server, players);
    await organiser(players).confirmMatch();
    await settle(server, players);
    expect(organiser(players).state.final).not.toBeNull();
  });
});
