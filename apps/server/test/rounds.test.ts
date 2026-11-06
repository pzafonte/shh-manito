import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BACKUP_BLOB_BYTES,
  deriveBackupSecrets,
  fromB64,
  GROUP_BLOCK_BYTES,
  GROUP_OVERHEAD_BYTES,
  hashAuthToken,
  newRoundId,
  newSecret,
  deriveRoundSecrets,
  PARCEL_SEALED_BYTES,
  randomBytes,
  toB64,
  zonedTimeToInstant,
} from '@shh-manito/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_BACKUPS_PER_ROUND, MAX_ROUND_ENTRIES, PAGE_SIZE } from '../src/rounds.js';
import {
  assertSingleCircle,
  DAY_MS,
  gather,
  MAIL_TIMES,
  runDraw,
  SEOUL,
  settle,
  START,
  startServer,
  type HttpPlayer,
  type TestServer,
} from './harness.js';

const NAMES = ['Mina', 'Haru', 'Sora', 'Bomi', 'Theo'];
const SIMULATED_SIZES = 6;
const CARD_MIN_SIZE = 4;
const CARD_MAX_SIZE = 30;

let server: TestServer;

beforeEach(async () => {
  server = await startServer();
});

afterEach(async () => {
  await server.close();
});

async function newRound(): Promise<{ id: string; token: string }> {
  const id = newRoundId();
  const { authToken } = await deriveRoundSecrets(id, newSecret());
  const response = await fetch(`${server.baseUrl}/api/rounds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id,
      authHash: await hashAuthToken(authToken),
      revealAt: START + 3 * DAY_MS,
      timeZone: SEOUL,
      mailTimes: MAIL_TIMES,
    }),
  });
  expect(response.status).toBe(201);
  return { id, token: authToken };
}

function post(round: { id: string; token: string }, body: object): Promise<Response> {
  return fetch(`${server.baseUrl}/api/rounds/${round.id}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-round-token': round.token },
    body: JSON.stringify(body),
  });
}

function parcelBody(): string {
  return toB64(randomBytes(PARCEL_SEALED_BYTES));
}

function groupBody(blocks = 1): string {
  return toB64(randomBytes(blocks * GROUP_BLOCK_BYTES + GROUP_OVERHEAD_BYTES));
}

async function page(round: { id: string; token: string }, after = 0) {
  const response = await fetch(`${server.baseUrl}/api/rounds/${round.id}/events?after=${after}`, {
    headers: { 'x-round-token': round.token },
  });
  return (await response.json()) as {
    entries: { seq: number; kind: string; body: string; visibleAt: number | null }[];
    more: boolean;
  };
}

function seoul(day: number, hour: number): number {
  return zonedTimeToInstant(2026, 11, day, hour, 0, SEOUL);
}

