/**
 * Structured logger. Emits single-line JSON when running on Railway so logs
 * stay queryable, and human-readable coloured text locally.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const COLOURS: Record<Level, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

const configuredLevel = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as Level;
const threshold = LEVEL_ORDER[configuredLevel] ?? LEVEL_ORDER.info;

/** Railway sets this; use JSON there so log search works. */
const useJson =
  process.env.SCANETH_LOG_JSON === 'true' ||
  (!!process.env.RAILWAY_ENVIRONMENT && process.env.SCANETH_LOG_JSON !== 'false');

/** BigInt is not JSON-serialisable by default, so stringify it. */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function emit(level: Level, scope: string, message: string, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < threshold) return;

  if (useJson) {
    const line = JSON.stringify(
      { ts: new Date().toISOString(), level, scope, message, ...meta },
      replacer,
    );
    process.stdout.write(line + '\n');
    return;
  }

  const time = new Date().toISOString().slice(11, 23);
  const head = `${COLOURS[level]}${time} ${level.toUpperCase().padEnd(5)}${RESET} \x1b[1m[${scope}]${RESET}`;
  const tail = meta && Object.keys(meta).length > 0 ? ' ' + JSON.stringify(meta, replacer) : '';
  process.stdout.write(`${head} ${message}${tail}\n`);
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(childScope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, meta) => emit('debug', scope, m, meta),
    info: (m, meta) => emit('info', scope, m, meta),
    warn: (m, meta) => emit('warn', scope, m, meta),
    error: (m, meta) => emit('error', scope, m, meta),
    child: (childScope: string) => createLogger(`${scope}:${childScope}`),
  };
}

/**
 * Normalise unknown thrown values into something loggable.
 *
 * Aggressively truncated: ethers embeds the entire transaction calldata in
 * CALL_EXCEPTION messages, which for a batched multicall is several kilobytes of
 * hex per failure. Left unchecked that buries every other log line and burns
 * through log retention.
 */
export function errMeta(err: unknown, maxLength = 240): Record<string, unknown> {
  const truncate = (text: string): string =>
    text.length > maxLength ? `${text.slice(0, maxLength)}... [truncated]` : text;

  if (err instanceof Error) {
    const meta: Record<string, unknown> = { error: truncate(err.message) };
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') meta.code = code;
    return meta;
  }
  return { error: truncate(String(err)) };
}
