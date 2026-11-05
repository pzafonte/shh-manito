import { beforeEach, describe, expect, it } from 'vitest';
import { fromB64, toB64 } from './bytes.js';
import { generateAgreementKey, generateSigningKey, randomBytes, signFields } from './crypto.js';
import { encryptGroupEvent, sealParcel } from './envelopes.js';
import { signBoth, signEvent, type EventOf, type GroupEvent, type Parcel } from './events.js';
import { encodeBoxPublic, type BoxPublic } from './onion.js';
import type { LogEntry } from './fold.js';
import {
  assertOneCircle,
  decodeAll,
  drawnRound,
  fold,
  FakeServer,
  lockAndCheck,
  NOW,
  openRound,
  organiser,
  settle,
  tamperWith,
  type SimPlayer,
} from './testing/harness.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let server: FakeServer;

beforeEach(() => {
  server = new FakeServer();
});

async function startDraw(players: readonly SimPlayer[]): Promise<void> {
  await lockAndCheck(server, players);
  await organiser(players).confirmMatch();
}

async function freshBox(): Promise<BoxPublic> {
  return {
    ecdh: toB64((await generateAgreementKey(false)).publicRaw),
    ecdsa: toB64((await generateSigningKey(false)).publicRaw),
  };
}

function lastMixer(players: readonly SimPlayer[]): SimPlayer {
  return players[players.length - 1]!;
}

async function eventsOfType<T extends GroupEvent['t']>(
  players: readonly SimPlayer[],
  type: T,
): Promise<EventOf<T>[]> {
  const events = await decodeAll(organiser(players), server.log);
  return events.filter((event): event is EventOf<T> => event.t === type);
}

function firstAttempt(players: readonly SimPlayer[]) {
  return organiser(players).state.attempts[0]!;
}

// Every phone sees a bad list for itself, reports it and moves on together.
async function expectRejectedList(players: readonly SimPlayer[]): Promise<void> {
  expect(firstAttempt(players).stage).toBe('dead');
  const aborts = (await eventsOfType(players, 'abort')).filter((event) => event.a === 1);
  expect(aborts.map((event) => event.why)).toContain('bad-list');
}

function tamperOnce(player: SimPlayer, type: GroupEvent['t'], rewrite: (event: never) => GroupEvent | Promise<GroupEvent>): void {
  let used = false;
  tamperWith(server, player, (event) => {
    if (event.t !== type || used) return event;
    used = true;
    return rewrite(event as never);
  });
}

