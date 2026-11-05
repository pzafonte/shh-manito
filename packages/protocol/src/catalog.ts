// Identifiers only. The words shown for each live in the web app's copy file.
export const CARD_IDS = [
  'lunch',
  'coffee',
  'welldone',
  'smile',
  'cheer',
  'rest',
  'umbrella',
  'thanks',
] as const;
export type CardId = (typeof CARD_IDS)[number];

export const STICKER_IDS = [
  'rabbit',
  'bear',
  'cat',
  'dog',
  'fox',
  'tiger',
  'panda',
  'frog',
  'chick',
  'penguin',
  'hamster',
  'whale',
] as const;
export type StickerId = (typeof STICKER_IDS)[number];

const LIGHTNING_ADDRESS = /^[a-z0-9._-]{1,64}@[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/;
const BOLT11_INVOICE = /^ln(bc|tb|tbs|bcrt)[0-9]*[munp]?1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{20,}$/;

export function isPaymentDetail(text: string): boolean {
  return LIGHTNING_ADDRESS.test(text) || BOLT11_INVOICE.test(text);
}

export function normaliseNickname(nickname: string): string {
  return nickname.normalize('NFKC').trim().toLowerCase();
}
