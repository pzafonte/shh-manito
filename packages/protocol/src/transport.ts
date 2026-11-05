import { fromB64, toB64, type Bytes } from './bytes.js';
import type { LogEntry } from './fold.js';

export interface Schedule {
  revealAt: number;
  timeZone: string;
  mailTimes: string[];
}

export interface NewRound extends Schedule {
  id: string;
  authHash: string;
}

export interface NewEntry {
  kind: 'group' | 'sealed';
  body: Bytes;
  held: boolean;
}

export interface LogPage {
  schedule: Schedule;
  entries: LogEntry[];
  more: boolean;
}

export interface Transport {
  createRound(round: NewRound): Promise<void>;
  post(entry: NewEntry): Promise<{ visibleAt: number | null }>;
  fetchSince(after: number): Promise<LogPage>;
  putBackup(handle: string, blob: Bytes): Promise<void>;
  getBackup(handle: string): Promise<Bytes | null>;
}

// A phone must never act on part of the log. Reading only the start of a finished
// draw looks exactly like a draw still running, and it would answer as if it were.
export async function readToEnd(transport: Transport, after: number): Promise<LogPage> {
  let page = await transport.fetchSince(after);
  const entries = [...page.entries];
  while (page.more) {
    const last = entries.at(-1)?.seq ?? after;
    page = await transport.fetchSince(last);
    entries.push(...page.entries);
  }
  return { schedule: page.schedule, entries, more: false };
}

// The network is down or the server did not answer. Work stays queued.
export class OfflineError extends Error {}

// The server no longer has this round, or refused this link.
export class RoundGoneError extends Error {}

interface WireEntry {
  seq: number;
  kind: 'group' | 'sealed';
  body: string;
  visibleAt: number | null;
}

const TOKEN_HEADER = 'x-round-token';

export function httpTransport(baseUrl: string, roundId: string, authToken: string): Transport {
  const headers = { 'content-type': 'application/json', [TOKEN_HEADER]: authToken };

  const send = async (path: string, init: RequestInit): Promise<Response> => {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, { ...init, cache: 'no-store' });
    } catch {
      throw new OfflineError();
    }
    if (response.status === 401 || response.status === 404) throw new RoundGoneError();
    if (!response.ok) throw new OfflineError();
    return response;
  };

  return {
    async createRound(round) {
      await send('/api/rounds', { method: 'POST', headers, body: JSON.stringify(round) });
    },
    async post(entry) {
      const response = await send(`/api/rounds/${roundId}/events`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ kind: entry.kind, body: toB64(entry.body), held: entry.held }),
      });
      return (await response.json()) as { visibleAt: number | null };
    },
    async fetchSince(after) {
      const response = await send(`/api/rounds/${roundId}/events?after=${after}`, { method: 'GET', headers });
      const page = (await response.json()) as { schedule: Schedule; entries: WireEntry[]; more: boolean };
      return { ...page, entries: page.entries.map((entry) => ({ ...entry, body: fromB64(entry.body) })) };
    },
    async putBackup(handle, blob) {
      await send(`/api/backups/${handle}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ roundId, blob: toB64(blob) }),
      });
    },
    async getBackup(handle) {
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/api/backups/${handle}`, { cache: 'no-store' });
      } catch {
        throw new OfflineError();
      }
      if (response.status === 404) return null;
      if (!response.ok) throw new OfflineError();
      const { blob } = (await response.json()) as { blob: string };
      return fromB64(blob);
    },
  };
}
