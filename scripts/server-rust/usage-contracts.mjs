// Development-only export. The native server embeds this SQL and never
// invokes JavaScript to measure storage or resolve ownership.
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { accountStorageMeasurementQuery } from "../../cantrip_server/src/db/account-resource-usage.ts";
import {
  STORAGE_ACCOUNTING_BASIS_VERSION,
  STORAGE_ACCOUNTING_MANIFEST,
} from "../../cantrip_server/src/account-usage/storage-manifest.ts";
import {
  ACCOUNT_LIVE_TRAFFIC_MAX_SAMPLES,
  ACCOUNT_LIVE_TRAFFIC_SAMPLE_INTERVAL_SECONDS,
  ACCOUNT_LIVE_TRAFFIC_WINDOW_SECONDS,
} from "../../packages/protocol/src/resource-usage.ts";
import {
  ACCOUNT_RESOURCE_USAGE_LIVE_COALESCE_MS,
  ACCOUNT_RESOURCE_USAGE_LIVE_TIMER_LIMIT,
} from "../../cantrip_server/src/app/shared/constants.ts";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { getTableName } = require("drizzle-orm");
export function usageContracts() {
  return {
    basisVersion: STORAGE_ACCOUNTING_BASIS_VERSION,
    tables: STORAGE_ACCOUNTING_MANIFEST.map(({ table, ...entry }) => ({
      table: getTableName(table),
      ...entry,
    })),
    measurementSql: accountStorageMeasurementQuery(),
    liveTraffic: {
      maxSamples: ACCOUNT_LIVE_TRAFFIC_MAX_SAMPLES,
      sampleIntervalSeconds: ACCOUNT_LIVE_TRAFFIC_SAMPLE_INTERVAL_SECONDS,
      windowSeconds: ACCOUNT_LIVE_TRAFFIC_WINDOW_SECONDS,
    },
    invalidation: {
      delayMs: ACCOUNT_RESOURCE_USAGE_LIVE_COALESCE_MS,
      limit: ACCOUNT_RESOURCE_USAGE_LIVE_TIMER_LIMIT,
    },
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const contract = usageContracts();
  if (process.argv.includes("--json")) console.log(JSON.stringify(contract));
  else {
    await writeFile(
      new URL(
        "../../cantrip_server_rs/contracts/resource-usage.json",
        import.meta.url,
      ),
      JSON.stringify(contract, null, 2) + "\n",
    );
    console.log(
      JSON.stringify({
        tables: contract.tables.length,
        sqlBytes: Buffer.byteLength(contract.measurementSql),
      }),
    );
  }
}
