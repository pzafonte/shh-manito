import { canon, fromB64, fromUtf8, uint32, utf8, type Bytes } from './bytes.js';
import { BACKUP_PLAINTEXT_BYTES, GROUP_BLOCK_BYTES, PARCEL_PLAINTEXT_BYTES } from './constants.js';
import { aesDecrypt, aesEncrypt, openSealed, seal, type KeyPair } from './crypto.js';
import { groupEventSchema, parcelSchema, type GroupEvent, type Parcel } from './events.js';

const LENGTH_PREFIX_BYTES = 4;

function padTo(content: Bytes, totalBytes: number): Bytes {
  const padded = new Uint8Array(totalBytes);
  padded.set(uint32(content.length));
  padded.set(content, LENGTH_PREFIX_BYTES);
  return padded;
}

function unpad(padded: Bytes): Bytes | null {
  if (padded.length < LENGTH_PREFIX_BYTES) return null;
  const length = new DataView(padded.buffer, padded.byteOffset).getUint32(0);
  if (length > padded.length - LENGTH_PREFIX_BYTES) return null;
  return padded.slice(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + length);
}

function padToBlock(content: Bytes): Bytes {
  const needed = content.length + LENGTH_PREFIX_BYTES;
  return padTo(content, Math.ceil(needed / GROUP_BLOCK_BYTES) * GROUP_BLOCK_BYTES);
}

function groupAd(roundId: string): Bytes {
  return utf8(`group|${roundId}`);
}

export function parcelPurpose(roundId: string): string {
  return `parcel|${roundId}`;
}

export async function encryptGroupEvent(groupKey: CryptoKey, roundId: string, event: GroupEvent): Promise<Bytes> {
  return aesEncrypt(groupKey, padToBlock(utf8(canon(event))), groupAd(roundId));
}

export async function decryptGroupEvent(
  groupKey: CryptoKey,
  roundId: string,
  body: Bytes,
): Promise<GroupEvent | null> {
  const padded = await aesDecrypt(groupKey, body, groupAd(roundId));
  const content = padded && unpad(padded);
  if (!content) return null;
  try {
    const parsed = groupEventSchema.safeParse(JSON.parse(fromUtf8(content)));
    return parsed.success && parsed.data.r === roundId ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function sealParcel(recipientEcdh: string, roundId: string, parcel: Parcel): Promise<Bytes> {
  const content = utf8(canon(parcel));
  if (content.length + LENGTH_PREFIX_BYTES > PARCEL_PLAINTEXT_BYTES) throw new Error('Parcel too large');
  return seal(fromB64(recipientEcdh), padTo(content, PARCEL_PLAINTEXT_BYTES), parcelPurpose(roundId));
}

export async function openParcel(own: KeyPair, roundId: string, sealed: Bytes): Promise<Parcel | null> {
  const padded = await openSealed(own, sealed, parcelPurpose(roundId));
  const content = padded && unpad(padded);
  if (!content) return null;
  try {
    const parsed = parcelSchema.safeParse(JSON.parse(fromUtf8(content)));
    return parsed.success && parsed.data.r === roundId ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function encryptBackup(backupKey: CryptoKey, handle: string, state: object): Promise<Bytes> {
  const content = utf8(canon(state));
  if (content.length + LENGTH_PREFIX_BYTES > BACKUP_PLAINTEXT_BYTES) throw new Error('Backup too large');
  return aesEncrypt(backupKey, padTo(content, BACKUP_PLAINTEXT_BYTES), utf8(handle));
}

export async function decryptBackup(backupKey: CryptoKey, handle: string, blob: Bytes): Promise<unknown> {
  const padded = await aesDecrypt(backupKey, blob, utf8(handle));
  const content = padded && unpad(padded);
  if (!content) return null;
  try {
    return JSON.parse(fromUtf8(content));
  } catch {
    return null;
  }
}