describe('a malicious mixer', () => {
  it('cannot drop a key: the list is rejected and the draw restarts', async () => {
    const players = await openRound(server, 5);
    tamperOnce(players[1]!, 'mix', (mix: EventOf<'mix'>) => ({ ...mix, items: mix.items.slice(1) }));
    await startDraw(players);
    await settle(server, players);
    await expectRejectedList(players);
    assertOneCircle(players);
  });

  it('cannot duplicate a key: the next mixer refuses before peeling', async () => {
    const players = await openRound(server, 5);
    tamperOnce(players[1]!, 'mix', (mix: EventOf<'mix'>) => ({
      ...mix,
      items: [mix.items[0]!, mix.items[0]!, ...mix.items.slice(2)],
    }));
    await startDraw(players);
    await settle(server, players);
    const attemptOneMixes = (await eventsOfType(players, 'mix')).filter((mix) => mix.a === 1);
    expect(attemptOneMixes.map((mix) => mix.k)).toEqual([0, 1]);
    await expectRejectedList(players);
    assertOneCircle(players);
  });

  it('cannot replace a key: its owner notices and the attempt dies', async () => {
    const players = await openRound(server, 5);
    const replacement = await freshBox();
    tamperOnce(lastMixer(players), 'mix', (mix: EventOf<'mix'>) => ({
      ...mix,
      items: [toB64(encodeBoxPublic(replacement)), ...mix.items.slice(1)],
    }));
    await startDraw(players);
    await settle(server, players);
    expect(firstAttempt(players).death).toBe('abort');
    assertOneCircle(players);
  });

  it('cannot keep half of a key pair (F14)', async () => {
    const players = await openRound(server, 5);
    const attacker = await freshBox();
    tamperOnce(lastMixer(players), 'mix', (mix: EventOf<'mix'>) => {
      const victim = fromB64(mix.items[0]!);
      const spliced = encodeBoxPublic({ ecdh: toB64(victim.slice(0, 65)), ecdsa: attacker.ecdsa });
      return { ...mix, items: [toB64(spliced), ...mix.items.slice(1)] };
    });
    await startDraw(players);
    await settle(server, players);
    expect(firstAttempt(players).death).toBe('abort');
    assertOneCircle(players);
  });

  it('cannot give one half of a key to two slots', async () => {
    const players = await openRound(server, 5);
    const attacker = await freshBox();
    tamperOnce(lastMixer(players), 'mix', (mix: EventOf<'mix'>) => {
      const victim = fromB64(mix.items[0]!);
      const spliced = encodeBoxPublic({ ecdh: toB64(victim.slice(0, 65)), ecdsa: attacker.ecdsa });
      return { ...mix, items: [mix.items[0]!, toB64(spliced), ...mix.items.slice(2)] };
    });
    await startDraw(players);
    await settle(server, players);
    await expectRejectedList(players);
  });

  it('cannot lie about what it was given', async () => {
    const players = await openRound(server, 5);
    tamperOnce(players[2]!, 'mix', (mix: EventOf<'mix'>) => ({ ...mix, input: toB64(randomBytes(32)) }));
    await startDraw(players);
    await settle(server, players);
    await expectRejectedList(players);
  });

  it('corrupting an item only kills the attempt it is in (F16)', async () => {
    const players = await openRound(server, 5);
    tamperOnce(players[1]!, 'mix', (mix: EventOf<'mix'>) => {
      const damaged = fromB64(mix.items[0]!);
      damaged[80]! ^= 1;
      return { ...mix, items: [toB64(damaged), ...mix.items.slice(1)] };
    });
    await startDraw(players);
    await settle(server, players);
    expect(firstAttempt(players).death).toBe('abort');
    assertOneCircle(players);
  });

  it('cannot pick the circle: a rigged final order changes nothing (F1)', async () => {
    const players = await openRound(server, 6);
    tamperOnce(lastMixer(players), 'mix', (mix: EventOf<'mix'>) => ({ ...mix, items: [...mix.items].sort() }));
    await startDraw(players);
    await settle(server, players);
    const final = organiser(players).state.final!;
    expect(final.number).toBe(1);
    const rigged = final.payloads!.map((box) => box.ecdh);
    const circle = final.circle!.map((box) => box.ecdh);
    expect([...circle].sort()).toEqual([...rigged].sort());
    expect(circle).not.toEqual(rigged);
  });

  it('an honest mixer peels at most once, even across a reload (F4)', async () => {
    const players = await openRound(server, 4);
    await startDraw(players);
    const mixer = players[1]!;
    for (let pass = 0; pass < 30; pass++) {
      for (const player of players) {
        if (player === mixer && player.store.snapshot) {
          const { PlayerClient } = await import('./client.js');
          const reloaded = await PlayerClient.open(
            structuredClone(player.store.snapshot),
            () => server.transport(player.name),
            player.store,
          );
          player.client = reloaded;
        }
        await player.client.tick();
      }
    }
    const mixes = (await eventsOfType(players, 'mix')).filter((mix) => mix.from === mixer.client.local.fp);
    expect(mixes).toHaveLength(1);
    assertOneCircle(players);
  });
});

describe('after a failed attempt', () => {
  it('no key carries over', async () => {
    const players = await openRound(server, 5);
    const replacement = await freshBox();
    tamperOnce(lastMixer(players), 'mix', (mix: EventOf<'mix'>) => ({
      ...mix,
      items: [toB64(encodeBoxPublic(replacement)), ...mix.items.slice(1)],
    }));
    await startDraw(players);

    const seen = new Map<string, Set<string>>(players.map(({ name }) => [name, new Set<string>()]));
    const seeds = new Set<string>();
    for (let pass = 0; pass < 200 && !organiser(players).state.final; pass++) {
      for (const player of players) {
        await player.client.tick();
        const attempt = player.client.local.attempt;
        if (!attempt) continue;
        const keys = seen.get(player.name)!;
        keys.add(`${attempt.number}|${toB64(attempt.box.ecdh.publicRaw)}`);
        keys.add(`${attempt.number}|${toB64(attempt.box.ecdsa.publicRaw)}`);
        seeds.add(`${attempt.number}|${attempt.seed}`);
      }
    }
    await settle(server, players);
    expect(organiser(players).state.final!.number).toBe(2);

    for (const keys of seen.values()) {
      const values = [...keys].map((key) => key.split('|')[1]);
      expect(values).toHaveLength(4);
      expect(new Set(values).size).toBe(4);
    }
    const seedValues = [...seeds].map((seed) => seed.split('|')[1]);
    expect(new Set(seedValues).size).toBe(seedValues.length);

    const mixKeys = (await eventsOfType(players, 'mixkey')).map((event) => event.mixPub);
    expect(new Set(mixKeys).size).toBe(mixKeys.length);
  });

  it('stops retrying after four failures and offers a way out (F12)', async () => {
    const players = await openRound(server, 4);
    tamperWith(server, players[1]!, (event) =>
      event.t === 'mix' ? { ...event, items: event.items.slice(1) } : event,
    );
    await startDraw(players);
    await settle(server, players);
    const state = organiser(players).state;
    expect(state.stuck).toBe(true);
    expect(state.failures).toBe(4);
    expect(state.attempts).toHaveLength(4);
    expect(organiser(players).phase).toBe('stuck');
  });
});

