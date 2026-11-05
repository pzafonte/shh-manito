import { concat, fromB64, toB64, uint32, utf8, canon, type Bytes } from './bytes.js';
import { PROTOCOL_TAG, SEAL_OVERHEAD_BYTES } from './constants.js';

const PUBLIC_KEY_BYTES = 65;
const IV_BYTES = 12;
const SIGNATURE_BYTES = 64;
const CURVE = { namedCurve: 'P-256' } as const;
const ECDSA_PARAMS = { name: 'ECDSA', ...CURVE } as const;
const ECDH_PARAMS = { name: 'ECDH', ...CURVE } as const;
const SIGN_PARAMS = { name: 'ECDSA', hash: 'SHA-256' } as const;

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;

export function randomBytes(length: number): Bytes {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

export async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await subtle().digest('SHA-256', data));
}

// Length-prefixing every part stops two different lists hashing alike.
export async function tagHash(label: string, ...parts: (Bytes | string)[]): Promise<Bytes> {
  const encoded = parts.flatMap((part) => {
    const bytes = typeof part === 'string' ? utf8(part) : part;
    return [uint32(bytes.length), bytes];
  });
  return sha256(concat(utf8(`${PROTOCOL_TAG}/${label}`), ...encoded));
}

export async function tagHashB64(label: string, ...parts: (Bytes | string)[]): Promise<string> {
  return toB64(await tagHash(label, ...parts));
}

export async function hkdf(ikm: Bytes, salt: Bytes, info: string, length = 32): Promise<Bytes> {
  const key = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8(info) }, key, length * 8);
  return new Uint8Array(bits);
}

export function hkdfFromSecret(secret: Bytes, info: string): Promise<Bytes> {
  return hkdf(secret, utf8(PROTOCOL_TAG), info);
}

export function importAesKey(raw: Bytes): Promise<CryptoKey> {
  return subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function aesEncrypt(key: CryptoKey, plaintext: Bytes, additionalData: Bytes): Promise<Bytes> {
  const iv = randomBytes(IV_BYTES);
  const ciphertext = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData }, key, plaintext);
  return concat(iv, new Uint8Array(ciphertext));
}

export async function aesDecrypt(key: CryptoKey, sealed: Bytes, additionalData: Bytes): Promise<Bytes | null> {
  if (sealed.length < IV_BYTES + 16) return null;
  try {
    const iv = sealed.slice(0, IV_BYTES);
    const plaintext = await subtle().decrypt(
      { name: 'AES-GCM', iv, additionalData },
      key,
      sealed.slice(IV_BYTES),
    );
    return new Uint8Array(plaintext);
  } catch {
    return null;
  }
}

export interface KeyPair {
  privateKey: CryptoKey;
  publicRaw: Bytes;
}

async function asKeyPair(pair: CryptoKeyPair): Promise<KeyPair> {
  return { privateKey: pair.privateKey, publicRaw: new Uint8Array(await subtle().exportKey('raw', pair.publicKey)) };
}

export async function generateSigningKey(extractable: boolean): Promise<KeyPair> {
  return asKeyPair(await subtle().generateKey(ECDSA_PARAMS, extractable, ['sign', 'verify']));
}

export async function generateAgreementKey(extractable: boolean): Promise<KeyPair> {
  return asKeyPair(await subtle().generateKey(ECDH_PARAMS, extractable, ['deriveBits']));
}

export async function exportPrivateKey(key: CryptoKey): Promise<Bytes> {
  return new Uint8Array(await subtle().exportKey('pkcs8', key));
}

export function importSigningPrivateKey(pkcs8: Bytes): Promise<CryptoKey> {
  return subtle().importKey('pkcs8', pkcs8, ECDSA_PARAMS, false, ['sign']);
}

export function importAgreementPrivateKey(pkcs8: Bytes): Promise<CryptoKey> {
  return subtle().importKey('pkcs8', pkcs8, ECDH_PARAMS, false, ['deriveBits']);
}

// WebCrypto refuses points that are not on the curve, which is the check that
// stops invalid-curve inputs reaching ECDH or ECDSA.
export async function isValidPublicKey(raw: Bytes): Promise<boolean> {
  if (raw.length !== PUBLIC_KEY_BYTES) return false;
  try {
    await subtle().importKey('raw', raw, ECDH_PARAMS, false, []);
    return true;
  } catch {
    return false;
  }
}

export type SignerRole = 'id' | 'box';

function signedBytes(role: SignerRole, type: string, fields: object): Bytes {
  return utf8(canon({ ctx: `${PROTOCOL_TAG}/sig/${role}/${type}`, ...fields }));
}

export async function signFields(
  key: CryptoKey,
  role: SignerRole,
  type: string,
  fields: object,
): Promise<string> {
  const signature = await subtle().sign(SIGN_PARAMS, key, signedBytes(role, type, fields));
  return toB64(new Uint8Array(signature));
}

export async function verifyFields(
  publicRaw: Bytes,
  role: SignerRole,
  type: string,
  fields: object,
  signature: string,
): Promise<boolean> {
  try {
    const bytes = fromB64(signature);
    if (bytes.length !== SIGNATURE_BYTES) return false;
    const key = await subtle().importKey('raw', publicRaw, ECDSA_PARAMS, false, ['verify']);
    return await subtle().verify(SIGN_PARAMS, key, bytes, signedBytes(role, type, fields));
  } catch {
    return false;
  }
}

async function sealKey(shared: Bytes, ephemeralRaw: Bytes, recipientRaw: Bytes, purpose: string): Promise<CryptoKey> {
  const salt = await tagHash('seal-salt', ephemeralRaw, recipientRaw);
  return importAesKey(await hkdf(shared, salt, purpose));
}

async function agree(privateKey: CryptoKey, publicRaw: Bytes): Promise<Bytes> {
  const peer = await subtle().importKey('raw', publicRaw, ECDH_PARAMS, false, []);
  return new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: peer }, privateKey, 256));
}

// The output names no recipient. Only trying to open it shows who it is for.
export async function seal(recipientRaw: Bytes, plaintext: Bytes, purpose: string): Promise<Bytes> {
  const ephemeral = await generateAgreementKey(false);
  const shared = await agree(ephemeral.privateKey, recipientRaw);
  const key = await sealKey(shared, ephemeral.publicRaw, recipientRaw, purpose);
  return concat(ephemeral.publicRaw, await aesEncrypt(key, plaintext, utf8(purpose)));
}

export async function openSealed(
  own: KeyPair,
  sealed: Bytes,
  purpose: string,
): Promise<Bytes | null> {
  if (sealed.length < SEAL_OVERHEAD_BYTES) return null;
  const ephemeralRaw = sealed.slice(0, PUBLIC_KEY_BYTES);
  try {
    const shared = await agree(own.privateKey, ephemeralRaw);
    const key = await sealKey(shared, ephemeralRaw, own.publicRaw, purpose);
    return await aesDecrypt(key, sealed.slice(PUBLIC_KEY_BYTES), utf8(purpose));
  } catch {
    return null;
  }
}

function unbiasedIndex(boundExclusive: number): number {
  const limit = Math.floor(0x1_0000_0000 / boundExclusive) * boundExclusive;
  const draw = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(draw);
    if (draw[0]! < limit) return draw[0]! % boundExclusive;
  }
}

export function shuffled<T>(items: readonly T[]): T[] {
  const output = [...items];
  for (let index = output.length - 1; index > 0; index--) {
    const other = unbiasedIndex(index + 1);
    [output[index], output[other]] = [output[other]!, output[index]!];
  }
  return output;
}
