// Capture Source ORM statements through its actual repository implementations.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import * as schema from "../../cantrip_server/src/db/schema.ts";
import { ChatRuntimeContextRepository } from "../../cantrip_server/src/db/repository/chat-runtime-context.ts";
import { TerminalRepository } from "../../cantrip_server/src/db/repository/terminals.ts";
import { ExplorerRepository } from "../../cantrip_server/src/db/repository/explorers.ts";
import { CodeSurfaceRepository } from "../../cantrip_server/src/db/repository/code-surfaces.ts";
import { RemoteSurfaceRepository } from "../../cantrip_server/src/db/repository/remote-surfaces.ts";
import { BrowserRepository } from "../../cantrip_server/src/db/repository/browsers.ts";
import { ProjectRepository } from "../../cantrip_server/src/db/repository/projects.ts";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { drizzle } = require("drizzle-orm/pg-proxy");
const owner = "fixture-owner",
  target = "fixture-target",
  project = "fixture-project";
async function capture(Constructor, method, args = [owner, target]) {
  const calls = [];
  const database = drizzle(
    async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
    { schema },
  );
  await new Constructor(database, {})[method](...args);
  return calls;
}
const entries = {};
for (const [key, Constructor, method] of [
  ["terminal", TerminalRepository, "getTerminalExecutionContext"],
  ["explorer", ExplorerRepository, "getExplorerExecutionContext"],
  ["code", CodeSurfaceRepository, "getCodeTabExecutionContext"],
  ["remote", RemoteSurfaceRepository, "getRemoteSurfaceExecutionContext"],
  ["desktop", RemoteSurfaceRepository, "getRemoteDesktop"],
  ["browser", BrowserRepository, "browserIsOwnedBy"],
  [
    "chatStandalone",
    ChatRuntimeContextRepository,
    "getStandaloneChatExecutionContext",
  ],
]) {
  const calls = await capture(Constructor, method);
  assert.equal(calls.length, 1, key);
  entries[key] = calls[0];
}
const chat = await capture(
  ChatRuntimeContextRepository,
  "getChatExecutionContext",
);
assert.equal(chat.length, 2);
entries.chatIdentity = chat[0];
entries.chatProject = chat[1];
const worktree = await capture(ProjectRepository, "getProjectWorktreeContext", [
  owner,
  project,
  target,
]);
assert.equal(worktree.length, 1);
entries.runWorktree = worktree[0];
for (const [key, { params }] of Object.entries(entries)) {
  assert.ok(params.includes(owner) && params.includes(target));
  assert.ok(
    params.every(
      (value) =>
        typeof value === "number" ||
        [
          owner,
          target,
          project,
          "desktop",
          "remote-desktop",
          "standalone",
          "active",
          "ready",
        ].includes(value),
    ),
    JSON.stringify({ key, params }),
  );
}
const destination = new URL(
  "../../cantrip_server_rs/contracts/mcp-target-queries.json",
  import.meta.url,
);
const filename = fileURLToPath(destination);
const output = await format(JSON.stringify(entries), {
  ...(await resolveConfig(filename)),
  filepath: filename,
});
if (process.argv.includes("--write")) await writeFile(destination, output);
else assert.equal(await readFile(destination, "utf8"), output);
console.log(
  JSON.stringify({
    capturedSourceQueries: Object.keys(entries).length,
    parameters: Object.fromEntries(
      Object.entries(entries).map(([key, value]) => [key, value.params]),
    ),
  }),
);
