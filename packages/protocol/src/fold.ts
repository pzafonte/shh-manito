import { canon, fromB64, toB64, type Bytes } from './bytes.js';
import { normaliseNickname, type StickerId } from './catalog.js';
import { MAX_FAILED_ATTEMPTS, MAX_PLAYERS, MIN_PLAYERS } from './constants.js';
import { isValidPublicKey, tagHash, tagHashB64 } from './crypto.js';
import { decryptGroupEvent } from './envelopes.js';
import {
  verifyBoth,
  verifyEvent,
  withoutSignatures,
  type EventOf,
  type GroupEvent,
} from './events.js';
import { decodeBoxPublic, onionBytesAtLayer, type BoxPublic } from './onion.js';

const FINGERPRINT_BYTES = 16;

export interface LogEntry {
  seq: number;
  kind: 'group' | 'sealed';
  body: Bytes;
  visibleAt: number | null;
}

export interface Player {
  fp: string;
  nickname: string;
  sticker: StickerId;
  pub: string;
  joinHash: string;
}

export interface RoundMeta {
  name: string;
  revealAt: number;
  timeZone: string;
  mailTimes: string[];
  budget: string;
  organiser: string;
}

export type CheckStage = 'commit' | 'reveal' | 'done';

export interface CheckView {
  version: number;
  stage: CheckStage;
  waitingOn: string[];
  committed: string[];
  revealed: string[];
  checkHash: string | null;
  words: [number, number, number] | null;
}

export type AttemptStage =
  | 'mixkeys'
  | 'onions'
  | 'mixing'
  | 'confirming'
  | 'slips'
  | 'ready'
  | 'final'
  | 'dead';

export type DeathCause = 'abort' | 'removed' | 'fault';

export type DrawStep = 'mixkey' | 'onion' | 'mix' | 'confirm' | 'slip' | 'ready';

export interface AttemptView {
  number: number;
  players: string[];
  stage: AttemptStage;
  waitingOn: string[];
  posted: Record<DrawStep, string[]>;
  death: DeathCause | null;
  mixKeys: string[];
  mixStep: number;
  mixInput: string[] | null;
  payloads: BoxPublic[] | null;
  transcript: string | null;
  circle: BoxPublic[] | null;
  circleHash: string | null;
  slipParcels: string[] | null;
  slipsHash: string | null;
}

export interface Revealed {
  fp: string;
  position: number;
}

export interface RoundState {
  meta: RoundMeta | null;
  joined: Player[];
  locked: boolean;
  roster: Player[];
  removed: string[];
  rosterHash: string | null;
  check: CheckView | null;
  matched: boolean;
  attempts: AttemptView[];
  current: AttemptView | null;
  final: AttemptView | null;
  failures: number;
  stuck: boolean;
  reveals: Revealed[];
  rematchLink: string | null;
}

export type Phase = 'gathering' | 'checking' | 'drawing' | 'stuck' | 'playing';

export function phaseOf(state: RoundState): Phase {
  if (state.final) return 'playing';
  if (state.stuck) return 'stuck';
  if (state.matched) return 'drawing';
  return state.locked ? 'checking' : 'gathering';
}

function emptyState(): RoundState {
  return {
    meta: null,
    joined: [],
    locked: false,
    roster: [],
    removed: [],
    rosterHash: null,
    check: null,
    matched: false,
    attempts: [],
    current: null,
    final: null,
    failures: 0,
    stuck: false,
    reveals: [],
    rematchLink: null,
  };
}

export async function fingerprintOf(publicRaw: Bytes): Promise<string> {
  const digest = await tagHash('fp', publicRaw);
  return toB64(digest.slice(0, FINGERPRINT_BYTES));
}

export function joinHash(join: EventOf<'join'>): Promise<string> {
  return tagHashB64('join', canon(withoutSignatures(join)));
}

function listHash(items: readonly string[]): Promise<string> {
  return tagHashB64('list', ...items);
}

function hasDuplicates(items: readonly string[]): boolean {
  return new Set(items).size !== items.length;
}

function firstBy<T extends { from: string }>(events: readonly T[]): Map<string, T> {
  const found = new Map<string, T>();
  for (const event of events) {
    if (!found.has(event.from)) found.set(event.from, event);
  }
  return found;
}

function inRosterOrder<T>(players: readonly string[], found: Map<string, T>): T[] {
  return players.flatMap((fp) => {
    const value = found.get(fp);
    return value === undefined ? [] : [value];
  });
}

