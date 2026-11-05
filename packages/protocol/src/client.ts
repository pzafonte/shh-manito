import { fromB64, toB64 } from './bytes.js';
import { isPaymentDetail, normaliseNickname, type CardId, type StickerId } from './catalog.js';
import { MAX_SENT_CARDS } from './constants.js';
import { randomBytes, signFields } from './crypto.js';
import { advanceDraw, neighbours, openSlip, positionIn } from './draw.js';
import { encryptGroupEvent, sealParcel } from './envelopes.js';
import { signBoth, signEvent, type GroupEvent, type Parcel } from './events.js';
import { LogFolder, phaseOf, type LogEntry, type Player, type RoundState } from './fold.js';
import { emptyInbox, ParcelReader, type InboxView } from './inbox.js';
import { deriveBackupSecrets, deriveRoundSecrets, formatLink, hashAuthToken, newRoundId, newSecret, type RoundSecrets } from './links.js';
import { buildBackup, newLocalPlayer, restoreLocalPlayer, type LocalPlayer } from './local.js';
import { parseSats, satsEnabled, sumSats } from './money.js';
import { OfflineError, type Schedule, type Transport } from './transport.js';

export interface PlayerStore {
  save(local: LocalPlayer): Promise<void>;
}

export type TransportFactory = (roundId: string, authToken: string) => Transport;

export interface NewRoundOptions extends Schedule {
  name: string;
  budget: string;
  nickname: string;
  sticker: StickerId;
}

export type SendRefusal = 'not-ready' | 'over-budget' | 'bad-amount' | 'too-many' | 'past-reveal';

export interface SendResult {
  ok: boolean;
  refusal?: SendRefusal;
  // Null until the card has actually reached the server.
  arrives: number | null;
}

export type Membership = 'player' | 'waiting' | 'name-taken' | 'full' | 'left-out' | 'removed';

export class PlayerClient {
  readonly #folder: LogFolder;
  readonly #reader = new ParcelReader();
  #entries: LogEntry[] = [];
  #lastSeq = 0;
  #schedule: Schedule | null = null;
  state: RoundState;
  inbox: InboxView = emptyInbox();
  target: Player | null = null;

  private constructor(
    readonly local: LocalPlayer,
    readonly transport: Transport,
    readonly store: PlayerStore,
    readonly secrets: RoundSecrets,
    initialState: RoundState,
  ) {
    this.#folder = new LogFolder(local.roundId, secrets.groupKey);
    this.state = initialState;
  }

  // Reads a round without joining it, for someone who only has the invite link.
  static async peek(
    roundId: string,
    inviteSecret: string,
    makeTransport: TransportFactory,
  ): Promise<RoundState> {
    const secrets = await deriveRoundSecrets(roundId, inviteSecret);
    const page = await makeTransport(roundId, secrets.authToken).fetchSince(0);
    return new LogFolder(roundId, secrets.groupKey).fold(page.entries);
  }

  static async open(local: LocalPlayer, makeTransport: TransportFactory, store: PlayerStore): Promise<PlayerClient> {
    const secrets = await deriveRoundSecrets(local.roundId, local.inviteSecret);
    const transport = makeTransport(local.roundId, secrets.authToken);
    return new PlayerClient(local, transport, store, secrets, await emptyFold(local.roundId, secrets));
  }

