import { buildApp } from '../../apps/server/src/app.js';
import { openDatabase } from '../../apps/server/src/db.js';

const PORT = 3210;
const UNLIMITED = 100_000;

let offsetMs = 0;
const clock = { now: () => Date.now() + offsetMs };

const { app } = await buildApp({ db: openDatabase(':memory:'), clock, newRoundsPerHour: UNLIMITED });

// Exists only in this file. The real server has no way to change its clock.
app.post<{ Body: { offsetMs: number } }>('/__test/clock', async (request) => {
  offsetMs = request.body.offsetMs;
  return { ok: true };
});

await app.listen({ host: '127.0.0.1', port: PORT });
