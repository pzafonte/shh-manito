import { fromB64, toB64 } from './bytes.js';
import { randomBytes, tagHashB64 } from './crypto.js';
import { openParcel, sealParcel } from './envelopes.js';
import { signBoth, signEvent, verifyBoth, type AbortReason, type GroupEvent, type ParcelOf } from './events.js';
import type { AttemptView, Player, RoundState } from './fold.js';
import { startAttempt, type LocalAttempt, type LocalPlayer } from './local.js';
import { peelAndShuffle, wrapOnion, type BoxPublic } from './onion.js';

function ownBox(attempt: LocalAttempt): BoxPublic {
  return { ecdh: toB64(attempt.box.ecdh.publicRaw), ecdsa: toB64(attempt.box.ecdsa.publicRaw) };
}

export function positionIn(circle: readonly BoxPublic[], attempt: LocalAttempt): number {
  const own = ownBox(attempt);
  return circle.findIndex((box) => box.ecdh === own.ecdh && box.ecdsa === own.ecdsa);
}

export function neighbours(circle: readonly BoxPublic[], position: number): { giver: BoxPublic; target: BoxPublic } {
  const count = circle.length;
  return { giver: circle[(position + count - 1) % count]!, target: circle[(position + 1) % count]! };
}

// Opens every slip and returns who this player drew, or null unless exactly one
// valid slip came from the key after theirs.
export async function openSlip(
  view: AttemptView,
  local: LocalPlayer,
  roster: readonly Player[],
): Promise<Player | null> {
  const attempt = local.attempt;
  if (!attempt || attempt.number !== view.number || !view.circle || !view.slipParcels) return null;
  const position = positionIn(view.circle, attempt);
  if (position < 0) return null;
  const { target } = neighbours(view.circle, position);

  const opened: ParcelOf<'slip'>[] = [];
  for (const sealed of view.slipParcels) {
    const parcel = await openParcel(attempt.box.ecdh, local.roundId, fromB64(sealed));
    if (parcel?.t === 'slip') opened.push(parcel);
  }
  const slip = opened[0];
  if (opened.length !== 1 || !slip) return null;
  if (slip.a !== view.number || slip.circle !== view.circleHash || slip.box !== target.ecdsa) return null;
  if (slip.fp === local.fp) return null;
  const drawn = roster.find((player) => player.fp === slip.fp);
  if (!drawn) return null;
  return (await verifyBoth(fromB64(drawn.pub), fromB64(target.ecdsa), slip)) ? drawn : null;
}

async function abort(local: LocalPlayer, number: number, why: AbortReason): Promise<GroupEvent[]> {
  if (local.attempt?.number === number) {
    if (local.attempt.done.abort) return [];
    local.attempt.done.abort = true;
  }
  return [await signEvent(local.identity.privateKey, { t: 'abort', r: local.roundId, a: number, from: local.fp, why })];
}

async function advanceCheck(state: RoundState, local: LocalPlayer): Promise<GroupEvent[]> {
  const view = state.check;
  if (!view || view.stage === 'done') return [];

  if (local.check?.version !== view.version) {
    local.check = { version: view.version, nonce: toB64(randomBytes(32)), committed: false, revealed: false };
  }
  const check = local.check;
  const key = local.identity.privateKey;
  const common = { r: local.roundId, v: view.version, from: local.fp };

  if (view.stage === 'commit' && !check.committed && !view.committed.includes(local.fp)) {
    check.committed = true;
    const commit = await tagHashB64('check-commit', fromB64(check.nonce));
    return [await signEvent(key, { t: 'checkCommit', ...common, commit })];
  }
  // Revealing only once every commit is in is what makes the words unpredictable.
  if (view.stage === 'reveal' && !check.revealed && view.waitingOn.includes(local.fp)) {
    check.revealed = true;
    return [await signEvent(key, { t: 'checkReveal', ...common, nonce: check.nonce })];
  }
  return [];
}

async function buildSlip(view: AttemptView, local: LocalPlayer, attempt: LocalAttempt): Promise<GroupEvent[]> {
  const position = positionIn(view.circle!, attempt);
  if (position < 0) return abort(local, view.number, 'key-missing');
  const { giver } = neighbours(view.circle!, position);
  const parcel = await signBoth(local.identity.privateKey, attempt.box.ecdsa.privateKey, {
    t: 'slip' as const,
    r: local.roundId,
    a: view.number,
    circle: view.circleHash!,
    fp: local.fp,
    box: ownBox(attempt).ecdsa,
  });
  const sealed = await sealParcel(giver.ecdh, local.roundId, parcel);
  return [
    await signEvent(local.identity.privateKey, {
      t: 'slip',
      r: local.roundId,
      a: view.number,
      from: local.fp,
      parcel: toB64(sealed),
    }),
  ];
}

