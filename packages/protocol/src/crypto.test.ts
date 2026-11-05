import { describe, expect, it } from 'vitest';
import { canon, fromB64, toB64, utf8 } from './bytes.js';
import { PARCEL_PLAINTEXT_BYTES, PARCEL_SEALED_BYTES, SEAL_OVERHEAD_BYTES } from './constants.js';
import {
  generateAgreementKey,
  generateSigningKey,
  hkdfFromSecret,
  openSealed,
  randomBytes,
  seal,
  shuffled,
  signFields,
  tagHashB64,
  verifyFields,
} from './crypto.js';
import { openParcel, sealParcel } from './envelopes.js';
import type { Parcel } from './events.js';

const ROUND = toB64(new Uint8Array(16));
const SHUFFLE_RUNS = 6000;
const SHUFFLE_ITEMS = 4;
const SIG = toB64(new Uint8Array(64));

function cardParcel(): Parcel {
  return { t: 'card', r: ROUND, a: 1, id: toB64(randomBytes(16)), card: 'lunch', amount: '100', sig: SIG };
}

// A label is any stretch of bytes that repeats for the same recipient.
function sharedWindow(left: Uint8Array, right: Uint8Array, width: number): boolean {
  const windows = new Set<string>();
  for (let index = 0; index + width <= left.length; index++) {
    windows.add(toB64(left.slice(index, index + width)));
  }
  for (let index = 0; index + width <= right.length; index++) {
    if (windows.has(toB64(right.slice(index, index + width)))) return true;
  }
  return false;
}

describe('bytes', () => {
  it('round-trips base64url at every length', () => {
    for (let length = 0; length < 70; length++) {
      const bytes = randomBytes(length);
      expect(fromB64(toB64(bytes))).toEqual(bytes);
    }
  });

  it('rejects non-canonical base64url so one value has one spelling', () => {
    expect(() => fromB64('AB')).toThrow();
  });

  it('gives one canonical form regardless of key order', () => {
    expect(canon({ b: 1, a: { d: 2, c: [1, { f: 1, e: 2 }] } })).toBe(canon({ a: { c: [1, { e: 2, f: 1 }], d: 2 }, b: 1 }));
  });
});

describe('hashing', () => {
  it('keeps parts apart so a list cannot be re-split into the same hash', async () => {
    expect(await tagHashB64('x', 'ab', 'c')).not.toBe(await tagHashB64('x', 'a', 'bc'));
  });

  it('keeps labels apart', async () => {
    expect(await tagHashB64('one', 'a')).not.toBe(await tagHashB64('two', 'a'));
  });
});

describe('derived keys', () => {
  it('separates values by purpose', async () => {
    const secret = randomBytes(32);
    expect(toB64(await hkdfFromSecret(secret, 'a'))).not.toBe(toB64(await hkdfFromSecret(secret, 'b')));
  });
});

describe('sealing', () => {
  it('adds exactly the documented overhead', async () => {
    const recipient = await generateAgreementKey(false);
    const sealed = await seal(recipient.publicRaw, new Uint8Array(100), 'p');
    expect(sealed.length).toBe(100 + SEAL_OVERHEAD_BYTES);
  });

  it('opens only for its recipient and only under its purpose', async () => {
    const recipient = await generateAgreementKey(false);
    const stranger = await generateAgreementKey(false);
    const sealed = await seal(recipient.publicRaw, utf8('hello'), 'p');
    expect(await openSealed(recipient, sealed, 'p')).toEqual(utf8('hello'));
    expect(await openSealed(stranger, sealed, 'p')).toBeNull();
    expect(await openSealed(recipient, sealed, 'q')).toBeNull();
  });

  it('rejects any changed byte', async () => {
    const recipient = await generateAgreementKey(false);
    const sealed = await seal(recipient.publicRaw, utf8('hello'), 'p');
    for (const index of [0, 70, sealed.length - 1]) {
      const changed = sealed.slice();
      changed[index]! ^= 1;
      expect(await openSealed(recipient, changed, 'p')).toBeNull();
    }
  });
});

describe('parcels', () => {
  it('are always the same size', async () => {
    const recipient = await generateAgreementKey(false);
    const small = await sealParcel(toB64(recipient.publicRaw), ROUND, cardParcel());
    const large = await sealParcel(toB64(recipient.publicRaw), ROUND, {
      t: 'pay',
      r: ROUND,
      a: 1,
      id: toB64(randomBytes(16)),
      detail: `lnbc1${'q'.repeat(700)}`,
      sig: SIG,
    });
    expect(small.length).toBe(PARCEL_SEALED_BYTES);
    expect(large.length).toBe(PARCEL_PLAINTEXT_BYTES + SEAL_OVERHEAD_BYTES);
  });

  it('round-trip', async () => {
    const recipient = await generateAgreementKey(false);
    const parcel = cardParcel();
    const sealed = await sealParcel(toB64(recipient.publicRaw), ROUND, parcel);
    expect(await openParcel(recipient, ROUND, sealed)).toEqual(parcel);
  });

  it('carry no label: two parcels to one person share no bytes', async () => {
    const recipient = await generateAgreementKey(false);
    const first = await sealParcel(toB64(recipient.publicRaw), ROUND, cardParcel());
    const second = await sealParcel(toB64(recipient.publicRaw), ROUND, cardParcel());
    expect(sharedWindow(first, second, 6)).toBe(false);
    expect(sharedWindow(first, recipient.publicRaw, 6)).toBe(false);
  });
});

describe('signatures', () => {
  it('bind role and type, so one statement cannot stand in for another', async () => {
    const key = await generateSigningKey(false);
    const fields = { r: 'x', a: 1 };
    const signature = await signFields(key.privateKey, 'box', 'card', fields);
    expect(await verifyFields(key.publicRaw, 'box', 'card', fields, signature)).toBe(true);
    expect(await verifyFields(key.publicRaw, 'id', 'card', fields, signature)).toBe(false);
    expect(await verifyFields(key.publicRaw, 'box', 'paid', fields, signature)).toBe(false);
    expect(await verifyFields(key.publicRaw, 'box', 'card', { r: 'x', a: 2 }, signature)).toBe(false);
  });
});

describe('shuffle', () => {
  it('puts every item in every position about equally often', () => {
    const counts = Array.from({ length: SHUFFLE_ITEMS }, () => new Array<number>(SHUFFLE_ITEMS).fill(0));
    const items = Array.from({ length: SHUFFLE_ITEMS }, (_, index) => index);
    for (let run = 0; run < SHUFFLE_RUNS; run++) {
      shuffled(items).forEach((item, position) => counts[item]![position]!++);
    }
    const expected = SHUFFLE_RUNS / SHUFFLE_ITEMS;
    for (const row of counts) {
      for (const count of row) expect(Math.abs(count - expected)).toBeLessThan(expected * 0.2);
    }
  });
});