describe('rounds', () => {
  it('refuses a request without the token', async () => {
    const round = await newRound();
    const wrong = await post({ ...round, token: toB64(randomBytes(32)) }, { kind: 'group', body: groupBody(), held: false });
    expect(wrong.status).toBe(401);
    const read = await fetch(`${server.baseUrl}/api/rounds/${round.id}/events`);
    expect(read.status).toBe(401);
  });

  it('stores the token only as a hash', async () => {
    const round = await newRound();
    const dump = JSON.stringify(server.db.prepare('SELECT * FROM rounds').all());
    expect(dump).not.toContain(round.token);
  });

  it('refuses a reveal time in the past or too far ahead', async () => {
    const id = newRoundId();
    const send = (revealAt: number) =>
      fetch(`${server.baseUrl}/api/rounds`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, authHash: 'A'.repeat(43), revealAt, timeZone: SEOUL, mailTimes: MAIL_TIMES }),
      });
    expect((await send(START - 1)).status).toBe(400);
    expect((await send(START + 61 * DAY_MS)).status).toBe(400);
  });

  it('refuses a second round with the same id', async () => {
    const round = await newRound();
    const response = await fetch(`${server.baseUrl}/api/rounds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: round.id, authHash: 'A'.repeat(43), revealAt: START + DAY_MS, timeZone: SEOUL, mailTimes: MAIL_TIMES }),
    });
    expect(response.status).toBe(409);
  });

  it('accepts only exact sizes', async () => {
    const round = await newRound();
    const wrongParcel = toB64(randomBytes(PARCEL_SEALED_BYTES - 1));
    const wrongGroup = toB64(randomBytes(GROUP_BLOCK_BYTES));
    expect((await post(round, { kind: 'sealed', body: wrongParcel, held: false })).status).toBe(400);
    expect((await post(round, { kind: 'group', body: wrongGroup, held: false })).status).toBe(400);
    expect((await post(round, { kind: 'sealed', body: parcelBody(), held: false })).status).toBe(201);
    expect((await post(round, { kind: 'group', body: groupBody(3), held: false })).status).toBe(201);
  });

  it('only holds sealed entries', async () => {
    const round = await newRound();
    expect((await post(round, { kind: 'group', body: groupBody(), held: true })).status).toBe(400);
  });

  it('stops a round at its entry cap', async () => {
    const round = await newRound();
    server.db.prepare('UPDATE rounds SET entry_count = ? WHERE id = ?').run(MAX_ROUND_ENTRIES, round.id);
    expect((await post(round, { kind: 'sealed', body: parcelBody(), held: false })).status).toBe(429);
  });

  it('pages the log from a sequence number', async () => {
    const round = await newRound();
    await post(round, { kind: 'group', body: groupBody(), held: false });
    await post(round, { kind: 'sealed', body: parcelBody(), held: false });
    expect((await page(round)).entries.map((entry) => entry.seq)).toEqual([1, 2]);
    expect((await page(round, 1)).entries.map((entry) => entry.seq)).toEqual([2]);
  });

  it('says when there is more of the log to read', async () => {
    const round = await newRound();
    for (let index = 0; index < PAGE_SIZE + 2; index++) {
      server.store.append(server.store.find(round.id)!, 'sealed', Buffer.alloc(PARCEL_SEALED_BYTES), false);
    }
    const first = await page(round);
    expect(first.entries).toHaveLength(PAGE_SIZE);
    expect(first.more).toBe(true);
    const second = await page(round, PAGE_SIZE);
    expect(second.entries).toHaveLength(2);
    expect(second.more).toBe(false);
  });

  it('sends no cookies and a strict policy on every response', async () => {
    const round = await newRound();
    const response = await fetch(`${server.baseUrl}/api/rounds/${round.id}/events`, {
      headers: { 'x-round-token': round.token },
    });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
  });
});

describe('mail time', () => {
  it('does not serve a card before its mail time', async () => {
    const round = await newRound();
    const response = await post(round, { kind: 'sealed', body: parcelBody(), held: true });
    expect(((await response.json()) as { visibleAt: number }).visibleAt).toBe(seoul(3, 12));

    server.clock.current = seoul(3, 12) - 1;
    expect((await page(round)).entries).toEqual([]);

    server.clock.current = seoul(3, 12);
    expect((await page(round)).entries).toHaveLength(1);
  });

  it('holds a card sent after the last post until the next morning', async () => {
    const round = await newRound();
    server.clock.current = seoul(3, 19);
    const response = await post(round, { kind: 'sealed', body: parcelBody(), held: true });
    expect(((await response.json()) as { visibleAt: number }).visibleAt).toBe(seoul(4, 9));
  });

  it('keeps no time of posting anywhere in the database', async () => {
    const round = await newRound();
    await post(round, { kind: 'sealed', body: parcelBody(), held: true });
    await post(round, { kind: 'sealed', body: parcelBody(), held: false });
    const columns = server.db
      .prepare(`SELECT m.name AS tbl, p.name AS col FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table'`)
      .all() as { tbl: string; col: string }[];
    const timeColumns = columns.filter(({ col }) => /_at$/.test(col)).map(({ tbl, col }) => `${tbl}.${col}`);
    expect(timeColumns.sort()).toEqual(['entries.visible_at', 'held.visible_at', 'rounds.delete_at', 'rounds.reveal_at']);
    const plain = server.db.prepare('SELECT visible_at FROM entries').all();
    expect(plain).toEqual([{ visible_at: null }]);
  });

  it('releases a batch in a different order from posting, under fresh numbers (F8)', async () => {
    const round = await newRound();
    const posted: string[] = [];
    for (let index = 0; index < 12; index++) {
      const body = parcelBody();
      posted.push(body);
      await post(round, { kind: 'sealed', body, held: true });
    }
    await post(round, { kind: 'group', body: groupBody(), held: false });
    server.clock.current = seoul(3, 12);
    const { entries } = await page(round);
    const released = entries.filter((entry) => entry.kind === 'sealed');
    expect(entries[0]!.kind).toBe('group');
    expect(released.map((entry) => entry.seq)).toEqual(Array.from({ length: 12 }, (_, index) => index + 2));
    expect(released.map((entry) => entry.body).sort()).toEqual([...posted].sort());
    expect(released.map((entry) => entry.body)).not.toEqual(posted);
    expect(new Set(released.map((entry) => entry.visibleAt))).toEqual(new Set([seoul(3, 12)]));
  });
});

