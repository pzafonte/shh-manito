import type { FastifyServerOptions } from 'fastify';

export interface LogStream {
  write(line: string): void;
}

const CENSOR = '[redacted]';

// The token and backup handle would both be worth having, so neither may reach a log.
const SENSITIVE_FIELDS = ['x-round-token', 'authorization', 'cookie', 'token', 'handle', 'body', 'blob'];

const REDACT_PATHS = SENSITIVE_FIELDS.flatMap((field) => [`["${field}"]`, `*["${field}"]`]);

interface LoggableReply {
  statusCode?: number;
}

// Allowlists rather than filters: anything not named here never reaches the log.
// Requests log no address, no user agent and no path, because a path can hold a
// backup handle and an access log would record who played and when.
export function loggerOptions(stream?: LogStream): NonNullable<FastifyServerOptions['logger']> {
  return {
    level: 'info',
    base: null,
    redact: { paths: REDACT_PATHS, censor: CENSOR },
    serializers: {
      req: () => ({}),
      res: (reply: LoggableReply) => ({ statusCode: reply.statusCode }),
    },
    ...(stream ? { stream } : {}),
  };
}