async function peel(view: AttemptView, local: LocalPlayer, attempt: LocalAttempt): Promise<GroupEvent[]> {
  // A phone restored from a personal link has no mix key, by design.
  if (!attempt.mix) return abort(local, view.number, 'lost-keys');
  const input = view.mixInput!;
  const items = await peelAndShuffle(local.roundId, view.number, view.mixStep, attempt.mix, input);
  attempt.mix = null;
  if (!items) return abort(local, view.number, 'bad-layer');
  return [
    await signEvent(local.identity.privateKey, {
      t: 'mix',
      r: local.roundId,
      a: view.number,
      from: local.fp,
      k: view.mixStep,
      input: await tagHashB64('list', ...input),
      items,
    }),
  ];
}

// One pass of the automatic draw. Returns events to post. The caller saves local
// state before posting them, so a reload can never produce a second shuffle.
export async function advanceDraw(state: RoundState, local: LocalPlayer, roster: readonly Player[]): Promise<GroupEvent[]> {
  if (local.stopped || !state.locked || !state.roster.some((player) => player.fp === local.fp)) return [];
  if (!state.matched) return advanceCheck(state, local);

  const view = state.current;
  if (!view) return [];

  // A fault only this phone can see means the server is showing it a different
  // log. Saying so ends the attempt for everyone, so the group stays together.
  const previous = state.attempts.find((attempt) => attempt.number === view.number - 1);
  if (previous?.death === 'fault' && !local.faultsReported.includes(previous.number)) {
    local.faultsReported.push(previous.number);
    return abort(local, previous.number, 'bad-list');
  }

  if (local.attempt?.number !== view.number) {
    if (view.posted.mixkey.includes(local.fp)) return abort(local, view.number, 'lost-keys');
    await startAttempt(local, view.number);
  }
  const attempt = local.attempt!;
  const key = local.identity.privateKey;
  const common = { r: local.roundId, a: view.number, from: local.fp };
  const done = attempt.done;

  switch (view.stage) {
    case 'mixkeys': {
      if (done.mixkey || view.posted.mixkey.includes(local.fp)) return [];
      if (!attempt.mix) return abort(local, view.number, 'lost-keys');
      done.mixkey = true;
      const seedCommit = await tagHashB64('seed', fromB64(attempt.seed));
      return [await signEvent(key, { t: 'mixkey', ...common, mixPub: toB64(attempt.mix.publicRaw), seedCommit })];
    }
    case 'onions': {
      if (done.onion || view.posted.onion.includes(local.fp)) return [];
      done.onion = true;
      const onion = await wrapOnion(local.roundId, view.number, view.mixKeys, ownBox(attempt));
      return [await signEvent(key, { t: 'onion', ...common, onion })];
    }
    case 'mixing': {
      if (done.mix || !view.waitingOn.includes(local.fp)) return [];
      done.mix = true;
      return peel(view, local, attempt);
    }
    case 'confirming': {
      if (done.confirm || view.posted.confirm.includes(local.fp)) return [];
      const own = ownBox(attempt);
      const present = view.payloads!.filter((box) => box.ecdh === own.ecdh && box.ecdsa === own.ecdsa);
      if (present.length !== 1) return abort(local, view.number, 'key-missing');
      done.confirm = true;
      return [await signEvent(key, { t: 'confirm', ...common, transcript: view.transcript!, seed: attempt.seed })];
    }
    case 'slips': {
      if (done.slip || view.posted.slip.includes(local.fp)) return [];
      done.slip = true;
      return buildSlip(view, local, attempt);
    }
    case 'ready': {
      if (done.ready || view.posted.ready.includes(local.fp)) return [];
      const drawn = await openSlip(view, local, roster);
      if (!drawn) return abort(local, view.number, 'bad-slip');
      done.ready = true;
      return [await signEvent(key, { t: 'ready', ...common, slips: view.slipsHash! })];
    }
    default:
      return [];
  }
}
