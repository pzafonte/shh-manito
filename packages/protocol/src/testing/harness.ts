import { PlayerClient, type NewRoundOptions, type PlayerStore } from '../client.js';
import type { Bytes } from '../bytes.js';
import { STICKER_IDS } from '../catalog.js';
import { decryptGroupEvent, encryptGroupEvent } from '../envelopes.js';
import { signEvent, withoutSignatures, type GroupEvent } from '../events.js';
import { foldLog, type LogEntry } from '../fold.js';
import type { LocalPlayer } from '../local.js';
import { nextMailTime } from '../mailtime.js';
import { OfflineError, type NewEntry, type Schedule, type Transport } from '../transport.js';

export const NOW = Date.UTC(2026, 10, 2, 1, 0);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SETTLE_PASSES = 400;

export const ROUND_OPTIONS: Omit<NewRoundOptions, 'nickname' | 'sticker'> = {
  name: 'Test Round',
  revealAt: NOW + WEEK_MS,
  timeZone: 'Asia/Seoul',
  mailTimes: ['09:00', '12:00', '18:00'],
  budget: '5000',
};

type PostRewrite = (who: string, entry: NewEntry) => Promise<NewEntry[]>;
type ViewRewrite = (who: string, entries: LogEntry[]) => LogEntry[];

// Stands in for the server with its behaviour exposed, so a test can play a
// hostile operator. The real server has its own tests in apps/server.
export class FakeServer {
  log: LogEntry[] = [];
  held: { body: Bytes; visibleAt: number }[] = [];
  backups = new Map<string, Bytes>();
  schedule: Schedule | null = null;
  now = NOW;
  offline = new Set<string>();
  rewritePost: PostRewrite = (_who, entry) => Promise.resolve([entry]);
  rewriteView: ViewRewrite = (_who, entries) => entries;
  polls = new Map<string, number>();
  pageSize = Number.POSITIVE_INFINITY;

  #append(kind: LogEntry['kind'], body: Bytes, visibleAt: number | null): void {
    this.log.push({ seq: this.log.length + 1, kind, body, visibleAt });
  }

  releaseMail(): void {
    const due = this.held.filter((entry) => entry.visibleAt <= this.now);
    this.held = this.held.filter((entry) => entry.visibleAt > this.now);
    for (const entry of due) this.#append('sealed', entry.body, entry.visibleAt);
  }

  transport(who: string): Transport {
    const reachable = (): void => {
      if (this.offline.has(who)) throw new OfflineError();
    };
    return {
      createRound: async (round) => {
        reachable();
        this.schedule = { revealAt: round.revealAt, timeZone: round.timeZone, mailTimes: round.mailTimes };
      },
      post: async (entry) => {
        reachable();
        let visibleAt: number | null = null;
        for (const posted of await this.rewritePost(who, entry)) {
          if (posted.held) {
            visibleAt = nextMailTime(this.now, this.schedule!.mailTimes, this.schedule!.timeZone);
            this.held.push({ body: posted.body, visibleAt });
          } else {
            this.#append(posted.kind, posted.body, null);
          }
        }
        return { visibleAt };
      },
      fetchSince: async (after) => {
        reachable();
        this.polls.set(who, (this.polls.get(who) ?? 0) + 1);
        this.releaseMail();
        const entries = this.rewriteView(who, this.log).filter((entry) => entry.seq > after);
        return { schedule: this.schedule!, entries: entries.slice(0, this.pageSize), more: entries.length > this.pageSize };
      },
      putBackup: async (handle, blob) => {
        reachable();
        this.backups.set(handle, blob);
      },
      getBackup: async (handle) => {
        reachable();
        return this.backups.get(handle) ?? null;
      },
    };
  }
}

export class MemoryStore implements PlayerStore {
  snapshot: LocalPlayer | null = null;

  async save(local: LocalPlayer): Promise<void> {
    this.snapshot = structuredClone(local);
  }
}

export interface SimPlayer {
  name: string;
  client: PlayerClient;
  store: MemoryStore;
}

