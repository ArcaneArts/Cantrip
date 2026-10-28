// Diagnostics from actual repository operations. Never a runtime dependency.
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { TerminalRepository } from "../../cantrip_server/src/db/repository/terminals.ts";
import { label, state } from "./project-target-state.mjs";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { drizzle } = require("drizzle-orm/pg-proxy");
const captured = [];
const database = drizzle(async (query) => {
  captured.push(query);
  return { rows: [] };
});
const repo = new TerminalRepository(database, {
  getTerminalExecutionContext: async () => ({
    kind: "interactive",
    linkedChatId: null,
  }),
});
await repo.getTerminalExecutionContext("fixture-owner", "fixture-terminal");
await repo.updateTerminal("fixture-owner", "fixture-terminal", {
  titleProtection: label("terminal"),
});
await repo.updateTerminalService("fixture-owner", "fixture-terminal", {
  enabled: true,
  stateProtection: state("terminal-state"),
});
const manifest = {
  context: captured[0],
  update: captured[1],
  service: captured[2],
};
if (process.argv.includes("--write"))
  await writeFile(
    new URL(
      "../../cantrip_server_rs/src/terminals/queries.json",
      import.meta.url,
    ),
    JSON.stringify(manifest, null, 2) + "\n",
  );
else console.log(JSON.stringify(manifest));
