import { fromB64, toB64, utf8, canon, fromUtf8 } from './bytes.js';
import type { CardId } from './catalog.js';
import {
  aesDecrypt,
  aesEncrypt,
  exportPrivateKey,
  generateAgreementKey,
  generateSigningKey,
  importAgreementPrivateKey,
  importSigningPrivateKey,
  randomBytes,
  type KeyPair,
} from './crypto.js';
import { decryptBackup, encryptBackup } from './envelopes.js';
import { fingerprintOf, type DrawStep } from './fold.js';
import { deriveBackupSecrets, newSecret, type BackupSecrets } from './links.js';

const KEYRING_AD = utf8('keyring');

export interface LocalAttempt {
  number: number;
  // Deleted the moment this player has peeled, and never backed up.
  mix: KeyPair | null;
  box: { ecdh: KeyPair; ecdsa: KeyPair };
  seed: string;
  done: Partial<Record<DrawStep | 'abort', boolean>>;
}

export interface LocalCheck {
  version: number;
  nonce: string;
  committed: boolean;
  revealed: boolean;
}

export interface OutboxItem {
  id: string;
  kind: 'group' | 'sealed';
  body: string;
  held: boolean;
  attempt: number | null;
}

export interface SentCard {
  id: string;
  card: CardId;
  amount: string;
  arrives: number | null;
}

export interface Settlement {
  detail: string | null;
  paid: boolean;
  got: boolean;
  waived: boolean;
  thanks: CardId | null;
}

export interface LocalPlayer {
  roundId: string;
  inviteSecret: string;
  meSecret: string;
  fp: string;
  identity: KeyPair;
  // Private keys encrypted under the backup key, so a backup can be refreshed
  // without any private key staying extractable.
  keyring: string;
  check: LocalCheck | null;
  attempt: LocalAttempt | null;
  outbox: OutboxItem[];
  sent: SentCard[];
  guess: string | null;
  settlement: Settlement;
  stopped: boolean;
  backupDirty: boolean;
  // Attempts this phone has already told the group it saw fail.
  faultsReported: number[];
}

interface StoredKey {
  pkcs8: string;
  pub: string;
}

interface KeyringContent {
  identity: StoredKey;
  attempt: { number: number; ecdh: StoredKey; ecdsa: StoredKey; seed: string } | null;
}

async function storeKey(pair: KeyPair): Promise<StoredKey> {
  return { pkcs8: toB64(await exportPrivateKey(pair.privateKey)), pub: toB64(pair.publicRaw) };
}

async function sealKeyring(secrets: BackupSecrets, content: KeyringContent): Promise<string> {
  return toB64(await aesEncrypt(secrets.backupKey, utf8(canon(content)), KEYRING_AD));
}

async function openKeyring(secrets: BackupSecrets, keyring: string): Promise<KeyringContent> {
  const plaintext = await aesDecrypt(secrets.backupKey, fromB64(keyring), KEYRING_AD);
  if (!plaintext) throw new Error('Keyring does not open');
  return JSON.parse(fromUtf8(plaintext)) as KeyringContent;
}

async function signingPair(stored: StoredKey): Promise<KeyPair> {
  return { privateKey: await importSigningPrivateKey(fromB64(stored.pkcs8)), publicRaw: fromB64(stored.pub) };
}

async function agreementPair(stored: StoredKey): Promise<KeyPair> {
  return { privateKey: await importAgreementPrivateKey(fromB64(stored.pkcs8)), publicRaw: fromB64(stored.pub) };
}

export async function newLocalPlayer(roundId: string, inviteSecret: string): Promise<LocalPlayer> {
  const meSecret = newSecret();
  const secrets = await deriveBackupSecrets(roundId, meSecret);
  const extractable = await generateSigningKey(true);
  const stored = await storeKey(extractable);
  return {
    roundId,
    inviteSecret,
    meSecret,
    fp: await fingerprintOf(extractable.publicRaw),
    identity: await signingPair(stored),
    keyring: await sealKeyring(secrets, { identity: stored, attempt: null }),
    check: null,
    attempt: null,
    outbox: [],
    sent: [],
    guess: null,
    settlement: { detail: null, paid: false, got: false, waived: false, thanks: null },
    stopped: false,
    backupDirty: true,
    faultsReported: [],
  };
}

// Every call makes entirely new keys, so nothing from an abandoned attempt can
// carry over. The old attempt's private keys are dropped with the old record.
export async function startAttempt(local: LocalPlayer, number: number): Promise<void> {
  const secrets = await deriveBackupSecrets(local.roundId, local.meSecret);
  const ring = await openKeyring(secrets, local.keyring);
  const [ecdh, ecdsa] = await Promise.all([
    generateAgreementKey(true).then(storeKey),
    generateSigningKey(true).then(storeKey),
  ]);
  const seed = toB64(randomBytes(32));
  local.keyring = await sealKeyring(secrets, { identity: ring.identity, attempt: { number, ecdh, ecdsa, seed } });
  local.attempt = {
    number,
    mix: await generateAgreementKey(false),
    box: { ecdh: await agreementPair(ecdh), ecdsa: await signingPair(ecdsa) },
    seed,
    done: {},
  };
  local.backupDirty = true;
}

interface BackupContent {
  inviteSecret: string;
  fp: string;
  keyring: string;
  sent: SentCard[];
  guess: string | null;
  settlement: Settlement;
}

export async function buildBackup(local: LocalPlayer): Promise<{ handle: string; blob: Uint8Array<ArrayBuffer> }> {
  const secrets = await deriveBackupSecrets(local.roundId, local.meSecret);
  const content: BackupContent = {
    inviteSecret: local.inviteSecret,
    fp: local.fp,
    keyring: local.keyring,
    sent: local.sent,
    guess: local.guess,
    settlement: local.settlement,
  };
  return { handle: secrets.handle, blob: await encryptBackup(secrets.backupKey, secrets.handle, content) };
}

export async function restoreLocalPlayer(
  roundId: string,
  meSecret: string,
  blob: Uint8Array<ArrayBuffer>,
): Promise<LocalPlayer | null> {
  const secrets = await deriveBackupSecrets(roundId, meSecret);
  const content = (await decryptBackup(secrets.backupKey, secrets.handle, blob)) as BackupContent | null;
  if (!content) return null;
  const ring = await openKeyring(secrets, content.keyring);
  return {
    roundId,
    inviteSecret: content.inviteSecret,
    meSecret,
    fp: content.fp,
    identity: await signingPair(ring.identity),
    keyring: content.keyring,
    check: null,
    attempt: ring.attempt && {
      number: ring.attempt.number,
      mix: null,
      box: { ecdh: await agreementPair(ring.attempt.ecdh), ecdsa: await signingPair(ring.attempt.ecdsa) },
      seed: ring.attempt.seed,
      done: {},
    },
    outbox: [],
    sent: content.sent,
    guess: content.guess,
    settlement: content.settlement,
    stopped: false,
    backupDirty: false,
    faultsReported: [],
  };
}