describe('replay from an earlier attempt', () => {
  async function abortFirstAttempt(players: readonly SimPlayer[]): Promise<void> {
    tamperOnce(players[1]!, 'mix', (mix: EventOf<'mix'>) => ({ ...mix, items: mix.items.slice(1) }));
    await startDraw(players);
    await settle(server, players);
  }

  it('reposted events change nothing', async () => {
    const players = await openRound(server, 4);
    await abortFirstAttempt(players);
    const before = await fold(organiser(players), server.log);
    const replayed: LogEntry[] = server.log
      .slice(0, Math.floor(server.log.length / 2))
      .map((entry, index) => ({ ...entry, seq: server.log.length + index + 1 }));
    const after = await fold(organiser(players), [...server.log, ...replayed]);
    expect(after.final?.circleHash).toBe(before.final?.circleHash);
    expect(after.attempts).toHaveLength(before.attempts.length);
  });

  it('a player re-signing an old onion for a new attempt is caught', async () => {
    const players = await openRound(server, 4);
    const cheat = players[2]!;
    let oldOnion: string | null = null;
    tamperWith(server, cheat, (event) => {
      if (event.t !== 'onion') return event;
      if (event.a === 1) {
        oldOnion = event.onion;
        return event;
      }
      return event.a === 2 ? { ...event, onion: oldOnion! } : event;
    });
    await abortFirstAttempt(players);
    const state = organiser(players).state;
    expect(state.attempts[1]!.stage).toBe('dead');
    assertOneCircle(players);
    expect(state.final!.number).toBe(3);
  });
});

