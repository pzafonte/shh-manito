import { fromB64 } from './bytes.js';
import type { CardId } from './catalog.js';
import { verifyFields } from './crypto.js';
import { neighbours, positionIn } from './draw.js';
import { openParcel } from './envelopes.js';
import { PARCEL_SENDER, withoutSignatures, type Parcel } from './events.js';
import type { AttemptView, LogEntry } from './fold.js';
import type { LocalPlayer } from './local.js';
import { parseSats, sumSats } from './money.js';

export interface ReceivedCard {
  id: string;
  card: CardId;
  amount: string;
  seq: number;
  visibleAt: number | null;
}

export interface InboxView {
  cards: ReceivedCard[];
  thanks: CardId | null;
  payDetail: string | null;
  waived: boolean;
  paid: boolean;
  got: boolean;
}

export function emptyInbox(): InboxView {
  return { cards: [], thanks: null, payDetail: null, waived: false, paid: false, got: false };
}

type Authored = Exclude<Parcel, { t: 'slip' }>;

// Reading here is silent by design: nothing in this file may cause network
// activity, or a server could learn who a parcel was for by watching.
export class ParcelReader {
  readonly #tried = new Set<number>();
  readonly #seen = new Set<string>();
  readonly #accepted: { parcel: Authored; entry: LogEntry }[] = [];

  async read(entries: readonly LogEntry[], final: AttemptView, local: LocalPlayer, budget: string): Promise<InboxView> {
    const attempt = local.attempt;
    if (!attempt || attempt.number !== final.number || !final.circle) return emptyInbox();
    const position = positionIn(final.circle, attempt);
    if (position < 0) return emptyInbox();
    const { giver, target } = neighbours(final.circle, position);

    for (const entry of entries) {
      if (entry.kind !== 'sealed' || this.#tried.has(entry.seq)) continue;
      this.#tried.add(entry.seq);
      const parcel = await openParcel(attempt.box.ecdh, local.roundId, entry.body);
      if (!parcel || parcel.t === 'slip' || parcel.a !== final.number || this.#seen.has(parcel.id)) continue;
      const sender = PARCEL_SENDER[parcel.t] === 'giver' ? giver : target;
      const signed = await verifyFields(fromB64(sender.ecdsa), 'box', parcel.t, withoutSignatures(parcel), parcel.sig);
      if (!signed) continue;
      this.#seen.add(parcel.id);
      this.#accepted.push({ parcel, entry });
    }
    return this.#view(budget);
  }

  #view(budget: string): InboxView {
    const view = emptyInbox();
    const limit = parseSats(budget) ?? 0n;
    for (const { parcel, entry } of this.#accepted) {
      switch (parcel.t) {
        case 'card': {
          const running = sumSats([...view.cards.map((card) => card.amount), parcel.amount]);
          if (running > limit) break;
          view.cards.push({
            id: parcel.id,
            card: parcel.card,
            amount: parcel.amount,
            seq: entry.seq,
            visibleAt: entry.visibleAt,
          });
          break;
        }
        case 'thanks':
          view.thanks ??= parcel.card;
          break;
        case 'pay':
          view.payDetail = parcel.detail;
          break;
        case 'waive':
          view.waived = true;
          break;
        case 'paid':
          view.paid = true;
          break;
        case 'got':
          view.got = true;
          break;
      }
    }
    return view;
  }
}
