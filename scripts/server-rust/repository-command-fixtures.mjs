import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  repositoryOperationTypeSchema,
  workerCommandSchema,
} from "../../packages/protocol/dist/index.js";
import { removedPlaintextRepositoryRoute } from "../../tests/reference-node-server/src/app/shared/request-policy.ts";

export async function repositoryCommandFixtures() {
  const corpus = JSON.parse(
    await readFile(new URL("./worker-command-fixtures.json", import.meta.url)),
  );
  const inventory = JSON.parse(
    await readFile(
      new URL(
        "../../docs/security/server-route-inventory.json",
        import.meta.url,
      ),
    ),
  );
  const commands = new Map(
    corpus.commands.map((sample) => [
      sample.type,
      workerCommandSchema.parse(sample.input.command),
    ]),
  );
  const types = repositoryOperationTypeSchema.options.filter(
    (type) => /^(git|github)\./.test(type) && commands.has(type),
  );
  assert.equal(new Set(types).size, types.length);
  const cases = types.map((type) => {
    const { type: actual, ...args } = commands.get(type);
    assert.equal(actual, type);
    return { type, arguments: args };
  });
  return {
    cases,
    legacyRoutes: inventory.routes.filter((route) =>
      removedPlaintextRepositoryRoute(route.path),
    ),
    classification:
      "Endpoint-protected repository inner operations; the server dispatches repository.operation. Legacy plaintext HTTP producers are tombstoned. Full worker execution remains a separate scope.",
  };
}