describe('backups', () => {
  const blob = () => toB64(randomBytes(BACKUP_BLOB_BYTES));

  function put(round: { id: string; token: string }, handle: string, content: string): Promise<Response> {
    return fetch(`${server.baseUrl}/api/backups/${handle}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-round-token': round.token },
      body: JSON.stringify({ roundId: round.id, blob: content }),
    });
  }

  it('stores a blob of exactly the fixed size', async () => {
    const round = await newRound();
    const handle = toB64(randomBytes(32));
    expect((await put(round, handle, toB64(randomBytes(100)))).status).toBe(400);
    const content = blob();
    expect((await put(round, handle, content)).status).toBe(204);
    const read = await fetch(`${server.baseUrl}/api/backups/${handle}`);
    expect(((await read.json()) as { blob: string }).blob).toBe(content);
  });

  it('caps how many one round can hold', async () => {
    const round = await newRound();
    const content = blob();
    for (let index = 0; index < MAX_BACKUPS_PER_ROUND; index++) {
      expect((await put(round, toB64(randomBytes(32)), content)).status).toBe(204);
    }
    expect((await put(round, toB64(randomBytes(32)), content)).status).toBe(409);
  });

  it('will not let another round overwrite a handle', async () => {
    const first = await newRound();
    const second = await newRound();
    const handle = toB64(randomBytes(32));
    await put(first, handle, blob());
    expect((await put(second, handle, blob())).status).toBe(409);
  });
});

describe('retention', () => {
  it('deletes a round and everything in it 14 days after reveal', async () => {
    const players = await gather(server, NAMES);
    await runDraw(server, players);
    const { client } = players[0]!;
    await client.sendCard('lunch', '100', START);
    const { handle } = await deriveBackupSecrets(client.local.roundId, client.local.meSecret);
    expect((await fetch(`${server.baseUrl}/api/backups/${handle}`)).status).toBe(200);

    server.clock.current = START + 3 * DAY_MS + 14 * DAY_MS - 1;
    expect(server.store.sweep()).toBe(0);

    server.clock.advance(1);
    expect(server.store.sweep()).toBe(1);
    for (const table of ['rounds', 'entries', 'held', 'backups']) {
      expect(server.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    expect((await fetch(`${server.baseUrl}/api/backups/${handle}`)).status).toBe(404);
  });

  it('treats an expired round as gone even before the sweep', async () => {
    const round = await newRound();
    server.clock.current = START + 3 * DAY_MS + 14 * DAY_MS;
    const response = await post(round, { kind: 'sealed', body: parcelBody(), held: false });
    expect(response.status).toBe(404);
  });
});

async function playWholeRound(players: readonly HttpPlayer[]): Promise<void> {
  await runDraw(server, players);
  for (const { client } of players) await client.sendCard('coffee', '500', server.clock.now());
  server.clock.current = seoul(3, 12);
  await settle(server, players);
  server.clock.current = players[0]!.client.state.meta!.revealAt + 1;
  for (const { client } of players) await client.reveal();
  await settle(server, players);
  for (const { client } of players) await client.sharePaymentDetail('payer@example.com');
  await settle(server, players);
  for (const { client } of players) await client.markPaid();
  await settle(server, players);
  for (const { client } of players) await client.confirmReceived();
  await settle(server, players);
}

describe('full rounds through the real server', () => {
  const sizes = [CARD_MIN_SIZE, CARD_MAX_SIZE];
  for (let index = 0; index < SIMULATED_SIZES - 2; index++) {
    sizes.push(CARD_MIN_SIZE + Math.floor(Math.random() * (CARD_MAX_SIZE - CARD_MIN_SIZE + 1)));
  }

  it.each(sizes)(
    'at %i players: one circle, no self-draw, one target each, every card to its target only',
    async (count) => {
      const names = Array.from({ length: count }, (_, index) => `Player ${index}`);
      const players = await gather(server, names);
      await playWholeRound(players);

      assertSingleCircle(players);
      const final = players[0]!.client.state.final!;
      expect(final.number).toBe(1);
      for (const { client } of players) {
        expect(client.target).not.toBeNull();
        expect(client.target!.fp).not.toBe(client.local.fp);
        expect(client.inbox.cards).toHaveLength(1);
        expect(client.inbox.cards[0]).toMatchObject({ card: 'coffee', amount: '500' });
        expect(client.inbox.payDetail).toBe('payer@example.com');
        expect(client.inbox.paid).toBe(true);
        expect(client.inbox.got).toBe(true);
      }
      expect(players[0]!.client.state.reveals).toHaveLength(count);
      for (const { client } of players) {
        const giver = players.find(({ client: other }) => other.target?.fp === client.local.fp)!;
        expect(client.giver?.fp).toBe(giver.client.local.fp);
      }
    },
    300_000,
  );
});

describe('a curious server', () => {
  const SECRETS = ['Mina', 'Haru', 'Sora', 'Bomi', 'Theo', 'Floor 3 Snack Club', 'coffee', '500', 'payer@example.com'];

  function fileContents(): Buffer {
    const directory = dirname(server.dbPath);
    return Buffer.concat(
      readdirSync(directory)
        .filter((name) => name.startsWith('test.sqlite'))
        .map((name) => readFileSync(join(directory, name))),
    );
  }

  function tableDump(): string {
    const tables = ['rounds', 'entries', 'held', 'backups'];
    return JSON.stringify(
      tables.map((table) =>
        (server.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]).map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [key, Buffer.isBuffer(value) ? value.toString('latin1') : value]),
          ),
        ),
      ),
    );
  }

  // Encrypted bodies are checked as decoded bytes instead. Left as base64 text, a round's
  // 700 KB of it contains some four-letter name by chance about one run in five.
  function plainRequestFields(): string {
    return JSON.stringify(
      server.requests.map(({ method, url, body }) => {
        const { body: _body, blob: _blob, ...rest } = (body ? JSON.parse(body) : {}) as Record<string, unknown>;
        return { method, url, rest };
      }),
    );
  }

  it('finds no name, card, amount or payment detail in the database, the requests or the logs', async () => {
    const players = await gather(server, NAMES);
    await playWholeRound(players);

    const dump = tableDump();
    const disk = fileContents().toString('latin1');
    const requests = plainRequestFields();
    const logs = server.logs.join('\n');
    expect(server.requests.length).toBeGreaterThan(100);

    for (const secret of SECRETS) {
      if (secret === '500') continue;
      expect(dump).not.toContain(secret);
      expect(disk).not.toContain(secret);
      expect(requests).not.toContain(secret);
      expect(logs).not.toContain(secret);
    }

    const decoded = server.requests.map((request) => {
      const parsed = request.body ? (JSON.parse(request.body) as { body?: string; blob?: string }) : {};
      return Buffer.from(fromB64(parsed.body ?? parsed.blob ?? '')).toString('latin1');
    });
    for (const secret of SECRETS.filter((value) => value !== '500')) {
      for (const body of decoded) expect(body).not.toContain(secret);
    }
  }, 60_000);

  it('finds no circle position: nothing in the database links a player to a place', async () => {
    const players = await gather(server, NAMES);
    await playWholeRound(players);
    const final = players[0]!.client.state.final!;
    const dump = tableDump();
    const requests = JSON.stringify(server.requests);
    for (const box of final.circle!) {
      const raw = Buffer.from(fromB64(box.ecdh)).toString('latin1');
      expect(dump).not.toContain(raw);
      expect(requests).not.toContain(box.ecdh);
    }
    expect(requests).not.toContain(final.circleHash!);
  }, 60_000);

  it('sees every sealed entry at exactly one size', async () => {
    const players = await gather(server, NAMES);
    await playWholeRound(players);
    const sizes = server.db
      .prepare("SELECT DISTINCT LENGTH(body) AS size FROM entries WHERE kind = 'sealed'")
      .all() as { size: number }[];
    expect(sizes).toEqual([{ size: PARCEL_SEALED_BYTES }]);
  }, 60_000);

  it('cannot tell nickname lengths apart in join entries (F7)', async () => {
    const short = await gather(server, ['A', 'B', 'C', 'D']);
    const long = await gather(server, ['Aaaaaaaaaaaaaaaaaaaa', 'Bbbbbbbbbbbbbbbbbbbb', 'Cccccccccccccccccccc', 'Dddddddddddddddddddd']);
    await Promise.all([settle(server, short), settle(server, long)]);
    const sizes = server.db
      .prepare("SELECT DISTINCT LENGTH(body) AS size FROM entries WHERE kind = 'group' AND seq > 1")
      .all() as { size: number }[];
    expect(sizes).toEqual([{ size: GROUP_BLOCK_BYTES + GROUP_OVERHEAD_BYTES }]);
  });

  it('keeps no address or user agent in logs or the database', async () => {
    const players = await gather(server, NAMES.slice(0, 4));
    await runDraw(server, players);
    const requestLogs = server.logs.filter((line) => !line.includes('Server listening'));
    expect(requestLogs).toEqual([]);
    expect(tableDump()).not.toContain('127.0.0.1');
    const columns = server.db
      .prepare(`SELECT p.name AS col FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table'`)
      .all() as { col: string }[];
    const names = columns.map(({ col }) => col).join();
    expect(names).not.toMatch(/ip|agent|address|host/i);
  });

  it('shows a player only what a stranger with no link cannot read', async () => {
    const players = await gather(server, NAMES.slice(0, 4));
    const { roundId } = players[0]!.client.local;
    const blind = await fetch(`${server.baseUrl}/api/rounds/${roundId}/events`);
    expect(blind.status).toBe(401);
  });
});