describe('a hostile server', () => {
  it('cannot forge entries without the group key', async () => {
    const players = await drawnRound(server, 4);
    const before = await fold(organiser(players), server.log);
    const forged: LogEntry = { seq: server.log.length + 1, kind: 'group', body: randomBytes(540), visibleAt: null };
    const after = await fold(organiser(players), [...server.log, forged]);
    expect(after.final?.circleHash).toBe(before.final?.circleHash);
  });

  it('cannot forge events even with the group key from a colluding player', async () => {
    const players = await openRound(server, 4);
    await lockAndCheck(server, players);
    const fake = await generateSigningKey(false);
    const client = organiser(players);
    const { roundId } = client.local;
    const victim = players[1]!.client.local.fp;
    const forgeries: GroupEvent[] = [
      await signEvent(fake.privateKey, { t: 'match' as const, r: roundId, checkHash: client.state.check!.checkHash! }),
      await signEvent(fake.privateKey, { t: 'remove' as const, r: roundId, index: 0, target: victim, a: 0 }),
      await signEvent(fake.privateKey, { t: 'abort' as const, r: roundId, a: 1, from: victim, why: 'bad-list' as const }),
    ];
    for (const event of forgeries) {
      const body = await encryptGroupEvent(client.secrets.groupKey, roundId, event);
      await server.transport('server').post({ kind: 'group', body, held: false });
    }
    await settle(server, players);
    const state = client.state;
    expect(state.matched).toBe(false);
    expect(state.removed).toEqual([]);
  });

  it('cannot change anything by repeating entries', async () => {
    const players = await drawnRound(server, 4);
    const before = await fold(organiser(players), server.log);
    const doubled = [...server.log, ...server.log].map((entry, index) => ({ ...entry, seq: index + 1 }));
    const after = await fold(organiser(players), doubled);
    expect(after.final?.slipsHash).toBe(before.final?.slipsHash);
  });

  it('cannot change the outcome by reordering entries', async () => {
    const players = await drawnRound(server, 5);
    const before = await fold(organiser(players), server.log);
    const reversed = [...server.log].reverse().map((entry, index) => ({ ...entry, seq: index + 1 }));
    const after = await fold(organiser(players), reversed);
    expect(after.final?.circleHash).toBe(before.final?.circleHash);
    expect(after.final?.slipsHash).toBe(before.final?.slipsHash);
    expect(after.roster.map((player) => player.fp)).toEqual(before.roster.map((player) => player.fp));
  });

  it('holding back an entry stalls the game without changing it', async () => {
    const players = await drawnRound(server, 4);
    const before = await fold(organiser(players), server.log);
    const dropped = server.log.filter((entry, index) => index !== Math.floor(server.log.length / 2));
    const after = await fold(organiser(players), dropped);
    expect(after.final).toBeNull();
    expect(before.final).not.toBeNull();
  });

  it('showing clients different mix results kills the attempt, and the group recovers', async () => {
    const players = await openRound(server, 5);
    const mixer = players[1]!;
    const victim = players[4]!;
    let forkedSeq: number | null = null;
    let forkedBody: Uint8Array<ArrayBuffer> | null = null;
    const original = server.rewritePost;
    server.rewritePost = async (who, entry) => {
      const output = await original(who, entry);
      if (who !== mixer.name || entry.kind !== 'group' || forkedSeq !== null) return output;
      const [event] = await decodeAll(mixer.client, [{ seq: 0, kind: 'group', body: entry.body, visibleAt: null }]);
      if (event?.t !== 'mix') return output;
      const { sig: _sig, ...fields } = event;
      const other = await signEvent(mixer.client.local.identity.privateKey, {
        ...fields,
        items: [...event.items].reverse(),
      });
      forkedBody = await encryptGroupEvent(mixer.client.secrets.groupKey, mixer.client.local.roundId, other);
      forkedSeq = server.log.length + 1;
      return output;
    };
    server.rewriteView = (who, entries) => {
      if (who !== victim.name || forkedSeq === null) return entries;
      return entries.map((entry) => (entry.seq === forkedSeq ? { ...entry, body: forkedBody! } : entry));
    };
    await startDraw(players);
    await settle(server, players);
    expect(forkedSeq).not.toBeNull();
    expect(organiser(players).state.attempts[0]!.stage).toBe('dead');
    expect(organiser(players).state.final!.number).toBe(2);
    assertOneCircle(players);
  });

  it('cannot move the reveal or the post without phones noticing (F6)', async () => {
    const players = await drawnRound(server, 4);
    expect(organiser(players).scheduleTampered).toBe(false);
    server.schedule = { ...server.schedule!, revealAt: NOW + DAY_MS };
    await organiser(players).tick();
    expect(organiser(players).scheduleTampered).toBe(true);
  });
});

describe('drop-and-watch (F2)', () => {
  // The attack: hold back one player's slip and see whose phone behaves differently.
  it('no phone reacts to a missing slip, so the giver is not exposed', async () => {
    const players = await openRound(server, 5);
    const victim = players[2]!;
    let withheld: Uint8Array<ArrayBuffer> | null = null;
    const original = server.rewritePost;
    server.rewritePost = async (who, entry) => {
      if (who === victim.name && entry.kind === 'group' && !withheld) {
        const [event] = await decodeAll(victim.client, [{ seq: 0, kind: 'group', body: entry.body, visibleAt: null }]);
        if (event?.t === 'slip') {
          withheld = entry.body;
          return [];
        }
      }
      return original(who, entry);
    };

    await startDraw(players);
    await settle(server, players);
    expect(withheld).not.toBeNull();

    expect(await eventsOfType(players, 'ready')).toHaveLength(0);
    expect(await eventsOfType(players, 'abort')).toHaveLength(0);
    for (const { client } of players) {
      expect(client.state.current!.stage).toBe('slips');
      expect(client.target).toBeNull();
    }

    await server.transport('server').post({ kind: 'group', body: withheld!, held: false });
    await settle(server, players);
    expect(await eventsOfType(players, 'ready')).toHaveLength(5);
    assertOneCircle(players);
  });

  it('polling does not change with what a phone privately knows', async () => {
    const players = await drawnRound(server, 5);
    const sender = players[0]!;
    await sender.client.sendCard('lunch', '100', NOW);
    server.polls.clear();
    const putsBefore = server.backups.size;
    const posts = server.log.length;
    server.now = NOW + DAY_MS;
    await settle(server, players);
    const polls = new Set(players.map(({ name }) => server.polls.get(name)));
    expect(polls.size).toBe(1);
    expect(server.backups.size).toBe(putsBefore);
    const recipient = players.find(({ client }) => client.inbox.cards.length > 0)!;
    expect(recipient).toBeDefined();
    expect(server.log.length).toBe(posts + 1);
  });

  it('a phone does not show a slip until the whole draw is final', async () => {
    const players = await openRound(server, 4);
    const slowest = players[3]!;
    await startDraw(players);
    const others = players.slice(0, 3);
    for (let pass = 0; pass < 100; pass++) {
      for (const player of players) {
        if (player !== slowest || !player.client.local.attempt?.done.slip) await player.client.tick();
      }
    }
    for (const { client } of others) {
      expect(client.state.final).toBeNull();
      expect(client.target).toBeNull();
    }
    await settle(server, players);
    assertOneCircle(players);
  });
});

