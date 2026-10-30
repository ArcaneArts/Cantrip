// Execute the production Node limiters; no native manifest defines expectations.
import {
  SlidingWindowRateLimiter,
  SlidingWindowByteLimiter,
  ActiveLimit,
} from "../../cantrip_server/src/security/abuse-limits.ts";
import { RelayQuotaManager } from "../../cantrip_server/src/operations/relay-quotas.ts";
let count = 0;
const emit = (op, input, expected) =>
  process.stdout.write(
    JSON.stringify({ id: count++, op, input, expected }) + "\n",
  );
const stamp = Date.now;
let now = 0;
Date.now = () => now;
let seed = 718120;
const random = (max) => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % max;
};
function window(op, limit, steps) {
  const instance =
    op === "bytes"
      ? new SlidingWindowByteLimiter(limit)
      : new SlidingWindowRateLimiter(limit);
  emit(
    op,
    { limit, steps },
    steps.map((step) =>
      op === "bytes" && step.op === "retry"
        ? instance.retryAfter(step.key, step.bytes, step.now)
        : instance.consume(
            step.key,
            ...(op === "bytes" ? [step.bytes, step.now] : [step.now]),
          ),
    ),
  );
}
function quotas(limits, steps) {
  const manager = new RelayQuotaManager({
    accountRelayBytesPerMinute: limits[0],
    workerRelayBytesPerMinute: limits[1],
    accountUploadBytesPerMinute: limits[2],
    workerUploadBytesPerMinute: limits[3],
    accountRemoteSurfaceLimit: limits[4],
    workerRemoteSurfaceLimit: limits[5],
  });
  const leases = new Map();
  emit(
    "quotas",
    { limits, steps },
    steps.map((step) => {
      now = step.now;
      let outcome;
      try {
        if (step.op === "relay")
          outcome = {
            value: manager.consumeRelay(step.owner, step.worker, step.bytes),
          };
        else if (step.op === "upload") {
          manager.consumeUpload(step.owner, step.worker, step.bytes);
          outcome = { ok: true };
        } else if (step.op === "surface") {
          leases.set(
            step.id,
            manager.acquireRemoteSurface(step.owner, step.worker),
          );
          outcome = { ok: true };
        } else {
          leases.get(step.id)?.();
          outcome = { ok: true };
        }
      } catch (error) {
        outcome = {
          error: {
            name: error.name,
            message: error.message,
            statusCode: error.statusCode,
            retryAfterSeconds: error.retryAfterSeconds,
          },
        };
      }
      return { outcome, stats: manager.stats() };
    }),
  );
}
try {
  const times = [
    0, 1, 999, 1000, 59999, 60000, 60001, 60999, 61000, 120000, -60000,
    8640000000000000, -8640000000000000,
  ];
  for (let n = 0; n < 300; n++) {
    const steps = Array.from({ length: 180 }, () => ({
      op: random(3) ? "consume" : "retry",
      key: ["", "first", "second", "🦀"][random(4)],
      bytes: [0, 1, 2, 7, 8, 10, 11, 1000000][random(8)],
      now: times[random(times.length)],
    }));
    window("bytes", [1, 2, 8, 10, 1000][random(5)], steps);
    window("rate", [1, 2, 8][random(3)], steps);
  }
  for (const empty of [false, true])
    for (const op of ["bytes", "rate"]) {
      const steps = Array.from({ length: 20500 }, (_, i) => ({
        op: "consume",
        key: empty && i === 0 ? "" : "key-" + i,
        bytes: 1,
        now: 1000,
      }));
      steps.push(
        ...["", "key-0", "key-1", "key-1000", "key-20499"].map((key) => ({
          op: "consume",
          key,
          bytes: 1,
          now: 1000,
        })),
      );
      steps.push(
        ...Array.from({ length: 256 }, (_, i) => ({
          op: "consume",
          key: "fresh-" + i,
          bytes: 1,
          now: 61001,
        })),
      );
      steps.push({ op: "consume", key: "key-1000", bytes: 1, now: 61001 });
      window(op, 1, steps);
    }
  for (let n = 0; n < 200; n++) {
    const limits = [
      1 + random(20),
      1 + random(20),
      1 + random(20),
      1 + random(20),
      1 + random(3),
      1 + random(3),
    ];
    const steps = Array.from({ length: 180 }, (_, i) => ({
      op: ["relay", "upload", "surface", "release"][random(4)],
      id: String(i),
      owner: ["a", "b", "c"][random(3)],
      worker: ["x", "y", "z"][random(3)],
      bytes: [0, 1, 2, 8, 20, 21][random(6)],
      now: times[random(times.length)],
    }));
    for (let i = 0; i < steps.length; i++)
      if (steps[i].op === "release") steps[i].id = String(random(i + 1));
    quotas(limits, steps);
  }
  for (const account of [1, 2])
    for (const worker of [1, 2]) {
      const steps = [
        { op: "surface", id: "first", owner: "a", worker: "x", now: 0 },
        { op: "surface", id: "second", owner: "a", worker: "y", now: 0 },
        { op: "surface", id: "third", owner: "b", worker: "x", now: 0 },
        { op: "release", id: "first", now: 0 },
        { op: "release", id: "first", now: 0 },
        { op: "surface", id: "fourth", owner: "b", worker: "x", now: 0 },
        ...[0, 1, 59999, 60000, 60001].flatMap((now) =>
          ["relay", "upload"].map((op) => ({
            op,
            owner: "a",
            worker: "x",
            bytes: 8,
            now,
          })),
        ),
      ];
      quotas([10, 8, 10, 8, account, worker], steps);
    }
} finally {
  Date.now = stamp;
}
process.stdout.write(JSON.stringify({ done: count }) + "\n");
