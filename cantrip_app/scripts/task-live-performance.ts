// pnpm --filter @cantrip/app exec tsx scripts/task-live-performance.ts baseline|candidate
// Same burst, expensive payload, and final snapshot; only invalidation differs.
import assert from "node:assert/strict";
import {
  setImmediate as yieldEventLoop,
  setTimeout as delay,
} from "node:timers/promises";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { TaskQueryInvalidation } from "../src/lib/task-query-invalidation";

const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
const key = ["project-task-workload", "project"];
const invalidation = new TaskQueryInvalidation(client);
const payload = JSON.stringify(
  Array.from({ length: 5_000 }, (_, id) => ({
    id,
    output: "a retained command output line\n".repeat(64),
  })),
);
let revision = 0;
let readCount = 0;
const reads: Promise<unknown>[] = [];
const observer = new QueryObserver(client, {
  initialData: { revision: 0, count: 0 },
  queryKey: key,
  staleTime: Infinity,
  queryFn: async () => {
    readCount += 1;
    const snapshot = revision;
    const rows = JSON.parse(payload) as unknown[];
    await delay(25);
    return { revision: snapshot, count: rows.length };
  },
});
const unsubscribe = observer.subscribe(() => undefined);
try {
  for (let index = 1; index <= 100; index += 1) {
    revision = index;
    reads.push(
      process.argv[2] === "baseline"
        ? client.invalidateQueries({ queryKey: key })
        : invalidation.invalidate(key),
    );
    await yieldEventLoop();
  }
  await Promise.all(reads);
  const result = client.getQueryData(key);
  assert.deepEqual(result, { revision: 100, count: 5_000 });
  // Keep stdout equivalent for the A/B harness; request counts go to stderr.
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.stderr.write(`reads=${readCount}\n`);
} finally {
  unsubscribe();
  client.clear();
}