describe('the check words (F5)', () => {
  it('nobody reveals until every commitment is in', async () => {
    const players = await openRound(server, 4);
    await settle(server, players);
    await organiser(players).lock();
    const others = players.slice(0, 3);
    await settle(server, others);
    expect(await eventsOfType(players, 'checkReveal')).toHaveLength(0);
    await settle(server, players);
    expect(await eventsOfType(players, 'checkReveal')).toHaveLength(4);
  });

  it('a reveal that does not match its commitment does not count', async () => {
    const players = await openRound(server, 4);
    tamperOnce(players[1]!, 'checkReveal', (event: EventOf<'checkReveal'>) => ({
      ...event,
      nonce: toB64(randomBytes(32)),
    }));
    await lockAndCheck(server, players);
    expect(organiser(players).state.check!.words).toBeNull();
    expect(organiser(players).state.check!.waitingOn).toEqual([players[1]!.client.local.fp]);
  });

  it('a removal draws fresh words, so removing people gives no free retries', async () => {
    const players = await openRound(server, 5);
    await lockAndCheck(server, players);
    const firstNonces = (await eventsOfType(players, 'checkReveal')).map((event) => event.nonce);
    const firstWords = organiser(players).state.check!.checkHash;
    await organiser(players).remove(players[4]!.client.local.fp);
    await settle(server, players.slice(0, 4));
    const allNonces = (await eventsOfType(players, 'checkReveal')).map((event) => event.nonce);
    expect(new Set(allNonces).size).toBe(firstNonces.length + 4);
    expect(organiser(players).state.check!.checkHash).not.toBe(firstWords);
    expect(organiser(players).state.check!.version).toBe(1);
  });

  it('a removal cannot reopen the check once the words are agreed', async () => {
    const players = await openRound(server, 5);
    await lockAndCheck(server, players);
    const client = organiser(players);
    const agreed = client.state.check!.checkHash;
    await client.confirmMatch();
    const event = await signEvent(client.local.identity.privateKey, {
      t: 'remove' as const,
      r: client.local.roundId,
      index: 0,
      target: players[4]!.client.local.fp,
      a: 0,
    });
    const body = await encryptGroupEvent(client.secrets.groupKey, client.local.roundId, event);
    await server.transport('P0').post({ kind: 'group', body, held: false });
    await settle(server, players);
    expect(client.state.check!.checkHash).toBe(agreed);
    assertOneCircle(players);
  });

  it('a phone in a different world rejects the organiser\'s confirmation', async () => {
    const players = await openRound(server, 4);
    await lockAndCheck(server, players);
    const client = organiser(players);
    const event = await signEvent(client.local.identity.privateKey, {
      t: 'match' as const,
      r: client.local.roundId,
      checkHash: toB64(randomBytes(32)),
    });
    const body = await encryptGroupEvent(client.secrets.groupKey, client.local.roundId, event);
    await server.transport('P0').post({ kind: 'group', body, held: false });
    await settle(server, players);
    expect(client.state.matched).toBe(false);
  });
});