  static async create(
    options: NewRoundOptions,
    makeTransport: TransportFactory,
    store: PlayerStore,
  ): Promise<PlayerClient> {
    const roundId = newRoundId();
    const inviteSecret = newSecret();
    const secrets = await deriveRoundSecrets(roundId, inviteSecret);
    const { revealAt, timeZone, mailTimes } = options;
    await makeTransport(roundId, secrets.authToken).createRound({
      id: roundId,
      authHash: await hashAuthToken(secrets.authToken),
      revealAt,
      timeZone,
      mailTimes,
    });

    const local = await newLocalPlayer(roundId, inviteSecret);
    const client = await PlayerClient.open(local, makeTransport, store);
    const pub = toB64(local.identity.publicRaw);
    await client.#enqueue(
      await signEvent(local.identity.privateKey, {
        t: 'create',
        r: roundId,
        name: options.name,
        revealAt,
        timeZone,
        mailTimes,
        budget: options.budget,
        pub,
      }),
    );
    await client.#enqueueJoin(options.nickname, options.sticker);
    await client.tick();
    return client;
  }

  static async join(
    roundId: string,
    inviteSecret: string,
    nickname: string,
    sticker: StickerId,
    makeTransport: TransportFactory,
    store: PlayerStore,
  ): Promise<PlayerClient> {
    const local = await newLocalPlayer(roundId, inviteSecret);
    const client = await PlayerClient.open(local, makeTransport, store);
    await client.#enqueueJoin(nickname, sticker);
    await client.tick();
    return client;
  }

  static async restore(
    roundId: string,
    meSecret: string,
    makeTransport: (roundId: string, authToken: string) => Transport,
    store: PlayerStore,
  ): Promise<PlayerClient | null> {
    const { handle } = await deriveBackupSecrets(roundId, meSecret);
    const blob = await makeTransport(roundId, '').getBackup(handle);
    if (!blob) return null;
    const local = await restoreLocalPlayer(roundId, meSecret, blob);
    if (!local) return null;
    await store.save(local);
    return PlayerClient.open(local, makeTransport, store);
  }

  get entries(): readonly LogEntry[] {
    return this.#entries;
  }

  get inviteLink(): string {
    return formatLink({ kind: 'join', roundId: this.local.roundId, secret: this.local.inviteSecret });
  }

  get personalLink(): string {
    return formatLink({ kind: 'me', roundId: this.local.roundId, secret: this.local.meSecret });
  }

  get isOrganiser(): boolean {
    return this.state.meta?.organiser === this.local.fp;
  }

  get phase(): ReturnType<typeof phaseOf> {
    return phaseOf(this.state);
  }

  get scheduleTampered(): boolean {
    const meta = this.state.meta;
    const schedule = this.#schedule;
    if (!meta || !schedule) return false;
    return (
      meta.revealAt !== schedule.revealAt ||
      meta.timeZone !== schedule.timeZone ||
      meta.mailTimes.join() !== schedule.mailTimes.join()
    );
  }

  get membership(): Membership {
    const { fp } = this.local;
    const state = this.state;
    if (state.removed.includes(fp)) return 'removed';
    if (state.locked) return state.roster.some((player) => player.fp === fp) ? 'player' : 'left-out';
    if (state.joined.some((player) => player.fp === fp)) return 'player';
    return 'waiting';
  }

  get satsOn(): boolean {
    return this.state.meta ? satsEnabled(this.state.meta.budget) : false;
  }

  get promisedTotal(): bigint {
    return sumSats(this.local.sent.map((sent) => sent.amount));
  }

  get budgetLeft(): bigint {
    return (parseSats(this.state.meta?.budget ?? '0') ?? 0n) - this.promisedTotal;
  }

  // Null until the player has a place in a finished draw.
  get position(): number | null {
    const final = this.state.final;
    const attempt = this.local.attempt;
    if (!final?.circle || !attempt || attempt.number !== final.number) return null;
    const position = positionIn(final.circle, attempt);
    return position < 0 ? null : position;
  }

  get giver(): Player | null {
    const final = this.state.final;
    const position = this.position;
    if (!final?.circle || position === null) return null;
    const count = final.circle.length;
    const giverPosition = (position + count - 1) % count;
    const fp = this.state.reveals.find((reveal) => reveal.position === giverPosition)?.fp;
    return this.state.roster.find((player) => player.fp === fp) ?? null;
  }

  get hasRevealed(): boolean {
    return this.state.reveals.some((reveal) => reveal.fp === this.local.fp);
  }

  nicknameTaken(nickname: string): boolean {
    const wanted = normaliseNickname(nickname);
    return this.state.joined.some((player) => normaliseNickname(player.nickname) === wanted);
  }

  async sync(): Promise<void> {
    const page = await this.transport.fetchSince(this.#lastSeq);
    this.#schedule = page.schedule;
    if (page.entries.length > 0) {
      this.#entries = [...this.#entries, ...page.entries];
      this.#lastSeq = Math.max(this.#lastSeq, ...page.entries.map((entry) => entry.seq));
    }
    await this.#refold();
  }

  async #refold(): Promise<void> {
    const before = this.state.final;
    this.state = await this.#folder.fold(this.#entries);
    const final = this.state.final;
    if (!final) return;
    if (!before) {
      this.target = await openSlip(final, this.local, this.state.roster);
      this.local.backupDirty = true;
    }
    this.inbox = await this.#reader.read(this.#entries, final, this.local, this.state.meta!.budget);
  }

  // One step of the game loop: read the log, take any automatic draw steps,
  // deliver whatever is queued.
  async tick(): Promise<void> {
    try {
      await this.flush();
      await this.sync();
      const events = await advanceDraw(this.state, this.local, this.state.roster);
      for (const event of events) await this.#enqueue(event);
      if (events.length > 0) await this.store.save(this.local);
      await this.flush();
      await this.#refreshBackup();
    } catch (error) {
      if (!(error instanceof OfflineError)) throw error;
    }
  }

  async flush(): Promise<void> {
    this.#dropDeadAttemptItems();
    while (this.local.outbox.length > 0) {
      const item = this.local.outbox[0]!;
      const { visibleAt } = await this.transport.post({
        kind: item.kind,
        body: fromB64(item.body),
        held: item.held,
      });
      const card = this.local.sent.find((sent) => sent.id === item.id);
      if (card) card.arrives = visibleAt ?? 0;
      this.local.outbox.shift();
      await this.store.save(this.local);
    }
  }

  #dropDeadAttemptItems(): void {
    const current = this.state.current?.number;
    if (current === undefined) return;
    this.local.outbox = this.local.outbox.filter((item) => item.attempt === null || item.attempt >= current);
  }

  async #refreshBackup(): Promise<void> {
    if (!this.local.backupDirty) return;
    const { handle, blob } = await buildBackup(this.local);
    await this.transport.putBackup(handle, blob);
    this.local.backupDirty = false;
    await this.store.save(this.local);
  }

  async #enqueue(event: GroupEvent): Promise<void> {
    const body = await encryptGroupEvent(this.secrets.groupKey, this.local.roundId, event);
    this.local.outbox.push({
      id: toB64(randomBytes(16)),
      kind: 'group',
      body: toB64(body),
      held: false,
      // An abort is about an attempt already over, so it must outlive the cleanup
      // of that attempt's other queued events.
      attempt: event.t !== 'abort' && 'a' in event ? event.a : null,
    });
    await this.store.save(this.local);
  }

  async #enqueueJoin(nickname: string, sticker: StickerId): Promise<void> {
    await this.#enqueue(
      await signEvent(this.local.identity.privateKey, {
        t: 'join',
        r: this.local.roundId,
        nickname,
        sticker,
        pub: toB64(this.local.identity.publicRaw),
      }),
    );
  }

  async #queueParcel(id: string, recipientEcdh: string, parcel: Parcel, held: boolean): Promise<void> {
    const body = await sealParcel(recipientEcdh, this.local.roundId, parcel);
    this.local.outbox.push({ id, kind: 'sealed', body: toB64(body), held, attempt: null });
    await this.store.save(this.local);
  }

  #playContext(): { attempt: number; boxKey: CryptoKey; giverEcdh: string; targetEcdh: string } | null {
    const final = this.state.final;
    const position = this.position;
    if (!final?.circle || position === null) return null;
    const { giver, target } = neighbours(final.circle, position);
    return {
      attempt: final.number,
      boxKey: this.local.attempt!.box.ecdsa.privateKey,
      giverEcdh: giver.ecdh,
      targetEcdh: target.ecdh,
    };
  }

  async #signedParcel<T extends { t: Parcel['t'] }>(
    context: { attempt: number; boxKey: CryptoKey },
    id: string,
    fields: T,
  ): Promise<Parcel> {
    const unsigned = { ...fields, r: this.local.roundId, a: context.attempt, id };
    return { ...unsigned, sig: await signFields(context.boxKey, 'box', fields.t, unsigned) } as unknown as Parcel;
  }

  async sendCard(card: CardId, amount: string, now: number = Date.now()): Promise<SendResult> {
    const context = this.#playContext();
    const meta = this.state.meta;
    if (!context || !meta) return { ok: false, refusal: 'not-ready', arrives: null };
    if (now >= meta.revealAt) return { ok: false, refusal: 'past-reveal', arrives: null };
    const value = parseSats(amount);
    if (value === null) return { ok: false, refusal: 'bad-amount', arrives: null };
    if (value > this.budgetLeft) return { ok: false, refusal: 'over-budget', arrives: null };
    if (this.local.sent.length >= MAX_SENT_CARDS) return { ok: false, refusal: 'too-many', arrives: null };

    const id = toB64(randomBytes(16));
    const parcel = await this.#signedParcel(context, id, { t: 'card', card, amount });
    this.local.sent.push({ id, card, amount, arrives: null });
    await this.#queueParcel(id, context.targetEcdh, parcel, true);
    return this.#deliverAfterAction(id);
  }

  async #deliverAfterAction(id: string): Promise<SendResult> {
    this.local.backupDirty = true;
    await this.store.save(this.local);
    try {
      await this.flush();
      await this.#refreshBackup();
    } catch (error) {
      if (!(error instanceof OfflineError)) throw error;
    }
    const arrives = this.local.sent.find((sent) => sent.id === id)?.arrives ?? null;
    return { ok: true, arrives };
  }

  async #sendSettlement(kind: 'pay' | 'waive' | 'got' | 'paid' | 'thanks', fields: object): Promise<boolean> {
    const context = this.#playContext();
    if (!context) return false;
    const id = toB64(randomBytes(16));
    const parcel = await this.#signedParcel(context, id, { t: kind, ...fields });
    const recipient = kind === 'paid' ? context.targetEcdh : context.giverEcdh;
    await this.#queueParcel(id, recipient, parcel, false);
    await this.#deliverAfterAction(id);
    return true;
  }

  sendThanks(card: CardId): Promise<boolean> {
    this.local.settlement.thanks = card;
    return this.#sendSettlement('thanks', { card });
  }

  async sharePaymentDetail(detail: string): Promise<boolean> {
    const normal = detail.trim().toLowerCase().replace(/^lightning:/, '');
    if (!isPaymentDetail(normal)) return false;
    this.local.settlement.detail = normal;
    return this.#sendSettlement('pay', { detail: normal });
  }

  waivePromise(): Promise<boolean> {
    this.local.settlement.waived = true;
    return this.#sendSettlement('waive', {});
  }

  markPaid(): Promise<boolean> {
    this.local.settlement.paid = true;
    return this.#sendSettlement('paid', {});
  }

  confirmReceived(): Promise<boolean> {
    this.local.settlement.got = true;
    return this.#sendSettlement('got', {});
  }

  async setGuess(fp: string | null): Promise<void> {
    this.local.guess = fp;
    this.local.backupDirty = true;
    await this.store.save(this.local);
    try {
      await this.#refreshBackup();
    } catch (error) {
      if (!(error instanceof OfflineError)) throw error;
    }
  }

  async #postGroup(event: GroupEvent): Promise<void> {
    await this.#enqueue(event);
    await this.tick();
  }

  async lock(): Promise<void> {
    const members = this.state.joined.map((player) => ({ fp: player.fp, join: player.joinHash }));
    await this.#postGroup(
      await signEvent(this.local.identity.privateKey, { t: 'lock', r: this.local.roundId, members }),
    );
  }

  async confirmMatch(): Promise<void> {
    const checkHash = this.state.check?.checkHash;
    if (!checkHash) return;
    await this.#postGroup(
      await signEvent(this.local.identity.privateKey, { t: 'match', r: this.local.roundId, checkHash }),
    );
  }

  async remove(target: string): Promise<void> {
    if (this.state.final || this.state.stuck) return;
    const attempt = this.state.current?.number ?? 0;
    await this.#postGroup(
      await signEvent(this.local.identity.privateKey, {
        t: 'remove',
        r: this.local.roundId,
        index: this.state.removed.length,
        target,
        a: attempt,
      }),
    );
  }

  async stopTakingPart(): Promise<void> {
    this.local.stopped = true;
    await this.store.save(this.local);
  }

  async reveal(): Promise<void> {
    const final = this.state.final;
    const attempt = this.local.attempt;
    if (!final || !attempt || attempt.number !== final.number) return;
    const statement = await signBoth(this.local.identity.privateKey, attempt.box.ecdsa.privateKey, {
      t: 'reveal' as const,
      r: this.local.roundId,
      a: final.number,
      from: this.local.fp,
      box: toB64(attempt.box.ecdsa.publicRaw),
    });
    await this.#postGroup(statement);
  }

  async proposeRematch(link: string): Promise<void> {
    await this.#postGroup(
      await signEvent(this.local.identity.privateKey, {
        t: 'rematch',
        r: this.local.roundId,
        from: this.local.fp,
        link,
      }),
    );
  }
}

async function emptyFold(roundId: string, secrets: RoundSecrets): Promise<RoundState> {
  return new LogFolder(roundId, secrets.groupKey).fold([]);
}
