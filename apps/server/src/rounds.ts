import { randomInt } from 'node:crypto';
import { nextMailTime, ROUND_RETENTION_MS, type Schedule } from '@shh-manito/protocol';
import type { Clock } from './clock.js';
import type { Db } from './db.js';

// A 30-player round with four failed attempts and every player at the card limit
// comes to about 4,500 entries.
export const MAX_ROUND_ENTRIES = 6_000;
export const MAX_ROUND_BYTES = 48 * 1024 * 1024;
export const MAX_BACKUPS_PER_ROUND = 64;
const PAGE_SIZE = 500;

interface RoundRow {
  id: string;
  auth_hash: string;
  reveal_at: number;
  time_zone: string;
  mail_times: string;
  delete_at: number;
  next_seq: number;
  entry_count: number;
  byte_count: number;
}

export interface StoredRound {
  id: string;
  authHash: string;
  schedule: Schedule;
  nextSeq: number;
  entryCount: number;
  byteCount: number;
}

export interface StoredEntry {
  seq: number;
  kind: 'group' | 'sealed';
  body: Buffer;
  visibleAt: number | null;
}

interface EntryRow {
  seq: number;
  kind: 'group' | 'sealed';
  body: Buffer;
  visible_at: number | null;
}

function toRound(row: RoundRow): StoredRound {
  return {
    id: row.id,
    authHash: row.auth_hash,
    schedule: {
      revealAt: row.reveal_at,
      timeZone: row.time_zone,
      mailTimes: JSON.parse(row.mail_times) as string[],
    },
    nextSeq: row.next_seq,
    entryCount: row.entry_count,
    byteCount: row.byte_count,
  };
}

function shuffle<T>(items: T[]): T[] {
  for (let index = items.length - 1; index > 0; index--) {
    const other = randomInt(index + 1);
    [items[index], items[other]] = [items[other]!, items[index]!];
  }
  return items;
}

export type PostFailure = 'round-full';

export class RoundStore {
  constructor(
    readonly db: Db,
    readonly clock: Clock,
  ) {}

  create(id: string, authHash: string, schedule: Schedule): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO rounds (id, auth_hash, reveal_at, time_zone, mail_times, delete_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        authHash,
        schedule.revealAt,
        schedule.timeZone,
        JSON.stringify(schedule.mailTimes),
        schedule.revealAt + ROUND_RETENTION_MS,
      );
    return result.changes === 1;
  }

  find(id: string): StoredRound | null {
    const row = this.db
      .prepare('SELECT * FROM rounds WHERE id = ? AND delete_at > ?')
      .get(id, this.clock.now()) as RoundRow | undefined;
    return row ? toRound(row) : null;
  }

  // Held entries get their visible time here and their place in the log only when
  // released, so neither the order nor the sequence of posting survives.
  append(round: StoredRound, kind: 'group' | 'sealed', body: Buffer, held: boolean): number | null | PostFailure {
    const write = this.db.transaction((): number | null | PostFailure => {
      const current = this.find(round.id)!;
      if (current.entryCount >= MAX_ROUND_ENTRIES || current.byteCount + body.length > MAX_ROUND_BYTES) {
        return 'round-full';
      }
      this.db
        .prepare('UPDATE rounds SET entry_count = entry_count + 1, byte_count = byte_count + ? WHERE id = ?')
        .run(body.length, round.id);
      if (held) {
        const { mailTimes, timeZone } = current.schedule;
        const visibleAt = nextMailTime(this.clock.now(), mailTimes, timeZone);
        this.db.prepare('INSERT INTO held (round_id, body, visible_at) VALUES (?, ?, ?)').run(round.id, body, visibleAt);
        return visibleAt;
      }
      this.#insertEntry(round.id, kind, body, null);
      return null;
    });
    return write.immediate();
  }

  #insertEntry(roundId: string, kind: 'group' | 'sealed', body: Buffer, visibleAt: number | null): void {
    this.db
      .prepare(
        `INSERT INTO entries (round_id, seq, kind, body, visible_at)
         VALUES (?, (SELECT next_seq FROM rounds WHERE id = ?), ?, ?, ?)`,
      )
      .run(roundId, roundId, kind, body, visibleAt);
    this.db.prepare('UPDATE rounds SET next_seq = next_seq + 1 WHERE id = ?').run(roundId);
  }

  releaseDue(roundId: string): void {
    const release = this.db.transaction(() => {
      const due = this.db
        .prepare('SELECT id, body, visible_at FROM held WHERE round_id = ? AND visible_at <= ?')
        .all(roundId, this.clock.now()) as { id: number; body: Buffer; visible_at: number }[];
      for (const entry of shuffle(due)) {
        this.#insertEntry(roundId, 'sealed', entry.body, entry.visible_at);
        this.db.prepare('DELETE FROM held WHERE id = ?').run(entry.id);
      }
    });
    release.immediate();
  }

  entriesAfter(roundId: string, after: number): StoredEntry[] {
    const rows = this.db
      .prepare(
        `SELECT seq, kind, body, visible_at FROM entries
         WHERE round_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
      )
      .all(roundId, after, PAGE_SIZE) as EntryRow[];
    return rows.map((row) => ({ seq: row.seq, kind: row.kind, body: row.body, visibleAt: row.visible_at }));
  }

  putBackup(handle: string, roundId: string, blob: Buffer): boolean {
    const write = this.db.transaction((): boolean => {
      const existing = this.db.prepare('SELECT round_id FROM backups WHERE handle = ?').get(handle) as
        | { round_id: string }
        | undefined;
      if (existing && existing.round_id !== roundId) return false;
      if (!existing) {
        const { count } = this.db
          .prepare('SELECT COUNT(*) AS count FROM backups WHERE round_id = ?')
          .get(roundId) as { count: number };
        if (count >= MAX_BACKUPS_PER_ROUND) return false;
      }
      this.db
        .prepare(
          `INSERT INTO backups (handle, round_id, blob) VALUES (?, ?, ?)
           ON CONFLICT (handle) DO UPDATE SET blob = excluded.blob`,
        )
        .run(handle, roundId, blob);
      return true;
    });
    return write.immediate();
  }

  getBackup(handle: string): Buffer | null {
    const row = this.db
      .prepare(
        `SELECT backups.blob FROM backups JOIN rounds ON rounds.id = backups.round_id
         WHERE handle = ? AND rounds.delete_at > ?`,
      )
      .get(handle, this.clock.now()) as { blob: Buffer } | undefined;
    return row?.blob ?? null;
  }

  // Foreign keys take the entries, held mail and backups with each round.
  sweep(): number {
    return this.db.prepare('DELETE FROM rounds WHERE delete_at <= ?').run(this.clock.now()).changes;
  }
}
