// Diagnostics from actual repository operations. Never a runtime dependency.
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { TerminalRepository } from "../../cantrip_server/src/db/repository/terminals.ts";
import { label, state } from "./project-target-state.mjs";
import * as schema from "../../cantrip_server/src/db/schema.ts";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { drizzle } = require("drizzle-orm/pg-proxy");
const { getTableColumns } = require("drizzle-orm");
const captured = [];
let worktreePhase = false;
let deletePhase = false,
  contextKind = "interactive";
const database = new Proxy(
  drizzle(async (query) => {
    captured.push(query);
    if (
      deletePhase &&
      query.startsWith("select") &&
      query.includes('from "projects"')
    )
      return { rows: [["fixture-project"]] };
    if (worktreePhase && query.startsWith("select")) {
      const terminal = {
        id: "fixture-terminal",
        projectId: "fixture-project",
        kind: "interactive",
        status: "idle",
      };
      return {
        rows: [
          Object.keys(getTableColumns(schema.terminals)).map(
            (key) => terminal[key] ?? null,
          ),
        ],
      };
    }
    return { rows: [] };
  }),
  {
    get(target, key) {
      return key === "transaction"
        ? async (operation) => operation(database)
        : Reflect.get(target, key);
    },
  },
);
const repo = new TerminalRepository(database, {
  getTerminalExecutionContext: async () => ({
    kind: contextKind,
    linkedChatId: null,
    projectId: "fixture-project",
    workerId: "fixture-worker",
    terminalId: "fixture-terminal",
  }),
  getProjectWorktreeContext: async () => ({
    workerId: "fixture-worker",
    worktree: { id: "fixture-worktree", lifecycleState: "ready" },
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
worktreePhase = true;
await repo.updateTerminalWorktree("fixture-owner", "fixture-terminal", {
  worktreeId: "fixture-worktree",
});
const manifest = {
  context: captured[0],
  update: captured[1],
  service: captured[2],
  worktree_select: captured[3],
  worktree_update: captured[4],
};
worktreePhase = false;
deletePhase = true;
await repo.deleteTerminal("fixture-owner", "fixture-terminal");
contextKind = "run-configuration";
await repo.deleteTerminal("fixture-owner", "fixture-terminal");
manifest.delete = captured.findLast((query) =>
  query.startsWith('delete from "terminals"'),
);
manifest.runtime_clear = captured.findLast((query) =>
  query.startsWith('update "run_configuration_runtimes"'),
);
manifest.runtime_active = captured.findLast((query) =>
  query.startsWith('select "state" from "run_configuration_runtimes"'),
);
if (process.argv.includes("--write"))
  await writeFile(
    new URL(
      "../../cantrip_server_rs/src/terminals/queries.json",
      import.meta.url,
    ),
    JSON.stringify(manifest, null, 2) + "\n",
  );
else console.log(JSON.stringify(manifest));
