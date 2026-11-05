import { z } from 'zod';
import { fromB64, isB64 } from './bytes.js';
import { CARD_IDS, STICKER_IDS, isPaymentDetail } from './catalog.js';
import {
  BOX_PAYLOAD_BYTES,
  MAX_NICKNAME_LENGTH,
  MAX_PAY_DETAIL_LENGTH,
  MAX_PLAYERS,
  MAX_ROUND_NAME_LENGTH,
  PARCEL_SEALED_BYTES,
  SEAL_OVERHEAD_BYTES,
} from './constants.js';
import { signFields, verifyFields, type SignerRole } from './crypto.js';
import { isValidTimeZone } from './mailtime.js';
import { isCanonicalSats, isValidBudget } from './money.js';

const b64Of = (byteLength: number) => z.string().refine((text) => isB64(text, byteLength));

const publicKey = b64Of(65);
const signature = b64Of(64);
const digest = b64Of(32);
const fingerprint = b64Of(16);
const roundId = b64Of(16);
const parcelId = b64Of(16);
const nonce = b64Of(32);
const attemptNumber = z.number().int().min(1).max(10_000);
const mailTime = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);

const MAX_ONION_BYTES = BOX_PAYLOAD_BYTES + SEAL_OVERHEAD_BYTES * MAX_PLAYERS;

const blob = z.string().refine((text) => {
  if (text.length > Math.ceil((MAX_ONION_BYTES * 4) / 3)) return false;
  try {
    fromB64(text);
    return true;
  } catch {
    return false;
  }
});

export const scheduleShape = {
  revealAt: z.number().int().positive(),
  timeZone: z.string().min(1).max(64).refine(isValidTimeZone),
  mailTimes: z.array(mailTime).min(1).max(6),
};

const createEvent = z.strictObject({
  t: z.literal('create'),
  r: roundId,
  name: z.string().min(1).max(MAX_ROUND_NAME_LENGTH),
  ...scheduleShape,
  budget: z.string().refine(isValidBudget),
  pub: publicKey,
  sig: signature,
});

const joinEvent = z.strictObject({
  t: z.literal('join'),
  r: roundId,
  nickname: z.string().min(1).max(MAX_NICKNAME_LENGTH),
  sticker: z.enum(STICKER_IDS),
  pub: publicKey,
  sig: signature,
});

const lockEvent = z.strictObject({
  t: z.literal('lock'),
  r: roundId,
  members: z.array(z.strictObject({ fp: fingerprint, join: digest })).max(MAX_PLAYERS),
  sig: signature,
});

const checkCommitEvent = z.strictObject({
  t: z.literal('checkCommit'),
  r: roundId,
  v: z.number().int().min(0).max(MAX_PLAYERS),
  from: fingerprint,
  commit: digest,
  sig: signature,
});

const checkRevealEvent = z.strictObject({
  t: z.literal('checkReveal'),
  r: roundId,
  v: z.number().int().min(0).max(MAX_PLAYERS),
  from: fingerprint,
  nonce,
  sig: signature,
});

const matchEvent = z.strictObject({
  t: z.literal('match'),
  r: roundId,
  checkHash: digest,
  sig: signature,
});

const removeEvent = z.strictObject({
  t: z.literal('remove'),
  r: roundId,
  index: z.number().int().min(0).max(MAX_PLAYERS),
  target: fingerprint,
  a: z.number().int().min(0).max(10_000),
  sig: signature,
});

const mixkeyEvent = z.strictObject({
  t: z.literal('mixkey'),
  r: roundId,
  a: attemptNumber,
  from: fingerprint,
  mixPub: publicKey,
  seedCommit: digest,
  sig: signature,
});

const onionEvent = z.strictObject({
  t: z.literal('onion'),
  r: roundId,
  a: attemptNumber,
  from: fingerprint,
  onion: blob,
  sig: signature,
});

const mixEvent = z.strictObject({
  t: z.literal('mix'),
  r: roundId,
  a: attemptNumber,
  from: fingerprint,
  k: z.number().int().min(0).max(MAX_PLAYERS),
  input: digest,
  items: z.array(blob).max(MAX_PLAYERS),
  sig: signature,
});

const confirmEvent = z.strictObject({
  t: z.literal('confirm'),
  r: roundId,
  a: attemptNumber,
  from: fingerprint,
  transcript: digest,
  seed: nonce,
  sig: signature,
});

const slipEvent = z.strictObject({
  t: z.literal('slip'),
  r: roundId,
  a: attemptNumber,
  from: fingerprint,
  parcel: b64Of(PARCEL_SEALED_BYTES),
  sig: signature,
});

const readyEvent = z.strictObject({
  t: z.literal('ready'),
  r: roundId,
  a: attemptNumber,
  from: fingerprint,
  slips: digest,
  sig: signature,
});

export const ABORT_REASONS = ['bad-list', 'bad-layer', 'key-missing', 'bad-slip', 'lost-keys'] as const;
export type AbortReason = (typeof ABORT_REASONS)[number];

