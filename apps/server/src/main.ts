import { buildApp } from './app.js';
import { openDatabase } from './db.js';

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;
const DEFAULT_PORT = 3100;
const DEFAULT_DATABASE = 'data/shh-manito.sqlite';

async function main(): Promise<void> {
  const db = openDatabase(process.env.DATABASE_PATH ?? DEFAULT_DATABASE);
  const trustProxy = Number(process.env.TRUST_PROXY_HOPS ?? 0);
  const { app } = await buildApp({ db, trustProxy, https: process.env.HTTPS === 'true' });

  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => {
      void app.close().then(() => {
        db.close();
        process.exit(0);
      });
    });
  }

  await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? DEFAULT_PORT) });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
