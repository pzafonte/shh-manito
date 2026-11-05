import { concat, fromB64, toB64, type Bytes } from './bytes.js';
import { BOX_PAYLOAD_BYTES, SEAL_OVERHEAD_BYTES } from './constants.js';
import { openSealed, seal, shuffled, type KeyPair } from './crypto.js';

export interface BoxPublic {
  ecdh: string;
  ecdsa: string;
}

function layerPurpose(roundId: string, attempt: number, layer: number): string {
  return `onion|${roundId}|${attempt}|${layer}`;
}

export function onionBytesAtLayer(playerCount: number, layer: number): number {
  return BOX_PAYLOAD_BYTES + SEAL_OVERHEAD_BYTES * (playerCount - layer);
}

export function encodeBoxPublic(box: BoxPublic): Bytes {
  return concat(fromB64(box.ecdh), fromB64(box.ecdsa));
}

export function decodeBoxPublic(payload: Bytes): BoxPublic {
  return { ecdh: toB64(payload.slice(0, 65)), ecdsa: toB64(payload.slice(65)) };
}

export async function wrapOnion(
  roundId: string,
  attempt: number,
  mixKeys: readonly string[],
  box: BoxPublic,
): Promise<string> {
  let onion = encodeBoxPublic(box);
  for (let layer = mixKeys.length - 1; layer >= 0; layer--) {
    onion = await seal(fromB64(mixKeys[layer]!), onion, layerPurpose(roundId, attempt, layer));
  }
  return toB64(onion);
}

// Returns null if any item fails to open, which means the list cannot be trusted.
export async function peelAndShuffle(
  roundId: string,
  attempt: number,
  layer: number,
  mixKey: KeyPair,
  items: readonly string[],
): Promise<string[] | null> {
  const purpose = layerPurpose(roundId, attempt, layer);
  const peeled: string[] = [];
  for (const item of items) {
    const inner = await openSealed(mixKey, fromB64(item), purpose);
    if (!inner) return null;
    peeled.push(toB64(inner));
  }
  return shuffled(peeled);
}