export async function openRound(server: FakeServer, count: number, budget = '5000'): Promise<SimPlayer[]> {
  const organiserStore = new MemoryStore();
  const organiser = await PlayerClient.create(
    { ...ROUND_OPTIONS, budget, nickname: 'P0', sticker: STICKER_IDS[0] },
    () => server.transport('P0'),
    organiserStore,
  );
  const players: SimPlayer[] = [{ name: 'P0', client: organiser, store: organiserStore }];
  for (let index = 1; index < count; index++) {
    const name = `P${index}`;
    const store = new MemoryStore();
    const client = await PlayerClient.join(
      organiser.local.roundId,
      organiser.local.inviteSecret,
      name,
      STICKER_IDS[index % STICKER_IDS.length]!,
      () => server.transport(name),
      store,
    );
    players.push({ name, client, store });
  }
  return players;
}

// Ticks every player until a full pass adds nothing to the log.
export async function settle(server: FakeServer, players: readonly SimPlayer[]): Promise<void> {
  for (let pass = 0; pass < MAX_SETTLE_PASSES; pass++) {
    const before = server.log.length;
    for (const player of players) await player.client.tick();
    if (server.log.length === before) {
      for (const player of players) await player.client.tick();
      if (server.log.length === before) return;
    }
  }
  throw new Error('Round did not settle');
}

export async function lockAndCheck(server: FakeServer, players: readonly SimPlayer[]): Promise<void> {
  await settle(server, players);
  await players[0]!.client.lock();
  await settle(server, players);
}

export async function drawnRound(server: FakeServer, count: number, budget = '5000'): Promise<SimPlayer[]> {
  const players = await openRound(server, count, budget);
  await lockAndCheck(server, players);
  await players[0]!.client.confirmMatch();
  await settle(server, players);
  return players;
}

export function organiser(players: readonly SimPlayer[]): PlayerClient {
  return players[0]!.client;
}

export async function decodeAll(client: PlayerClient, log: readonly LogEntry[]): Promise<GroupEvent[]> {
  const events: GroupEvent[] = [];
  for (const entry of log) {
    if (entry.kind !== 'group') continue;
    const event = await decryptGroupEvent(client.secrets.groupKey, client.local.roundId, entry.body);
    if (event) events.push(event);
  }
  return events;
}

export function fold(client: PlayerClient, log: readonly LogEntry[]): ReturnType<typeof foldLog> {
  return foldLog(client.local.roundId, client.secrets.groupKey, log);
}

// Lets a test rewrite what one player posts, re-signing with that player's real
// identity key. This is what a malicious client can do, and no more.
export function tamperWith(
  server: FakeServer,
  player: SimPlayer,
  rewrite: (event: GroupEvent) => GroupEvent | Promise<GroupEvent>,
): void {
  const previous = server.rewritePost;
  const { client } = player;
  server.rewritePost = async (who, entry) => {
    if (who !== player.name || entry.kind !== 'group') return previous(who, entry);
    const event = await decryptGroupEvent(client.secrets.groupKey, client.local.roundId, entry.body);
    if (!event) return previous(who, entry);
    const changed = await rewrite(event);
    if (changed === event) return previous(who, entry);
    const fields = withoutSignatures(changed) as GroupEvent;
    const signed = await signEvent(client.local.identity.privateKey, fields);
    const body = await encryptGroupEvent(client.secrets.groupKey, client.local.roundId, signed as GroupEvent);
    return previous(who, { ...entry, body });
  };
}

export function targetsByPlayer(players: readonly SimPlayer[]): Map<string, string> {
  return new Map(players.map(({ client }) => [client.local.fp, client.target?.fp ?? '']));
}

export function assertOneCircle(players: readonly SimPlayer[]): void {
  const targets = targetsByPlayer(players);
  const start = players[0]!.client.local.fp;
  const visited = new Set<string>();
  let current = start;
  do {
    if (visited.has(current)) throw new Error('Not a single circle');
    visited.add(current);
    const next = targets.get(current);
    if (!next) throw new Error('A player has no target');
    if (next === current) throw new Error('A player drew themselves');
    current = next;
  } while (current !== start);
  if (visited.size !== players.length) throw new Error('Circle does not include everyone');
}

export function sealedBodies(log: readonly LogEntry[]): Bytes[] {
  return log.filter((entry) => entry.kind === 'sealed').map((entry) => entry.body);
}
