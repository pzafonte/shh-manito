import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController, type FastifyError, type FastifyInstance } from 'fastify';
import { systemClock, type Clock } from './clock.js';
import type { Db } from './db.js';
import { loggerOptions, type LogStream } from './logging.js';
import { RoundStore } from './rounds.js';
import { registerRoutes } from './routes.js';

export const DEFAULT_WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../web/dist');

// Holds one mix step at 30 players, the largest thing anyone posts.
const BODY_LIMIT_BYTES = 192 * 1024;

// A classroom of phones can share one address, and the draw polls fast for a minute.
const REQUESTS_PER_MINUTE = 6_000;

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const ASSET_MAX_AGE_SECONDS = 31_536_000;

export interface AppOptions {
  db: Db;
  clock?: Clock;
  logStream?: LogStream;
  webRoot?: string;
  // A number of hops to trust. Off by default, so an address cannot be spoofed.
  trustProxy?: number;
  https?: boolean;
  newRoundsPerHour?: number;
}

export interface BuiltApp {
  app: FastifyInstance;
  store: RoundStore;
}

function proxyTrust(hops: number | undefined): boolean | ((address: string, hop: number) => boolean) {
  return hops ? (_address, hop) => hop < hops : false;
}

function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status < 500) return reply.code(status).send({ error: status === 429 ? 'slow_down' : 'invalid' });
    request.log.error({ err: { message: error.message } }, 'request failed');
    return reply.code(500).send({ error: 'server' });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not_found' }));
}

export async function buildApp(options: AppOptions): Promise<BuiltApp> {
  const clock = options.clock ?? systemClock;
  const store = new RoundStore(options.db, clock);

  const app = Fastify({
    logger: loggerOptions(options.logStream),
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: BODY_LIMIT_BYTES,
    trustProxy: proxyTrust(options.trustProxy),
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'none'"],
        upgradeInsecureRequests: options.https ? [] : null,
      },
    },
    strictTransportSecurity: options.https ?? false,
    referrerPolicy: { policy: 'no-referrer' },
  });

  registerErrorHandling(app);

  // Counted in memory only. The addresses never reach the database or a log.
  await app.register(rateLimit, {
    max: REQUESTS_PER_MINUTE,
    timeWindow: '1 minute',
    allowList: (request) => !request.url.startsWith('/api/'),
    addHeaders: {
      'x-ratelimit-limit': false,
      'x-ratelimit-remaining': false,
      'x-ratelimit-reset': false,
      'retry-after': true,
    },
  });

  app.addHook('onSend', async (request, reply) => {
    if (request.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
  });

  app.get('/healthz', async () => ({ status: 'ok' }));
  registerRoutes(app, store, clock, options.newRoundsPerHour);

  const webRoot = options.webRoot ?? DEFAULT_WEB_ROOT;
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, {
      root: webRoot,
      wildcard: false,
      preCompressed: true,
      setHeaders: (reply, path) => {
        if (path.includes('/assets/')) {
          reply.header('cache-control', `public, max-age=${ASSET_MAX_AGE_SECONDS}, immutable`);
        }
      },
    });
  }

  const sweep = setInterval(() => store.sweep(), SWEEP_INTERVAL_MS);
  sweep.unref();
  app.addHook('onClose', async () => clearInterval(sweep));
  store.sweep();

  return { app, store };
}