const abortEvent = z.strictObject({
  t: z.literal('abort'),
  r: roundId,
  a: attemptNumber,
  from: fingerprint,
  why: z.enum(ABORT_REASONS),
  sig: signature,
});

const revealEvent = z.strictObject({
  t: z.literal('reveal'),
  r: roundId,
  a: attemptNumber,
  from: fingerprint,
  box: publicKey,
  sigId: signature,
  sigBox: signature,
});

const rematchEvent = z.strictObject({
  t: z.literal('rematch'),
  r: roundId,
  from: fingerprint,
  link: z.string().regex(/^#join=[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/),
  sig: signature,
});

export const groupEventSchema = z.discriminatedUnion('t', [
  createEvent,
  joinEvent,
  lockEvent,
  checkCommitEvent,
  checkRevealEvent,
  matchEvent,
  removeEvent,
  mixkeyEvent,
  onionEvent,
  mixEvent,
  confirmEvent,
  slipEvent,
  readyEvent,
  abortEvent,
  revealEvent,
  rematchEvent,
]);

export type GroupEvent = z.infer<typeof groupEventSchema>;
export type EventOf<T extends GroupEvent['t']> = Extract<GroupEvent, { t: T }>;
export type Unsigned<T> = Omit<T, 'sig'>;

const slipParcel = z.strictObject({
  t: z.literal('slip'),
  r: roundId,
  a: attemptNumber,
  circle: digest,
  fp: fingerprint,
  box: publicKey,
  sigId: signature,
  sigBox: signature,
});

const parcelBase = { r: roundId, a: attemptNumber, id: parcelId, sig: signature };

const cardParcel = z.strictObject({
  t: z.literal('card'),
  ...parcelBase,
  card: z.enum(CARD_IDS),
  amount: z.string().refine(isCanonicalSats),
});

const thanksParcel = z.strictObject({
  t: z.literal('thanks'),
  ...parcelBase,
  card: z.enum(CARD_IDS),
});

const payParcel = z.strictObject({
  t: z.literal('pay'),
  ...parcelBase,
  detail: z.string().max(MAX_PAY_DETAIL_LENGTH).refine(isPaymentDetail),
});

const waiveParcel = z.strictObject({ t: z.literal('waive'), ...parcelBase });
const paidParcel = z.strictObject({ t: z.literal('paid'), ...parcelBase });
const gotParcel = z.strictObject({ t: z.literal('got'), ...parcelBase });

export const parcelSchema = z.discriminatedUnion('t', [
  slipParcel,
  cardParcel,
  thanksParcel,
  payParcel,
  waiveParcel,
  paidParcel,
  gotParcel,
]);

export type Parcel = z.infer<typeof parcelSchema>;
export type ParcelOf<T extends Parcel['t']> = Extract<Parcel, { t: T }>;

// Who may author each kind of parcel, seen from the person opening it.
export const PARCEL_SENDER: Record<Exclude<Parcel['t'], 'slip'>, 'giver' | 'target'> = {
  card: 'giver',
  paid: 'giver',
  thanks: 'target',
  pay: 'target',
  waive: 'target',
  got: 'target',
};

export function withoutSignatures(event: object): object {
  const { sig: _sig, sigId: _sigId, sigBox: _sigBox, ...fields } = event as Record<string, unknown>;
  return fields;
}

export async function signEvent<T extends { t: string }>(key: CryptoKey, fields: T): Promise<T & { sig: string }> {
  return { ...fields, sig: await signFields(key, 'id', fields.t, fields) };
}

export function verifyEvent(
  publicRaw: Uint8Array<ArrayBuffer>,
  event: GroupEvent & { sig: string },
): Promise<boolean> {
  return verifyFields(publicRaw, 'id', event.t, withoutSignatures(event), event.sig);
}

// A statement carrying two signatures binds a name to a box key. Each signature
// is over the same fields under its own role, so neither can stand in for the other.
export async function signBoth<T extends { t: string }>(
  identityKey: CryptoKey,
  boxKey: CryptoKey,
  fields: T,
): Promise<T & { sigId: string; sigBox: string }> {
  return {
    ...fields,
    sigId: await signFields(identityKey, 'id', fields.t, fields),
    sigBox: await signFields(boxKey, 'box', fields.t, fields),
  };
}

export async function verifyBoth(
  identityRaw: Uint8Array<ArrayBuffer>,
  boxRaw: Uint8Array<ArrayBuffer>,
  statement: { t: string; sigId: string; sigBox: string },
): Promise<boolean> {
  const fields = withoutSignatures(statement);
  const roles: [SignerRole, Uint8Array<ArrayBuffer>, string][] = [
    ['id', identityRaw, statement.sigId],
    ['box', boxRaw, statement.sigBox],
  ];
  for (const [role, key, sig] of roles) {
    if (!(await verifyFields(key, role, statement.t, fields, sig))) return false;
  }
  return true;
}
