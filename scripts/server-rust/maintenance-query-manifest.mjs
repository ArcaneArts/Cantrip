// Capture SQL from the actual reference repository using Drizzle's query proxy.
// This development export supplies diagnostics after real native query failures.
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { TerminalRepository } from "../../cantrip_server/src/db/repository/terminals.ts";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { drizzle } = require("drizzle-orm/pg-proxy");
const captured = [];
const database = drizzle(async (query) => {
  captured.push(query);
  return { rows: [] };
});
const repository = new TerminalRepository(database, {});
await repository.listTerminalServicesForWorker(
  "fixture-worker",
  "fixture-server",
);
await repository.setTerminalStatus("fixture-terminal", "running");
const manifest = { list: captured[0], status: captured[1] };
if (process.argv.includes("--write"))
  await writeFile(
    new URL(
      "../../cantrip_server_rs/src/workers/maintenance/queries.json",
      import.meta.url,
    ),
    JSON.stringify(manifest, null, 2) + "\n",
  );
else console.log(JSON.stringify(manifest));
