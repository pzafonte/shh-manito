export const PROTOCOL_TAG = 'shh-manito/v1';

export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 30;

// Ephemeral public key (65) + IV (12) + GCM tag (16).
export const SEAL_OVERHEAD_BYTES = 93;
export const PARCEL_PLAINTEXT_BYTES = 1024;
export const PARCEL_SEALED_BYTES = PARCEL_PLAINTEXT_BYTES + SEAL_OVERHEAD_BYTES;

// Two 65-byte box public keys: one ECDH, one ECDSA.
export const BOX_PAYLOAD_BYTES = 130;

export const GROUP_BLOCK_BYTES = 512;
// IV (12) + GCM tag (16).
export const GROUP_OVERHEAD_BYTES = 28;
// The largest entry is one mix step at 30 players, about 118 KiB once encoded.
export const MAX_GROUP_BODY_BYTES = 128 * 1024 + GROUP_OVERHEAD_BYTES;

export const BACKUP_PLAINTEXT_BYTES = 16 * 1024;
export const BACKUP_BLOB_BYTES = BACKUP_PLAINTEXT_BYTES + GROUP_OVERHEAD_BYTES;

// Each failure lets a colluding pair re-roll their seats, so retries stay few.
export const MAX_FAILED_ATTEMPTS = 4;

// Bounds what a personal link has to carry at its fixed size.
export const MAX_SENT_CARDS = 100;

export const MAX_NICKNAME_LENGTH = 20;
export const MAX_ROUND_NAME_LENGTH = 40;
export const MAX_BUDGET_SATS = 1_000_000n;
export const MAX_PAY_DETAIL_LENGTH = 800;

export const ROUND_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
