import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  httpTransport,
  PlayerClient,
  STICKER_IDS,
  type LocalPlayer,
  type NewRoundOptions,
  type PlayerStore,
  type Transport,
} from '@shh-manito/protocol';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { Clock } from '../src/clock.js';
import { openDatabase, type Db } from '../src/db.js';
import type { RoundStore } from '../src/rounds.js';

export const SEOUL = 'Asia/Seoul';
// Tuesday 2026-11-03 10:00 in Seoul.
export const START = Date.UTC(2026, 10, 3, 1, 0);
export const DAY_MS = 24 * 60 * 60 * 1000;
export const MAIL_TIMES = ['09:00', '12:00', '18:00'];
const MAX_SETTLE_PASSES = 500;

export class TestClock implements Clock {
  current = START;

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

export interface CapturedRequest {
  method: string;
  url: string;
  body: string;
}

export interface TestServer {
  app: FastifyInstance;
  db: Db;
  dbPath: string;
  store: RoundStore;
  clock: TestClock;
  baseUrl: string;
  requests: CapturedRequest[];
  logs: string[];
  close(): Promise<void>;
}

// Runs the real app over real HTTP, with a real file database so a test can read
// exactly what an operator would find on disk.
export async function startServer(): Promise<TestServer> {
  const directory = mkdtempSync(join(tmpdir(), 'shh-manito-'));
  const dbPath = join(directory, 'test.sqlite');
  const db = openDatabase(dbPath);
  const clock = new TestClock();
  const logs: string[] = [];
  const { app, store } = await buildApp({
    db,
    clock,
    logStream: { write: (line) => void logs.push(line) },
    webRoot: join(directory, 'no-web'),
  });

  const requests: CapturedRequest[] = [];
  app.addHook('preValidation', async (request) => {
    requests.push({
      method: request.method,
      url: request.url,
      body: request.body === undefined ? '' : JSON.stringify(request.body),
    });
  });

  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('No port');

  return {
    app,
    db,
    dbPath,
    store,
    clock,
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    logs,
    close: async () => {
      await app.close();
      db.close();
      if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
    },
  };
}

class NoStore implements PlayerStore {
  async save(_local: LocalPlayer): Promise<void> {}
}

export interface HttpPlayer {
  name: string;
  client: PlayerClient;
}

export function transportFor(server: TestServer): (roundId: string, token: string) => Transport {
  return (roundId, token) => httpTransport(server.baseUrl, roundId, token);
}

export function defaultRound(nickname: string, budget = '5000'): NewRoundOptions {
  return {
    name: 'Floor 3 Snack Club',
    revealAt: START + 3 * DAY_MS,
    timeZone: SEOUL,
    mailTimes: MAIL_TIMES,
    budget,
    nickname,
    sticker: STICKER_IDS[0],
  };
}

export async function gather(server: TestServer, names: readonly string[], budget = '5000'): Promise<HttpPlayer[]> {
  const makeTransport = transportFor(server);
  const organiser = await PlayerClient.create(defaultRound(names[0]!, budget), makeTransport, new NoStore());
  const players: HttpPlayer[] = [{ name: names[0]!, client: organiser }];
  for (const [index, name] of names.slice(1).entries()) {
    const client = await PlayerClient.join(
      organiser.local.roundId,
      organiser.local.inviteSecret,
      name,
      STICKER_IDS[(index + 1) % STICKER_IDS.length]!,
      makeTransport,
      new NoStore(),
    );
    players.push({ name, client });
  }
  return players;
}

function logLength(server: TestServer, roundId: string): number {
  return server.store.find(roundId)?.entryCount ?? 0;
}

export async function settle(server: TestServer, players: readonly HttpPlayer[]): Promise<void> {
  const { roundId } = players[0]!.client.local;
  for (let pass = 0; pass < MAX_SETTLE_PASSES; pass++) {
    const before = logLength(server, roundId);
    await Promise.all(players.map(({ client }) => client.tick()));
    if (logLength(server, roundId) === before) {
      await Promise.all(players.map(({ client }) => client.tick()));
      if (logLength(server, roundId) === before) return;
    }
  }
  throw new Error('Round did not settle');
}

export async function runDraw(server: TestServer, players: readonly HttpPlayer[]): Promise<void> {
  await settle(server, players);
  await players[0]!.client.lock();
  await settle(server, players);
  await players[0]!.client.confirmMatch();
  await settle(server, players);
}

export function assertSingleCircle(players: readonly HttpPlayer[]): void {
  const targets = new Map(players.map(({ client }) => [client.local.fp, client.target?.fp]));
  const start = players[0]!.client.local.fp;
  const visited = new Set<string>();
  let current: string | undefined = start;
  do {
    if (!current || visited.has(current)) throw new Error('Not a single circle');
    visited.add(current);
    const next = targets.get(current);
    if (next === current) throw new Error('A player drew themselves');
    current = next;
  } while (current !== start);
  if (visited.size !== players.length) throw new Error('Circle does not include everyone');
}