describe('impersonation', () => {
  it('a second player cannot take an existing nickname', async () => {
    const players = await openRound(server, 4);
    const { PlayerClient } = await import('./client.js');
    const { MemoryStore } = await import('./testing/harness.js');
    const client = organiser(players);
    const copycat = await PlayerClient.join(
      client.local.roundId,
      client.local.inviteSecret,
      'p1',
      'cat',
      () => server.transport('copycat'),
      new MemoryStore(),
    );
    await settle(server, players);
    expect(client.state.joined.map((player) => player.nickname)).toEqual(['P0', 'P1', 'P2', 'P3']);
    expect(copycat.membership).toBe('waiting');
  });

  it('a slip cannot name someone else', async () => {
    const players = await openRound(server, 4);
    const cheat = players[1]!;
    const framed = players[2]!;
    let used = false;
    tamperWith(server, cheat, async (event) => {
      if (event.t !== 'slip' || used) return event;
      used = true;
      const view = cheat.client.state.current!;
      const attempt = cheat.client.local.attempt!;
      const own = toB64(attempt.box.ecdsa.publicRaw);
      const position = view.circle!.findIndex((box) => box.ecdsa === own);
      const giver = view.circle![(position + view.circle!.length - 1) % view.circle!.length]!;
      const fake = await signBoth(cheat.client.local.identity.privateKey, attempt.box.ecdsa.privateKey, {
        t: 'slip' as const,
        r: cheat.client.local.roundId,
        a: view.number,
        circle: view.circleHash!,
        fp: framed.client.local.fp,
        box: own,
      });
      const sealed = await sealParcel(giver.ecdh, cheat.client.local.roundId, fake);
      return { ...event, parcel: toB64(sealed) };
    });
    await startDraw(players);
    await settle(server, players);
    expect(firstAttempt(players).death).toBe('abort');
    const aborts = await eventsOfType(players, 'abort');
    expect(aborts.map((event) => event.why)).toContain('bad-slip');
    assertOneCircle(players);
  });

  it('a reveal cannot claim another player\'s place', async () => {
    const players = await drawnRound(server, 4);
    const cheat = players[1]!.client;
    const victim = players[2]!.client;
    const statement = await signBoth(
      cheat.local.identity.privateKey,
      cheat.local.attempt!.box.ecdsa.privateKey,
      {
        t: 'reveal' as const,
        r: cheat.local.roundId,
        a: cheat.state.final!.number,
        from: victim.local.fp,
        box: toB64(cheat.local.attempt!.box.ecdsa.publicRaw),
      },
    );
    const body = await encryptGroupEvent(cheat.secrets.groupKey, cheat.local.roundId, statement);
    await server.transport('P1').post({ kind: 'group', body, held: false });
    await settle(server, players);
    expect(organiser(players).state.reveals).toEqual([]);
  });

  it('only the organiser can lock', async () => {
    const players = await openRound(server, 4);
    await settle(server, players);
    await players[1]!.client.lock();
    await settle(server, players);
    expect(organiser(players).state.locked).toBe(false);
  });

  it('nobody can enter after the lock', async () => {
    const players = await openRound(server, 4);
    await lockAndCheck(server, players);
    const { PlayerClient } = await import('./client.js');
    const { MemoryStore } = await import('./testing/harness.js');
    const client = organiser(players);
    const late = await PlayerClient.join(
      client.local.roundId,
      client.local.inviteSecret,
      'Late',
      'cat',
      () => server.transport('late'),
      new MemoryStore(),
    );
    await settle(server, players);
    expect(client.state.roster).toHaveLength(4);
    expect(late.membership).toBe('left-out');
  });
});

