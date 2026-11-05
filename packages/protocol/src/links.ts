import { fromB64, isB64, toB64, type Bytes } from './bytes.js';
import { hkdfFromSecret, importAesKey, randomBytes, sha256 } from './crypto.js';

const ROUND_ID_BYTES = 16;
const SECRET_BYTES = 32;

export interface RoundLink {
  kind: 'join' | 'me';
  roundId: string;
  secret: string;
}

export function newRoundId(): string {
  return toB64(randomBytes(ROUND_ID_BYTES));
}

export function newSecret(): string {
  return toB64(randomBytes(SECRET_BYTES));
}

export function isRoundId(text: string): boolean {
  return isB64(text, ROUND_ID_BYTES);
}

export function formatLink(link: RoundLink): string {
  return `#${link.kind}=${link.roundId}.${link.secret}`;
}

export function parseLink(fragment: string): RoundLink | null {
  const match = /#?(join|me)=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/.exec(fragment.trim());
  if (!match) return null;
  const [, kind, roundId, secret] = match;
  if (!isRoundId(roundId!) || !isB64(secret!, SECRET_BYTES)) return null;
  return { kind: kind as RoundLink['kind'], roundId: roundId!, secret: secret! };
}

export interface RoundSecrets {
  authToken: string;
  groupKey: CryptoKey;
}

export async function deriveRoundSecrets(roundId: string, inviteSecret: string): Promise<RoundSecrets> {
  const secret = fromB64(inviteSecret);
  const [authToken, groupKey] = await Promise.all([
    hkdfFromSecret(secret, `auth-token|${roundId}`),
    hkdfFromSecret(secret, `group-key|${roundId}`),
  ]);
  return { authToken: toB64(authToken), groupKey: await importAesKey(groupKey) };
}

export async function hashAuthToken(authToken: string): Promise<string> {
  return toB64(await sha256(fromB64(authToken)));
}

export interface BackupSecrets {
  handle: string;
  backupKey: CryptoKey;
}

export async function deriveBackupSecrets(roundId: string, meSecret: string): Promise<BackupSecrets> {
  const secret: Bytes = fromB64(meSecret);
  const [handle, backupKey] = await Promise.all([
    hkdfFromSecret(secret, `backup-handle|${roundId}`),
    hkdfFromSecret(secret, `backup-key|${roundId}`),
  ]);
  return { handle: toB64(handle), backupKey: await importAesKey(backupKey) };
}
