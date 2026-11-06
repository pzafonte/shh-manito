import { isPaymentDetail } from '@shh-manito/protocol';

const MSATS_PER_SAT = 1000n;
const MSATS_PER_BITCOIN = 100_000_000_000n;
const REQUEST_TIMEOUT_MS = 10_000;

// BOLT 11 amounts are bitcoin scaled by a letter. Pico is a tenth of a millisat.
const MSATS_PER_UNIT: Record<string, bigint> = { m: 100_000_000n, u: 100_000n, n: 100n };

export type InvoiceFailure = 'unreachable' | 'out-of-range' | 'wrong-amount';

export type InvoiceResult = { ok: true; invoice: string } | { ok: false; failure: InvoiceFailure };

interface PayOffer {
  tag?: unknown;
  callback?: unknown;
  minSendable?: unknown;
  maxSendable?: unknown;
}

export function isLightningAddress(detail: string): boolean {
  return detail.includes('@');
}

export function invoiceMsats(invoice: string): bigint | null {
  const prefix = invoice.slice(0, invoice.lastIndexOf('1'));
  const match = /^ln(?:bcrt|bc|tbs|tb)(\d+)([munp]?)$/.exec(prefix);
  if (!match) return null;
  const amount = BigInt(match[1]!);
  const unit = match[2]!;
  if (unit === '') return amount * MSATS_PER_BITCOIN;
  if (unit === 'p') return amount % 10n === 0n ? amount / 10n : null;
  return amount * MSATS_PER_UNIT[unit]!;
}

async function getJson(request: typeof fetch, url: string): Promise<Record<string, unknown>> {
  const response = await request(url, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return (await response.json()) as Record<string, unknown>;
}

function asMsats(value: unknown): bigint | null {
  return Number.isSafeInteger(value) ? BigInt(value as number) : null;
}

// Asks the recipient's wallet service for an invoice, following LUD-06 and LUD-16.
// Sends the amount and nothing else, and only ever runs because someone tapped: an
// automatic request would be network activity caused by what a phone privately knows.
export async function fetchInvoice(
  address: string,
  sats: bigint,
  request: typeof fetch = fetch,
): Promise<InvoiceResult> {
  const [name, domain] = address.split('@');
  const msats = sats * MSATS_PER_SAT;
  try {
    const offer: PayOffer = await getJson(request, `https://${domain}/.well-known/lnurlp/${name}`);
    const lowest = asMsats(offer.minSendable);
    const highest = asMsats(offer.maxSendable);
    if (offer.tag !== 'payRequest' || typeof offer.callback !== 'string' || lowest === null || highest === null) {
      return { ok: false, failure: 'unreachable' };
    }
    if (msats < lowest || msats > highest) return { ok: false, failure: 'out-of-range' };

    const callback = new URL(offer.callback);
    if (callback.protocol !== 'https:') return { ok: false, failure: 'unreachable' };
    callback.searchParams.set('amount', msats.toString());

    const { pr } = await getJson(request, callback.href);
    if (typeof pr !== 'string') return { ok: false, failure: 'unreachable' };
    const invoice = pr.toLowerCase();
    if (isLightningAddress(invoice) || !isPaymentDetail(invoice)) return { ok: false, failure: 'unreachable' };

    // The service could ask for more than was promised, so never pass that on.
    return invoiceMsats(invoice) === msats ? { ok: true, invoice } : { ok: false, failure: 'wrong-amount' };
  } catch {
    return { ok: false, failure: 'unreachable' };
  }
}
