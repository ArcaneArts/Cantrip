import {
  sanitizeLogRecordInput,
  type NormalizedLogError,
  type ServiceLogLevel,
  type ServiceLogRecordInput,
} from "./records.js";

export type ServiceLogContext = Error | Record<string, unknown> | unknown;

export type { NormalizedLogError } from "./records.js";

export type OperationalLogContext = Record<string, unknown> & {
  attempt?: number;
  chatId?: string;
  counts?: Record<string, number>;
  durationMs?: number;
  error?: Error | NormalizedLogError;
  event: string;
  operation?: string;
  projectId?: string;
  reasonCode?: string;
  requestId?: string;
  runId?: string;
  status?: string;
  subsystem: string;
  surfaceId?: string;
  turnId?: string;
  workerId?: string;
  workflowId?: string;
};

export type RepeatedLogOptions = {
  summaryEvery?: number;
  windowMs?: number;
};

export type ServiceLogEmitterOptions = {
  now?: () => Date;
  onRecord?: (record: ServiceLogRecordInput) => void;
  output?: (record: ServiceLogRecordInput) => void;
};

export type ServiceLogger = {
  debug(message: string, context?: ServiceLogContext): void;
  error(message: string, context?: ServiceLogContext): void;
  event(
    level: ServiceLogLevel,
    message: string,
    context: OperationalLogContext,
  ): void;
  fatal(message: string, context?: ServiceLogContext): void;
  flushRepeated(key?: string): void;
  info(message: string, context?: ServiceLogContext): void;
  log(
    level: ServiceLogLevel,
    message: string,
    context?: ServiceLogContext,
  ): void;
  rateLimited(
    key: string,
    level: ServiceLogLevel,
    message: string,
    context?: ServiceLogContext,
    options?: RepeatedLogOptions,
  ): void;
  sampled(
    key: string,
    every: number,
    level: ServiceLogLevel,
    message: string,
    context?: ServiceLogContext,
  ): boolean;
  trace(message: string, context?: ServiceLogContext): void;
  warn(message: string, context?: ServiceLogContext): void;
};

type RepeatedState = {
  context?: ServiceLogContext;
  firstAtMs: number;
  lastAtMs: number;
  level: ServiceLogLevel;
  message: string;
  suppressed: number;
};

const DEFAULT_REPEAT_WINDOW_MS = 30_000;
const DEFAULT_REPEAT_SUMMARY_EVERY = 25;
const MAX_TRACKED_NOISE_KEYS = 1_000;

function positiveInteger(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error("Log noise-control values must be positive integers.");
  }
  return resolved;
}

function withRepeatedCount(
  context: ServiceLogContext,
  repeated: number,
): Record<string, unknown> {
  const source =
    context && typeof context === "object" && !Array.isArray(context)
      ? (context as Record<string, unknown>)
      : context === undefined
        ? {}
        : { originalContext: context };
  const existingCounts =
    source.counts &&
    typeof source.counts === "object" &&
    !Array.isArray(source.counts)
      ? (source.counts as Record<string, unknown>)
      : {};
  return {
    ...source,
    counts: { ...existingCounts, repeated },
    reasonCode: "repeated-event",
  };
}

export function createServiceLogEmitter(
  system: string,
  options: ServiceLogEmitterOptions = {},
): ServiceLogger {
  const now = options.now ?? (() => new Date());
  const repeated = new Map<string, RepeatedState>();
  const sampleCounts = new Map<string, number>();

  const emit = (
    level: ServiceLogLevel,
    message: string,
    context?: ServiceLogContext,
    timestamp = now(),
  ) => {
    const record = sanitizeLogRecordInput({
      timestamp: timestamp.toISOString(),
      system,
      level,
      message,
      ...(context === undefined ? {} : { context }),
    });
    options.output?.(record);
    options.onRecord?.(record);
  };

  const emitRepeatedSummary = (
    key: string,
    state: RepeatedState,
    timestamp = now(),
  ) => {
    if (state.suppressed <= 0) return;
    emit(
      state.level,
      `${state.message} (repeated ${state.suppressed} additional ${state.suppressed === 1 ? "time" : "times"})`,
      withRepeatedCount(state.context, state.suppressed),
      timestamp,
    );
    state.suppressed = 0;
    repeated.set(key, state);
  };

  const boundedSet = <T>(map: Map<string, T>, key: string, value: T) => {
    if (!map.has(key) && map.size >= MAX_TRACKED_NOISE_KEYS) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(key, value);
  };

  const logger: ServiceLogger = {
    log: emit,
    trace: (message, context) => emit("trace", message, context),
    debug: (message, context) => emit("debug", message, context),
    info: (message, context) => emit("info", message, context),
    warn: (message, context) => emit("warn", message, context),
    error: (message, context) => emit("error", message, context),
    fatal: (message, context) => emit("fatal", message, context),
    event: (level, message, context) => emit(level, message, context),
    rateLimited: (key, level, message, context, rateOptions = {}) => {
      const occurredAt = now();
      const timestamp = occurredAt.getTime();
      const windowMs = positiveInteger(
        rateOptions.windowMs,
        DEFAULT_REPEAT_WINDOW_MS,
      );
      const summaryEvery = positiveInteger(
        rateOptions.summaryEvery,
        DEFAULT_REPEAT_SUMMARY_EVERY,
      );
      const current = repeated.get(key);
      const sameEvent = current?.level === level && current.message === message;
      if (!current || !sameEvent || timestamp - current.firstAtMs >= windowMs) {
        if (current) emitRepeatedSummary(key, current, occurredAt);
        emit(level, message, context, occurredAt);
        boundedSet(repeated, key, {
          context,
          firstAtMs: timestamp,
          lastAtMs: timestamp,
          level,
          message,
          suppressed: 0,
        });
        return;
      }
      current.context = context;
      current.lastAtMs = timestamp;
      current.suppressed += 1;
      if (current.suppressed >= summaryEvery) {
        emitRepeatedSummary(key, current);
        current.firstAtMs = timestamp;
      }
    },
    sampled: (key, every, level, message, context) => {
      const interval = positiveInteger(every, 1);
      const count = (sampleCounts.get(key) ?? 0) + 1;
      boundedSet(sampleCounts, key, count);
      if ((count - 1) % interval !== 0) return false;
      emit(level, message, context);
      return true;
    },
    flushRepeated: (key) => {
      if (key !== undefined) {
        const current = repeated.get(key);
        if (current) emitRepeatedSummary(key, current);
        return;
      }
      for (const [entryKey, current] of repeated) {
        emitRepeatedSummary(entryKey, current);
      }
    },
  };
  return logger;
}