function missing(players: readonly string[], found: ReadonlyMap<string, unknown>): string[] {
  return players.filter((fp) => !found.has(fp));
}

interface Decoded {
  seq: number;
  event: GroupEvent;
}

// Decoding and signature checks repeat on every poll, so a client keeps one of
// these per round. Entries at a given sequence number never change for a client,
// because it only ever asks for what comes after the last one it saw.
export class LogFolder {
  readonly #decoded = new Map<number, Decoded | null>();
  readonly #verified = new WeakMap<object, string>();

  constructor(
    readonly roundId: string,
    readonly groupKey: CryptoKey,
  ) {}

  async #decode(entries: readonly LogEntry[]): Promise<Decoded[]> {
    const events: Decoded[] = [];
    for (const entry of entries) {
      if (entry.kind !== 'group') continue;
      if (!this.#decoded.has(entry.seq)) {
        const event = await decryptGroupEvent(this.groupKey, this.roundId, entry.body);
        this.#decoded.set(entry.seq, event && { seq: entry.seq, event });
      }
      const decoded = this.#decoded.get(entry.seq);
      if (decoded) events.push(decoded);
    }
    return events;
  }

  async signedBy(event: GroupEvent, pub: string): Promise<boolean> {
    if (this.#verified.get(event) === pub) return true;
    if (!('sig' in event)) return false;
    const ok = await verifyEvent(fromB64(pub), event);
    if (ok) this.#verified.set(event, pub);
    return ok;
  }

  async fold(entries: readonly LogEntry[]): Promise<RoundState> {
    return new Folding(this, await this.#decode(entries)).run();
  }
}

export function foldLog(roundId: string, groupKey: CryptoKey, entries: readonly LogEntry[]): Promise<RoundState> {
  return new LogFolder(roundId, groupKey).fold(entries);
}

type ClosingEvent = EventOf<'ready'> | EventOf<'abort'> | EventOf<'remove'>;

class Folding {
  readonly state = emptyState();
  readonly #byType = new Map<GroupEvent['t'], GroupEvent[]>();
  #create: EventOf<'create'> | null = null;
  readonly #joinsByFp = new Map<string, EventOf<'join'>>();
  #roster: Player[] = [];
  #rosterFps = new Set<string>();
  #removals = 0;

  constructor(
    readonly folder: LogFolder,
    readonly decoded: readonly Decoded[],
  ) {
    for (const { event } of decoded) {
      const list = this.#byType.get(event.t);
      if (list) list.push(event);
      else this.#byType.set(event.t, [event]);
    }
  }

  #all<T extends GroupEvent['t']>(type: T): EventOf<T>[] {
    return (this.#byType.get(type) ?? []) as EventOf<T>[];
  }

  #player(fp: string): Player | undefined {
    return this.#roster.find((player) => player.fp === fp);
  }

  async #fromMember<T extends { from: string } & GroupEvent>(events: readonly T[]): Promise<T[]> {
    const valid: T[] = [];
    for (const event of events) {
      const player = this.#player(event.from);
      if (player && (await this.folder.signedBy(event, player.pub))) valid.push(event);
    }
    return valid;
  }

  async #bySelf(event: EventOf<'create'> | EventOf<'join'>): Promise<boolean> {
    return (await isValidPublicKey(fromB64(event.pub))) && this.folder.signedBy(event, event.pub);
  }

  async #foldCreate(): Promise<void> {
    for (const event of this.#all('create')) {
      if (await this.#bySelf(event)) {
        this.#create = event;
        this.state.meta = {
          name: event.name,
          revealAt: event.revealAt,
          timeZone: event.timeZone,
          mailTimes: event.mailTimes,
          budget: event.budget,
          organiser: await fingerprintOf(fromB64(event.pub)),
        };
        return;
      }
    }
  }

  async #foldJoins(): Promise<void> {
    const names = new Set<string>();
    for (const event of this.#all('join')) {
      if (!(await this.#bySelf(event))) continue;
      const fp = await fingerprintOf(fromB64(event.pub));
      if (this.#joinsByFp.has(fp)) continue;
      this.#joinsByFp.set(fp, event);
      const name = normaliseNickname(event.nickname);
      if (names.has(name) || names.size >= MAX_PLAYERS) continue;
      names.add(name);
      this.state.joined.push(toPlayer(fp, event, await joinHash(event)));
    }
  }

  async #findLock(organiserPub: string): Promise<boolean> {
    for (const lock of this.#all('lock')) {
      if (!(await this.folder.signedBy(lock, organiserPub))) continue;
      const players = await this.#lockedPlayers(lock);
      if (!players) continue;
      this.state.locked = true;
      this.#roster = players;
      this.#rosterFps = new Set(players.map((player) => player.fp));
      const joins = lock.members.map(({ fp }) => canon(withoutSignatures(this.#joinsByFp.get(fp)!)));
      this.state.rosterHash = await tagHashB64(
        'roster',
        canon(withoutSignatures(this.#create!)),
        ...joins,
      );
      return true;
    }
    return false;
  }

  // A lock can name joins this client has not received yet. It stays pending
  // rather than failing, so a delayed entry cannot change the outcome.
  async #lockedPlayers(lock: EventOf<'lock'>): Promise<Player[] | null> {
    if (lock.members.length < MIN_PLAYERS || lock.members.length > MAX_PLAYERS) return null;
    const players: Player[] = [];
    for (const member of lock.members) {
      const join = this.#joinsByFp.get(member.fp);
      if (!join || (await joinHash(join)) !== member.join) return null;
      players.push(toPlayer(member.fp, join, member.join));
    }
    const fps = players.map((player) => player.fp);
    const names = players.map((player) => normaliseNickname(player.nickname));
    if (hasDuplicates(fps) || hasDuplicates(names)) return null;
    return fps.includes(this.state.meta!.organiser) ? players : null;
  }

  async #validRemovals(attempt: number): Promise<EventOf<'remove'>[]> {
    const organiserPub = this.#create!.pub;
    const valid: EventOf<'remove'>[] = [];
    for (const event of this.#all('remove')) {
      if (event.a === attempt && (await this.folder.signedBy(event, organiserPub))) valid.push(event);
    }
    return valid;
  }

  #applyRemoval(target: string): void {
    this.#removals += 1;
    this.state.removed.push(target);
    this.#roster = this.#roster.filter((player) => player.fp !== target);
    this.#rosterFps.delete(target);
  }

  #canRemove(event: EventOf<'remove'>): boolean {
    return (
      event.index === this.#removals &&
      this.#rosterFps.has(event.target) &&
      this.#roster.length - 1 >= MIN_PLAYERS
    );
  }

  // Once the words are agreed the check is over, so a removal with no attempt to
  // apply to can never reopen it. Each version is tried before the next removal.
  async #foldCheck(): Promise<void> {
    const removals = await this.#validRemovals(0);
    for (;;) {
      await this.#foldCheckVersion();
      if (this.state.matched) return;
      const next = removals.find((event) => this.#canRemove(event));
      if (!next) return;
      this.#applyRemoval(next.target);
    }
  }

  async #foldCheckVersion(): Promise<void> {
    const version = this.#removals;
    const players = this.#roster.map((player) => player.fp);
    const commits = firstBy(
      await this.#fromMember(this.#all('checkCommit').filter((event) => event.v === version)),
    );
    const check: CheckView = {
      version,
      stage: 'commit',
      waitingOn: missing(players, commits),
      committed: [...commits.keys()],
      revealed: [],
      checkHash: null,
      words: null,
    };
    this.state.check = check;
    if (check.waitingOn.length > 0) return;

    const reveals = new Map<string, EventOf<'checkReveal'>>();
    const candidates = await this.#fromMember(this.#all('checkReveal').filter((event) => event.v === version));
    for (const event of candidates) {
      if (reveals.has(event.from)) continue;
      const expected = await tagHashB64('check-commit', fromB64(event.nonce));
      if (expected === commits.get(event.from)!.commit) reveals.set(event.from, event);
    }
    check.stage = 'reveal';
    check.waitingOn = missing(players, reveals);
    check.revealed = [...reveals.keys()];
    if (check.waitingOn.length > 0) return;

    const digest = await tagHash(
      'check',
      this.state.rosterHash!,
      String(version),
      ...this.state.removed,
      ...inRosterOrder(players, reveals).map((event) => fromB64(event.nonce)),
    );
    check.stage = 'done';
    check.checkHash = toB64(digest);
    check.words = [digest[0]!, digest[1]!, digest[2]!];

    for (const match of this.#all('match')) {
      if (match.checkHash !== check.checkHash) continue;
      if (await this.folder.signedBy(match, this.#create!.pub)) {
        this.state.matched = true;
        return;
      }
    }
  }

  async #foldAttempts(): Promise<void> {
    for (let number = 1; ; number++) {
      const attempt = await this.#foldAttempt(number);
      this.state.attempts.push(attempt);
      if (attempt.stage === 'final') {
        this.state.final = attempt;
        return;
      }
      if (attempt.stage !== 'dead') {
        this.state.current = attempt;
        return;
      }
      if (attempt.death !== 'removed') this.state.failures += 1;
      if (this.state.failures >= MAX_FAILED_ATTEMPTS) {
        this.state.stuck = true;
        return;
      }
    }
  }

  async #foldAttempt(number: number): Promise<AttemptView> {
    const players = this.#roster.map((player) => player.fp);
    const view = emptyAttempt(number, players);

    const inAttempt = <T extends GroupEvent['t']>(type: T): EventOf<T>[] =>
      this.#all(type).filter((event) => 'a' in event && event.a === number);

    const closing = await this.#closingEvents(number);
    const closed = new Set<string>();
    const ready = new Map<string, EventOf<'ready'>>();
    for (const event of closing) {
      if (event.t === 'ready') {
        if (closed.has(event.from)) continue;
        closed.add(event.from);
        ready.set(event.from, event);
        if (closed.size === players.length) break;
      } else if (event.t === 'abort') {
        if (!closed.has(event.from)) {
          view.stage = 'dead';
          view.death = 'abort';
          return view;
        }
      } else if (this.#canRemove(event) && !closed.has(event.target)) {
        this.#applyRemoval(event.target);
        view.stage = 'dead';
        view.death = 'removed';
        return view;
      }
    }

    const fault = (): AttemptView => {
      view.stage = 'dead';
      view.death = 'fault';
      return view;
    };
    const waiting = (stage: AttemptStage, waitingOn: string[]): AttemptView => {
      view.stage = stage;
      view.waitingOn = waitingOn;
      return view;
    };

    const mixkeys = firstBy(await this.#fromMember(inAttempt('mixkey')));
    view.posted.mixkey = [...mixkeys.keys()];
    if (mixkeys.size < players.length) return waiting('mixkeys', missing(players, mixkeys));
    const mixKeyEvents = inRosterOrder(players, mixkeys);
    view.mixKeys = mixKeyEvents.map((event) => event.mixPub);
    if (hasDuplicates(view.mixKeys)) return fault();
    for (const key of view.mixKeys) {
      if (!(await isValidPublicKey(fromB64(key)))) return fault();
    }

    const onions = firstBy(await this.#fromMember(inAttempt('onion')));
    view.posted.onion = [...onions.keys()];
    if (onions.size < players.length) return waiting('onions', missing(players, onions));

    const count = players.length;
    let list = inRosterOrder(players, onions).map((event) => event.onion);
    if (!isValidList(list, count, 0)) return fault();
    const lists: string[][] = [];

    const mixes = firstBy(await this.#fromMember(inAttempt('mix')));
    view.posted.mix = [...mixes.keys()];
    for (let step = 0; step < count; step++) {
      const mixer = players[step]!;
      const mix = mixes.get(mixer);
      if (!mix) {
        view.mixStep = step;
        view.mixInput = list;
        return waiting('mixing', [mixer]);
      }
      if (mix.k !== step || mix.input !== (await listHash(list))) return fault();
      if (!isValidList(mix.items, count, step + 1)) return fault();
      list = mix.items;
      lists.push(list);
    }
    view.mixStep = count;

    const payloads = list.map((item) => decodeBoxPublic(fromB64(item)));
    if (hasDuplicates(payloads.map((box) => box.ecdh))) return fault();
    if (hasDuplicates(payloads.map((box) => box.ecdsa))) return fault();
    for (const box of payloads) {
      if (!(await isValidPublicKey(fromB64(box.ecdh)))) return fault();
      if (!(await isValidPublicKey(fromB64(box.ecdsa)))) return fault();
    }
    view.payloads = payloads;

    view.transcript = await tagHashB64(
      'transcript',
      this.state.rosterHash!,
      String(number),
      ...mixKeyEvents.flatMap((event) => [event.mixPub, event.seedCommit]),
      ...inRosterOrder(players, onions).map((event) => event.onion),
      ...lists.flat(),
    );

    const confirms = firstBy(await this.#fromMember(inAttempt('confirm')));
    view.posted.confirm = [...confirms.keys()];
    for (const confirm of confirms.values()) {
      if (confirm.transcript !== view.transcript) return fault();
      const commit = await tagHashB64('seed', fromB64(confirm.seed));
      if (commit !== mixkeys.get(confirm.from)!.seedCommit) return fault();
    }
    if (confirms.size < players.length) return waiting('confirming', missing(players, confirms));

    const seed = await tagHash(
      'circle-seed',
      ...inRosterOrder(players, confirms).map((event) => fromB64(event.seed)),
    );
    view.circle = await circleOrder(seed, payloads);
    view.circleHash = await tagHashB64(
      'circle',
      String(number),
      seed,
      ...view.circle.flatMap((box) => [box.ecdh, box.ecdsa]),
    );

    const slips = firstBy(await this.#fromMember(inAttempt('slip')));
    view.posted.slip = [...slips.keys()];
    if (slips.size < players.length) return waiting('slips', missing(players, slips));
    const parcels = inRosterOrder(players, slips).map((event) => event.parcel);
    if (hasDuplicates(parcels)) return fault();
    view.slipParcels = parcels;
    view.slipsHash = await tagHashB64('slips', view.circleHash, ...parcels);

    view.posted.ready = [...ready.keys()];
    for (const event of ready.values()) {
      if (event.slips !== view.slipsHash) return fault();
    }
    if (ready.size < players.length) return waiting('ready', missing(players, ready));

    view.stage = 'final';
    return view;
  }

  // Everything that can close a player's part in an attempt, in log order. The
  // first closing event for each player decides, which is what makes a final
  // attempt immune to a later abort.
  async #closingEvents(attempt: number): Promise<ClosingEvent[]> {
    const closing: ClosingEvent[] = [];
    for (const { event } of this.decoded) {
      if (event.t === 'remove') {
        if (event.a === attempt && (await this.folder.signedBy(event, this.#create!.pub))) closing.push(event);
      } else if ((event.t === 'ready' || event.t === 'abort') && event.a === attempt) {
        const player = this.#player(event.from);
        if (player && (await this.folder.signedBy(event, player.pub))) closing.push(event);
      }
    }
    return closing;
  }

  async #foldReveals(final: AttemptView): Promise<void> {
    const taken = new Set<number>();
    const seen = new Set<string>();
    for (const event of this.#all('reveal')) {
      if (event.a !== final.number || seen.has(event.from)) continue;
      const player = this.#player(event.from);
      const position = final.circle!.findIndex((box) => box.ecdsa === event.box);
      if (!player || position < 0 || taken.has(position)) continue;
      if (!(await verifyBoth(fromB64(player.pub), fromB64(event.box), event))) continue;
      seen.add(event.from);
      taken.add(position);
      this.state.reveals.push({ fp: event.from, position });
    }
  }

  async #foldRematch(): Promise<void> {
    const candidates = await this.#fromMember(this.#all('rematch'));
    this.state.rematchLink = candidates[0]?.link ?? null;
  }

  async run(): Promise<RoundState> {
    await this.#foldCreate();
    if (!this.#create) return this.state;
    await this.#foldJoins();
    if (!(await this.#findLock(this.#create.pub))) return this.state;
    await this.#foldCheck();
    this.state.roster = this.#roster;
    if (!this.state.matched) return this.state;
    await this.#foldAttempts();
    this.state.roster = this.#roster;
    if (this.state.final) await this.#foldReveals(this.state.final);
    await this.#foldRematch();
    return this.state;
  }
}

function toPlayer(fp: string, join: EventOf<'join'>, hash: string): Player {
  return { fp, nickname: join.nickname, sticker: join.sticker, pub: join.pub, joinHash: hash };
}

function emptyAttempt(number: number, players: string[]): AttemptView {
  return {
    number,
    players,
    stage: 'mixkeys',
    waitingOn: [],
    posted: { mixkey: [], onion: [], mix: [], confirm: [], slip: [], ready: [] },
    death: null,
    mixKeys: [],
    mixStep: 0,
    mixInput: null,
    payloads: null,
    transcript: null,
    circle: null,
    circleHash: null,
    slipParcels: null,
    slipsHash: null,
  };
}

function isValidList(items: readonly string[], count: number, layer: number): boolean {
  if (items.length !== count || hasDuplicates(items)) return false;
  const expected = onionBytesAtLayer(count, layer);
  return items.every((item) => {
    try {
      return fromB64(item).length === expected;
    } catch {
      return false;
    }
  });
}

export async function circleOrder(seed: Bytes, payloads: readonly BoxPublic[]): Promise<BoxPublic[]> {
  const keyed = await Promise.all(
    payloads.map(async (box) => ({ box, rank: await tagHashB64('circle-order', seed, box.ecdh) })),
  );
  return keyed.sort((left, right) => (left.rank < right.rank ? -1 : 1)).map(({ box }) => box);
}
