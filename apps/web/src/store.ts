import type { LocalPlayer, PlayerStore } from '@shh-manito/protocol';
import type { Language } from './copy';

const DB_NAME = 'shh-manito';
const DB_VERSION = 1;
const PLAYERS = 'players';
const SUMMARIES = 'summaries';
const PREFS = 'prefs';

export interface RoundSummary {
  roundId: string;
  name: string;
  nickname: string;
  revealAt: number;
  linkSaved: boolean;
  slipPulled: boolean;
  cardsSeen: number;
}

let database: Promise<IDBDatabase> | null = null;

// Private windows and some in-app browsers refuse storage. The game still runs for
// this visit, and the app warns that the personal link is now the only copy.
const memory = new Map<string, Map<string, unknown>>();
export let storageBroken = false;

function open(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(PLAYERS, { keyPath: 'roundId' });
      db.createObjectStore(SUMMARIES, { keyPath: 'roundId' });
      db.createObjectStore(PREFS);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Storage unavailable'));
  });
  return database;
}

function fallback(store: string): Map<string, unknown> {
  storageBroken = true;
  let map = memory.get(store);
  if (!map) {
    map = new Map();
    memory.set(store, map);
  }
  return map;
}

function request<T>(store: string, mode: IDBTransactionMode, run: (objects: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const operation = run(db.transaction(store, mode).objectStore(store));
        operation.onsuccess = () => resolve(operation.result);
        operation.onerror = () => reject(operation.error ?? new Error('Storage failed'));
      }),
  );
}

async function put(store: string, key: string, value: object | string, inline: boolean): Promise<void> {
  try {
    await request(store, 'readwrite', (objects) => (inline ? objects.put(value) : objects.put(value, key)));
  } catch {
    fallback(store).set(key, value);
  }
}

async function get<T>(store: string, key: string): Promise<T | undefined> {
  try {
    return (await request(store, 'readonly', (objects) => objects.get(key))) as T | undefined;
  } catch {
    return fallback(store).get(key) as T | undefined;
  }
}

export const browserStore: PlayerStore = {
  save: (local) => put(PLAYERS, local.roundId, local, true),
};

export function loadPlayer(roundId: string): Promise<LocalPlayer | undefined> {
  return get<LocalPlayer>(PLAYERS, roundId);
}

export async function forgetPlayer(roundId: string): Promise<void> {
  try {
    await request(PLAYERS, 'readwrite', (objects) => objects.delete(roundId));
    await request(SUMMARIES, 'readwrite', (objects) => objects.delete(roundId));
  } catch {
    fallback(PLAYERS).delete(roundId);
    fallback(SUMMARIES).delete(roundId);
  }
}

export function loadSummary(roundId: string): Promise<RoundSummary | undefined> {
  return get<RoundSummary>(SUMMARIES, roundId);
}

export function saveSummary(summary: RoundSummary): Promise<void> {
  return put(SUMMARIES, summary.roundId, summary, true);
}

export async function listSummaries(): Promise<RoundSummary[]> {
  try {
    return (await request(SUMMARIES, 'readonly', (objects) => objects.getAll())) as RoundSummary[];
  } catch {
    return [...fallback(SUMMARIES).values()] as RoundSummary[];
  }
}

export function loadLanguage(): Promise<Language | undefined> {
  return get<Language>(PREFS, 'language');
}

export function saveLanguage(language: Language): Promise<void> {
  return put(PREFS, 'language', language, false);
}
