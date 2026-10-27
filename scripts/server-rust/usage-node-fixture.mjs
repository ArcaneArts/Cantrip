// Disposable stdin driver of the actual Node repository; no HTTP substitutes.
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { readServerConfig } from "../../cantrip_server/src/config.ts";
import { connectDatabase } from "../../cantrip_server/src/db/index.ts";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { sql } = require("drizzle-orm");
const database = await connectDatabase(readServerConfig());
const repository = database.repository.accountResourceUsage;
const encoded = (value) =>
  JSON.stringify(value, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
console.log(
  encoded({ event: "server.listening", origin: "usage-repository-fixture" }),
);
try {
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    try {
      let value;
      switch (request.op) {
        case "sql":
          await repository.database.execute(sql.raw(request.sql));
          value = null;
          break;
        case "query-json": {
          const result = await repository.database.execute(
            sql.raw(request.sql),
          );
          value =
            (Array.isArray(result) ? result : result.rows)[0]?.result ?? null;
          break;
        }
        case "measure":
          value = await repository.measureStorage();
          break;
        case "current":
          value = await repository.listCurrentStorage(request.owner);
          break;
        case "storage-history":
          value = await repository.listStorageHistory(
            request.owner,
            new Date(request.from),
            new Date(request.to),
            request.resolution,
          );
          break;
        case "bandwidth-history":
          value = await repository.listBandwidthHistory(
            request.owner,
            new Date(request.from),
            new Date(request.to),
            request.resolution,
          );
          break;
        case "flush": {
          const batch = request.batch;
          value = await repository.flushBandwidthBatch({
            ...batch,
            sequence: BigInt(batch.sequence),
            flushedAt: new Date(batch.flushedAt),
            entries: batch.entries.map((e) => ({
              ...e,
              bucketStart: new Date(e.bucketStart),
              bytes: BigInt(e.bytes),
              operationCount: BigInt(e.operationCount),
            })),
          });
          break;
        }
        case "acquire":
          value = await repository.acquireUsageLease(
            request.key,
            request.holder,
            new Date(request.now),
            request.leaseMs,
          );
          break;
        case "release":
          await repository.releaseUsageLease(request.key, request.holder);
          value = null;
          break;
        case "reconcile":
          value = await repository.reconcileStorage(
            request.holder,
            new Date(request.measuredAt),
          );
          break;
        case "maintenance":
          value = await repository.maintainUsageHistory(
            request.holder,
            new Date(request.now),
            request.options,
          );
          break;
        case "totals":
          value = await repository.getOperationalTotals();
          break;
        default:
          throw new Error("Unknown usage fixture operation: " + request.op);
      }
      console.log(encoded({ id: request.id, rejected: false, value }));
    } catch (error) {
      console.log(
        encoded({
          id: request.id,
          rejected: true,
          diagnostic: error.cause?.message ?? error.message,
        }),
      );
    }
  }
} finally {
  await database.close();
}
