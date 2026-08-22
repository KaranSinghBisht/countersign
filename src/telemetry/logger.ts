/**
 * Structured logging.
 *
 * One decision worth stating: redaction runs inside pino itself, not at the
 * call sites. If callers had to remember to redact, the one place someone
 * forgets is the incident where it matters — a catch block logging the whole
 * upstream response body. Wiring it in here means there is no way to log an
 * unredacted value even by mistake.
 *
 * That takes two hooks rather than one, because pino has two paths in:
 *
 *   - `formatters.log` sees the merge object, and
 *   - `hooks.logMethod` sees the message string and its interpolation
 *     arguments, which pino appends AFTER the formatter has run.
 *
 * Only wiring the formatter leaves `log.info(\`charging ${pan}\`)` completely
 * unredacted, which is the most natural way for a developer to leak a card
 * number. `src/telemetry/logger.test.ts` asserts on the bytes reaching the
 * sink specifically to keep that hole closed.
 *
 * @see ./redact.ts for the allow-list and why it is not a deny-list
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { DestinationStream, Logger, LoggerOptions as PinoOptions } from "pino";
import { pino } from "pino";
import { redact, scrubString } from "./redact.js";

export type { Logger };

export interface RequestContext {
  readonly request_id: string;
  readonly trace_id?: string;
  readonly route?: string;
}

const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Run a function with a request context attached to every log line inside it,
 * including inside promises it awaits.
 *
 * AsyncLocalStorage rather than passing a logger down every call signature:
 * the correlation id needs to reach the deepest ledger write, and threading a
 * logger through twelve frames is how it ends up not being there.
 */
export function withRequestContext<T>(context: RequestContext, fn: () => T): T {
  return requestContext.run(context, fn);
}

export function currentRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}

export interface LoggerOptions {
  readonly level?: string;
  readonly service?: string;
  readonly pretty?: boolean;
}

/**
 * The pino configuration, exported so tests can attach a capturing stream and
 * assert against the real thing rather than a lookalike.
 */
export function loggerOptions(options: LoggerOptions = {}): PinoOptions {
  const { level = "info", service = "countersign" } = options;

  return {
    level,
    base: { service },
    // ISO-8601 rather than epoch millis: audit records use ISO timestamps, and
    // logs that need mental arithmetic to line up with them will not get lined
    // up during an incident.
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
      log: (object) => {
        const context = requestContext.getStore();
        const merged = context === undefined ? object : { ...context, ...object };
        return redact(merged) as Record<string, unknown>;
      },
    },
    hooks: {
      // Closes the `msg` hole. pino appends the message and its interpolation
      // arguments after `formatters.log`, so anything a developer put in a
      // template literal would otherwise reach disk verbatim.
      logMethod(args, method) {
        return method.apply(
          this,
          args.map((arg) => (typeof arg === "string" ? scrubString(arg) : arg)) as typeof args,
        );
      },
    },
    // pino serializes `err` through a separate path that skips the formatter,
    // so route it back through the same redaction.
    serializers: {
      err: (error: unknown) => redact(error),
      error: (error: unknown) => redact(error),
    },
  };
}

export function createLogger(options: LoggerOptions = {}, destination?: DestinationStream): Logger {
  const base = loggerOptions(options);

  if (destination !== undefined) return pino(base, destination);

  return pino(
    options.pretty === true
      ? {
          ...base,
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
          },
        }
      : base,
  );
}

let root: Logger | undefined;

export function logger(): Logger {
  root ??= createLogger();
  return root;
}

/** Replace the root logger. Tests and bootstrap only. */
export function setLogger(next: Logger): void {
  root = next;
}
