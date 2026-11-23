// Preserve the current server's 410 contracts for retired repository routes.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { removedPlaintextRepositoryRoute } from "../../tests/reference-node-server/src/app/shared/request-policy.ts";
import { repositoryRoot } from "./build.mjs";

export async function removedRepositoryContract() {
  const inventory = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "docs/security/server-route-inventory.json"),
      "utf8",
    ),
  );
  return inventory.routes
    .filter(
      ({ path }) =>
        removedPlaintextRepositoryRoute(path) ||
        path.endsWith("/git/agent/drafts"),
    )
    .map(({ method, path }) => ({
      method,
      path,
      gitAgent: path.endsWith("/git/agent/drafts"),
    }));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const target = path.join(
    repositoryRoot,
    "cantrip_server_rs/contracts/removed-repository-routes.json",
  );
  const contract = await removedRepositoryContract();
  if (process.argv.includes("--write"))
    await writeFile(target, JSON.stringify(contract, null, 2) + "\n");
  else assert.deepEqual(JSON.parse(await readFile(target, "utf8")), contract);
  console.log(
    JSON.stringify({
      routes: contract.length,
      mode: process.argv.includes("--write") ? "write" : "compare",
    }),
  );
}