describe('cards', () => {
  async function forgeCardTo(sender: SimPlayer, recipientEcdh: string): Promise<void> {
    const { client } = sender;
    const fields = {
      t: 'card' as const,
      r: client.local.roundId,
      a: client.state.final!.number,
      id: toB64(randomBytes(16)),
      card: 'smile' as const,
      amount: '100',
    };
    const parcel: Parcel = {
      ...fields,
      sig: await signFields(client.local.attempt!.box.ecdsa.privateKey, 'box', 'card', fields),
    };
    const body = await sealParcel(recipientEcdh, client.local.roundId, parcel);
    await server.transport(sender.name).post({ kind: 'sealed', body, held: false });
  }

  it('a card from any key but the giver\'s is refused', async () => {
    const players = await drawnRound(server, 5);
    const recipient = players[0]!.client;
    const circle = recipient.state.final!.circle!;
    const position = recipient.position!;
    const giverEcdsa = circle[(position + circle.length - 1) % circle.length]!.ecdsa;
    const stranger = players.find(
      ({ client }) => client !== recipient && toB64(client.local.attempt!.box.ecdsa.publicRaw) !== giverEcdsa,
    )!;
    await forgeCardTo(stranger, circle[position]!.ecdh);
    await settle(server, players);
    expect(recipient.inbox.cards).toEqual([]);
  });

  it('a card from the giver is accepted, and reaches nobody else', async () => {
    const players = await drawnRound(server, 5);
    const sender = players[0]!;
    await sender.client.sendCard('coffee', '500', NOW);
    server.now = NOW + DAY_MS;
    await settle(server, players);
    const receivers = players.filter(({ client }) => client.inbox.cards.length > 0);
    expect(receivers).toHaveLength(1);
    expect(receivers[0]!.client.local.fp).toBe(sender.client.target!.fp);
    expect(receivers[0]!.client.inbox.cards[0]).toMatchObject({ card: 'coffee', amount: '500' });
  });

  it('a replayed card cannot double a promise (F10)', async () => {
    const players = await drawnRound(server, 4);
    const sender = players[0]!;
    await sender.client.sendCard('lunch', '700', NOW);
    server.now = NOW + DAY_MS;
    await settle(server, players);
    const entry = server.log.filter((candidate) => candidate.kind === 'sealed').at(-1)!;
    await server.transport('server').post({ kind: 'sealed', body: entry.body, held: false });
    await settle(server, players);
    const recipient = players.find(({ client }) => client.inbox.cards.length > 0)!;
    expect(recipient.client.inbox.cards).toHaveLength(1);
  });

  it('promises past the budget are dropped by the receiver', async () => {
    const players = await drawnRound(server, 4, '100');
    const sender = players[0]!;
    const recipientFp = sender.client.target!.fp;
    const circle = sender.client.state.final!.circle!;
    const targetEcdh = circle[(sender.client.position! + 1) % circle.length]!.ecdh;
    await forgeCardTo(sender, targetEcdh);
    await forgeCardTo(sender, targetEcdh);
    await settle(server, players);
    const recipient = players.find(({ client }) => client.local.fp === recipientFp)!;
    expect(recipient.client.inbox.cards).toHaveLength(1);
  });

  it('the app refuses to send past the budget', async () => {
    const players = await drawnRound(server, 4, '100');
    const result = await players[0]!.client.sendCard('lunch', '101', NOW);
    expect(result).toMatchObject({ ok: false, refusal: 'over-budget' });
  });

  it('a card sent while offline goes out once the connection returns', async () => {
    const players = await drawnRound(server, 4);
    const sender = players[0]!;
    server.offline.add(sender.name);
    const result = await sender.client.sendCard('lunch', '100', NOW);
    expect(result).toEqual({ ok: true, arrives: null });
    expect(server.held).toHaveLength(0);
    server.offline.delete(sender.name);
    await sender.client.tick();
    expect(server.held).toHaveLength(1);
    expect(sender.client.local.sent[0]!.arrives).toBeGreaterThan(NOW);
  });
});

describe('finishing a draw', () => {
  it('a late abort cannot undo a finished draw (F11)', async () => {
    const players = await drawnRound(server, 4);
    const before = organiser(players).state.final!.circleHash;
    const cheat = players[1]!.client;
    const event = await signEvent(cheat.local.identity.privateKey, {
      t: 'abort' as const,
      r: cheat.local.roundId,
      a: cheat.state.final!.number,
      from: cheat.local.fp,
      why: 'bad-slip' as const,
    });
    const body = await encryptGroupEvent(cheat.secrets.groupKey, cheat.local.roundId, event);
    await server.transport('P1').post({ kind: 'group', body, held: false });
    await settle(server, players);
    expect(organiser(players).state.final!.circleHash).toBe(before);
  });

  it('a dropout can be removed and the draw restarts without them', async () => {
    const players = await openRound(server, 5);
    await startDraw(players);
    const dropout = players[4]!;
    const remaining = players.slice(0, 4);
    await settle(server, remaining);
    expect(organiser(players).state.current!.waitingOn).toEqual([dropout.client.local.fp]);
    await organiser(players).remove(dropout.client.local.fp);
    await settle(server, remaining);
    expect(organiser(players).state.final!.number).toBe(2);
    expect(organiser(players).state.failures).toBe(0);
    assertOneCircle(remaining);
  });

  it('nobody can be removed below four players', async () => {
    const players = await openRound(server, 4);
    await startDraw(players);
    await settle(server, players.slice(0, 3));
    await organiser(players).remove(players[3]!.client.local.fp);
    await settle(server, players);
    expect(organiser(players).state.removed).toEqual([]);
    assertOneCircle(players);
  });

  it('an organiser cannot undo a finished draw by removing someone', async () => {
    const players = await drawnRound(server, 5);
    const client = organiser(players);
    const before = client.state.final!.circleHash;
    for (const a of [0, client.state.final!.number]) {
      const event = await signEvent(client.local.identity.privateKey, {
        t: 'remove' as const,
        r: client.local.roundId,
        index: 0,
        target: players[4]!.client.local.fp,
        a,
      });
      const body = await encryptGroupEvent(client.secrets.groupKey, client.local.roundId, event);
      await server.transport('P0').post({ kind: 'group', body, held: false });
    }
    await settle(server, players);
    expect(client.state.final!.circleHash).toBe(before);
    expect(client.state.removed).toEqual([]);
  });
});

