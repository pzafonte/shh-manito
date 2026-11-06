import { describe, expect, it } from 'vitest';
import { fetchInvoice, invoiceMsats, isLightningAddress } from './lightning';

const ADDRESS = 'friend@wallet.example';
const OFFER_URL = 'https://wallet.example/.well-known/lnurlp/friend';
const CALLBACK = 'https://pay.wallet.example/callback?id=7';
const BODY = `p${'q'.repeat(60)}`;
const INVOICE_100_SATS = `lnbc1u1${BODY}`;

interface FakeOptions {
  offer?: object;
  reply?: object;
  fail?: boolean;
}

function fakeService({ offer = {}, reply = { pr: INVOICE_100_SATS }, fail = false }: FakeOptions = {}) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const request = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (fail) throw new TypeError('Failed to fetch');
    const body = url === OFFER_URL
      ? { tag: 'payRequest', callback: CALLBACK, minSendable: 1_000, maxSendable: 1_000_000_000, metadata: '[]', ...offer }
      : reply;
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
  return { calls, request };
}

describe('invoiceMsats', () => {
  it.each([
    ['lnbc2500u1pvjluez', 250_000_000n],
    ['lnbc20m1pvjluez', 2_000_000_000n],
    ['lnbc1u1pvjluez', 100_000n],
    ['lnbc1000n1pvjluez', 100_000n],
    ['lnbc9678785340p1pwmna7l', 967_878_534n],
    ['lnbc21pvjluez', 200_000_000_000n],
  ])('reads %s', (invoice, msats) => {
    expect(invoiceMsats(invoice)).toBe(msats);
  });

  it('has no answer for an invoice with no amount', () => {
    expect(invoiceMsats('lnbc1pvjluezpp5qqq')).toBeNull();
  });

  it('refuses an amount that is not a whole millisat', () => {
    expect(invoiceMsats('lnbc1p1pvjluez')).toBeNull();
  });
});

describe('isLightningAddress', () => {
  it('tells an address from an invoice', () => {
    expect(isLightningAddress(ADDRESS)).toBe(true);
    expect(isLightningAddress(INVOICE_100_SATS)).toBe(false);
  });
});

describe('fetchInvoice', () => {
  it('asks for the exact amount and returns the invoice', async () => {
    const { calls, request } = fakeService();
    expect(await fetchInvoice(ADDRESS, 100n, request)).toEqual({ ok: true, invoice: INVOICE_100_SATS });
    expect(calls.map(({ url }) => url)).toEqual([OFFER_URL, `${CALLBACK}&amount=100000`]);
  });

  it('sends the amount and nothing that could identify the payer', async () => {
    const { calls, request } = fakeService();
    await fetchInvoice(ADDRESS, 100n, request);
    const params = [...new URL(calls[1]!.url).searchParams.keys()];
    expect(params).toEqual(['id', 'amount']);
    for (const { init } of calls) {
      expect(init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
      expect(init?.headers).toBeUndefined();
      expect(init?.body).toBeUndefined();
    }
  });

  it('refuses an invoice for more than was promised', async () => {
    const { request } = fakeService({ reply: { pr: `lnbc2u1${BODY}` } });
    expect(await fetchInvoice(ADDRESS, 100n, request)).toEqual({ ok: false, failure: 'wrong-amount' });
  });

  it('refuses an invoice with no amount, which would let anyone fill one in', async () => {
    const { request } = fakeService({ reply: { pr: `lnbc1${BODY}` } });
    expect(await fetchInvoice(ADDRESS, 100n, request)).toEqual({ ok: false, failure: 'wrong-amount' });
  });

  it('says so when the service will not take the amount', async () => {
    const { calls, request } = fakeService({ offer: { minSendable: 200_000 } });
    expect(await fetchInvoice(ADDRESS, 100n, request)).toEqual({ ok: false, failure: 'out-of-range' });
    expect(calls).toHaveLength(1);
  });

  it('will not follow a callback that is not https', async () => {
    const { calls, request } = fakeService({ offer: { callback: 'http://wallet.example/pay' } });
    expect(await fetchInvoice(ADDRESS, 100n, request)).toEqual({ ok: false, failure: 'unreachable' });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['is not a pay offer', { offer: { tag: 'withdrawRequest' } }],
    ['reports an error', { reply: { status: 'ERROR', reason: 'nope' } }],
    ['returns something else as an invoice', { reply: { pr: 'hello there' } }],
    ['returns an address as an invoice', { reply: { pr: 'someone@wallet.example' } }],
    ['cannot be reached', { fail: true }],
  ])('copes with a service that %s', async (_label, options) => {
    const { request } = fakeService(options);
    expect(await fetchInvoice(ADDRESS, 100n, request)).toEqual({ ok: false, failure: 'unreachable' });
  });
});
