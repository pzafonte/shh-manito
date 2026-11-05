import { createHash, timingSafeEqual } from 'node:crypto';
import {
  BACKUP_BLOB_BYTES,
  GROUP_BLOCK_BYTES,
  GROUP_OVERHEAD_BYTES,
  isRoundId,
  MAX_GROUP_BODY_BYTES,
  PARCEL_SEALED_BYTES,
  scheduleShape,
} from '@shh-manito/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Clock } from './clock.js';
import type { RoundStore, StoredRound } from './rounds.js';

const TOKEN_HEADER = 'x-round-token';
const MAX_REVEAL_AHEAD_MS = 60 * 24 * 60 * 60 * 1000;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
export const NEW_ROUNDS_PER_HOUR = 30;

const base64 = (maxBytes: number) => z.string().max(Math.ceil((maxBytes * 4) / 3)).regex(BASE64URL);
const roundIdSchema = z.string().refine(isRoundId);

const createRoundBody = z.strictObject({
  id: roundIdSchema,
  authHash: z.string().length(43).regex(BASE64URL),
  ...scheduleShape,
});

const postEntryBody = z.strictObject({
  kind: z.enum(['group', 'sealed']),
  body: base64(MAX_GROUP_BODY_BYTES),
  held: z.boolean(),
});

const putBackupBody = z.strictObject({
  roundId: roundIdSchema,
  blob: base64(BACKUP_BLOB_BYTES),
});

const handleSchema = z.string().length(43).regex(BASE64URL);
const afterSchema = z.coerce.number().int().min(0).default(0);

function isAuthorised(request: FastifyRequest, round: StoredRound): boolean {
  const token = request.headers[TOKEN_HEADER];
  if (typeof token !== 'string') return false;
  const hash = createHash('sha256').update(Buffer.from(token, 'base64url')).digest();
  const expected = Buffer.from(round.authHash, 'base64url');
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

function isValidSize(kind: 'group' | 'sealed', bytes: number): boolean {
  if (kind === 'sealed') return bytes === PARCEL_SEALED_BYTES;
  return bytes <= MAX_GROUP_BODY_BYTES && bytes > GROUP_OVERHEAD_BYTES && (bytes - GROUP_OVERHEAD_BYTES) % GROUP_BLOCK_BYTES === 0;
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: 'not_found' });
}

function refused(reply: FastifyReply): FastifyReply {
  return reply.code(401).send({ error: 'not_allowed' });
}

function invalid(reply: FastifyReply): FastifyReply {
  return reply.code(400).send({ error: 'invalid' });
}

export function registerRoutes(
  app: FastifyInstance,
  store: RoundStore,
  clock: Clock,
  newRoundsPerHour = NEW_ROUNDS_PER_HOUR,
): void {
  const authorisedRound = (request: FastifyRequest, id: string): StoredRound | null | 'refused' => {
    const round = store.find(id);
    if (!round) return null;
    return isAuthorised(request, round) ? round : 'refused';
  };

  app.post('/api/rounds', { config: { rateLimit: { max: newRoundsPerHour, timeWindow: '1 hour' } } }, (request, reply) => {
    const parsed = createRoundBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const { id, authHash, ...schedule } = parsed.data;
    const now = clock.now();
    if (schedule.revealAt <= now || schedule.revealAt > now + MAX_REVEAL_AHEAD_MS) return invalid(reply);
    if (!store.create(id, authHash, schedule)) return reply.code(409).send({ error: 'exists' });
    return reply.code(201).send({ ok: true });
  });

  app.post<{ Params: { id: string } }>('/api/rounds/:id/events', (request, reply) => {
    const round = authorisedRound(request, request.params.id);
    if (!round) return notFound(reply);
    if (round === 'refused') return refused(reply);

    const parsed = postEntryBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const { kind, held } = parsed.data;
    if (held && kind !== 'sealed') return invalid(reply);
    const body = Buffer.from(parsed.data.body, 'base64url');
    if (!isValidSize(kind, body.length)) return invalid(reply);

    const result = store.append(round, kind, body, held);
    if (result === 'round-full') return reply.code(429).send({ error: 'round_full' });
    return reply.code(201).send({ visibleAt: result });
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/rounds/:id/events', (request, reply) => {
    const round = authorisedRound(request, request.params.id);
    if (!round) return notFound(reply);
    if (round === 'refused') return refused(reply);

    const after = afterSchema.safeParse(request.query.after);
    if (!after.success) return invalid(reply);
    store.releaseDue(round.id);
    const entries = store.entriesAfter(round.id, after.data).map((entry) => ({
      seq: entry.seq,
      kind: entry.kind,
      body: entry.body.toString('base64url'),
      visibleAt: entry.visibleAt,
    }));
    return reply.send({ schedule: round.schedule, entries });
  });

  app.put<{ Params: { handle: string } }>('/api/backups/:handle', (request, reply) => {
    const handle = handleSchema.safeParse(request.params.handle);
    const parsed = putBackupBody.safeParse(request.body);
    if (!handle.success || !parsed.success) return invalid(reply);
    const round = authorisedRound(request, parsed.data.roundId);
    if (!round) return notFound(reply);
    if (round === 'refused') return refused(reply);

    const blob = Buffer.from(parsed.data.blob, 'base64url');
    if (blob.length !== BACKUP_BLOB_BYTES) return invalid(reply);
    if (!store.putBackup(handle.data, round.id, blob)) return reply.code(409).send({ error: 'not_allowed' });
    return reply.code(204).send();
  });

  app.get<{ Params: { handle: string } }>('/api/backups/:handle', (request, reply) => {
    const handle = handleSchema.safeParse(request.params.handle);
    if (!handle.success) return invalid(reply);
    const blob = store.getBackup(handle.data);
    if (!blob) return notFound(reply);
    return reply.send({ blob: blob.toString('base64url') });
  });
}