describe('reveal', () => {
  it('shows only those who chose to reveal', async () => {
    const players = await drawnRound(server, 4);
    await players[1]!.client.reveal();
    await settle(server, players);
    const reveals = organiser(players).state.reveals;
    expect(reveals.map((reveal) => reveal.fp)).toEqual([players[1]!.client.local.fp]);
    expect(reveals[0]!.position).toBe(players[1]!.client.position);
  });

  it('tells a player who looked after them once that person reveals', async () => {
    const players = await drawnRound(server, 4);
    const giver = players.find(({ client }) => client.target?.fp === organiser(players).local.fp)!;
    expect(organiser(players).giver).toBeNull();
    await giver.client.reveal();
    await settle(server, players);
    expect(organiser(players).giver?.fp).toBe(giver.client.local.fp);
  });
});

describe('settlement', () => {
  async function settledPair(): Promise<{ players: SimPlayer[]; giver: SimPlayer; target: SimPlayer }> {
    const players = await drawnRound(server, 4);
    const giver = players[0]!;
    const target = players.find(({ client }) => client.local.fp === giver.client.target!.fp)!;
    await giver.client.sendCard('coffee', '1200', NOW);
    server.now = NOW + DAY_MS;
    await settle(server, players);
    return { players, giver, target };
  }

  it('keeps promised, paid and received as three separate facts', async () => {
    const { players, giver, target } = await settledPair();
    expect(await target.client.sharePaymentDetail('lightning:someone@example.com')).toBe(true);
    await settle(server, players);
    expect(giver.client.inbox.payDetail).toBe('someone@example.com');
    expect(giver.client.promisedTotal).toBe(1200n);
    expect(giver.client.inbox.got).toBe(false);

    await giver.client.markPaid();
    await settle(server, players);
    expect(target.client.inbox.paid).toBe(true);
    expect(target.client.local.settlement.got).toBe(false);

    await target.client.confirmReceived();
    await settle(server, players);
    expect(giver.client.inbox.got).toBe(true);
  });

  it('lets the recipient clear a promise', async () => {
    const { players, giver, target } = await settledPair();
    await target.client.waivePromise();
    await settle(server, players);
    expect(giver.client.inbox.waived).toBe(true);
  });

  it('refuses free text in the payment field (F20)', async () => {
    const { target } = await settledPair();
    expect(await target.client.sharePaymentDetail('you are mean, go away')).toBe(false);
    expect(await target.client.sharePaymentDetail('see you at lunch!')).toBe(false);
  });

  it('a receiver drops a malformed payment detail from a modified client', async () => {
    const { players, giver, target } = await settledPair();
    const { client } = target;
    const fields = {
      t: 'pay',
      r: client.local.roundId,
      a: client.state.final!.number,
      id: toB64(randomBytes(16)),
      detail: 'you are mean',
    };
    const parcel = {
      ...fields,
      sig: await signFields(client.local.attempt!.box.ecdsa.privateKey, 'box', 'pay', fields),
    } as Parcel;
    const circle = client.state.final!.circle!;
    const giverEcdh = circle[(client.position! + circle.length - 1) % circle.length]!.ecdh;
    const body = await sealParcel(giverEcdh, client.local.roundId, parcel);
    await server.transport(target.name).post({ kind: 'sealed', body, held: false });
    await settle(server, players);
    expect(giver.client.inbox.payDetail).toBeNull();
  });
});
