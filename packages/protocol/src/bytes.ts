// Narrowed to ArrayBuffer so values can go straight into WebCrypto calls.
export type Bytes = Uint8Array<ArrayBuffer>;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const REVERSE = new Map([...ALPHABET].map((character, index) => [character, index]));

export function toB64(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    output += ALPHABET[a >> 2]!;
    output += ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    if (b !== undefined) output += ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    if (c !== undefined) output += ALPHABET[c & 63]!;
  }
  return output;
}

export function fromB64(text: string): Bytes {
  const output = new Uint8Array(Math.floor((text.length * 3) / 4));
  let written = 0;
  let buffer = 0;
  let bits = 0;
  for (const character of text) {
    const value = REVERSE.get(character);
    if (value === undefined) throw new Error('Not base64url');
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[written++] = (buffer >> bits) & 255;
      buffer &= (1 << bits) - 1;
    }
  }
  if (buffer !== 0) throw new Error('Not canonical base64url');
  return output;
}

export function isB64(text: string, byteLength: number): boolean {
  if (text.length !== Math.ceil((byteLength * 4) / 3)) return false;
  try {
    return fromB64(text).length === byteLength;
  } catch {
    return false;
  }
}

export function utf8(text: string): Bytes {
  return new TextEncoder().encode(text) as Bytes;
}

export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function concat(...parts: Uint8Array[]): Bytes {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function uint32(value: number): Bytes {
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value);
  return output;
}

type Canonical = string | number | boolean | null | Canonical[] | { [key: string]: Canonical };

function sortKeys(value: Canonical): Canonical {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key]!)]),
  );
}

// Sorted keys give one byte string per value, so a signature does not depend on
// how a client happened to build the object.
export function canon(value: object): string {
  return JSON.stringify(sortKeys(value as Canonical));
}
