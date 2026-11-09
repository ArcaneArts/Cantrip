// Capture actual Source query builders. This does not replace SQL acceptance.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import * as schema from "../../tests/reference-node-server/src/db/schema.ts";
import { McpRepository } from "../../tests/reference-node-server/src/db/repository/mcp.ts";
import { WorkerRepository } from "../../tests/reference-node-server/src/db/repository/workers.ts";
const require = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
);
const { drizzle } = require("drizzle-orm/pg-proxy");
const realDate = Date,
  now = "2026-11-03T12:00:00.123Z";
globalThis.Date = class extends realDate {
  constructor(...args) {
    super(...(args.length ? args : [now]));
  }
  static now() {
    return realDate.parse(now);
  }
};
const bytes = (n) => Buffer.alloc(n, 1).toString("base64url");
const input = {
  id: "88888888-8888-4888-8888-000000000001",
  workerId: null,
  nameBlindIndex: bytes(32),
  protectedConfiguration: {
    formatVersion: 1,
    keyRevision: 1,
    envelope: {
      version: 1,
      algorithm: "AES-256-GCM",
      keyRevision: 1,
      nonce: bytes(12),
      ciphertext: bytes(32),
    },
  },
  enabled: true,
  audience: "ide",
};
const row = {
  ...input,
  ownerId: "owner",
  projectId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};
let names = [],
  results = [];
const captured = {};
function wrap(builder) {
  return new Proxy(builder, {
    get(target, key) {
      if (key === "then")
        return (resolve, reject) => {
          try {
            const name = names.shift();
            assert(name, "Unexpected Source query");
            captured[name] = target.toSQL();
            return Promise.resolve(results.shift()).then(resolve, reject);
          } catch (e) {
            return Promise.reject(e).then(resolve, reject);
          }
        };
      const value = Reflect.get(target, key);
      return typeof value === "function"
        ? (...args) => wrap(value.apply(target, args))
        : value;
    },
  });
}
const source = drizzle(
  async () => {
    throw Error("Unexpected database execution during generation");
  },
  { schema },
);
const db = new Proxy(source, {
  get(target, key) {
    const value = Reflect.get(target, key);
    return typeof value === "function"
      ? (...args) => wrap(value.apply(target, args))
      : value;
  },
});
const repo = new McpRepository(db, {
  getWorker: async () => ({ workerId: "worker" }),
  getModelProvider: async () => null,
});
async function capture(labels, rows, op) {
  names = [...labels];
  results = [...rows];
  await op();
  assert.equal(names.length, 0);
  assert.equal(results.length, 0);
}
try {
  for (const project of [null, "project"]) {
    const scope = project ? "project" : "global";
    const labels = project ? [scope + "-project-check"] : [];
    const rows = project ? [[{ id: project }]] : [];
    await capture([...labels, scope + "-list"], [...rows, []], () =>
      repo.listMcpServers("owner", project),
    );
    await capture([...labels, scope + "-create"], [...rows, [row]], () =>
      repo.createMcpServer("owner", project, input),
    );
    for (const audience of [false, true]) {
      const update = { ...input };
      delete update.id;
      if (!audience) delete update.audience;
      await capture([scope + "-update-" + audience], [[row]], () =>
        repo.updateMcpServer("owner", project, input.id, update),
      );
    }
    await capture([scope + "-delete"], [[{ id: input.id }]], () =>
      repo.deleteMcpServer("owner", project, input.id),
    );
  }
  await capture(["worker-lookup"], [[]], () =>
    new WorkerRepository(db).getWorker("owner", "worker"),
  );
  const destination = new URL(
    "../../cantrip_server_rs/contracts/mcp-settings-queries.json",
    import.meta.url,
  );
  const encoded = await format(JSON.stringify({ queries: captured }), {
    ...(await resolveConfig(fileURLToPath(destination))),
    parser: "json",
  });
  if (process.argv.includes("--write")) await writeFile(destination, encoded);
  else
    assert.deepEqual(
      JSON.parse(await readFile(destination, "utf8")),
      JSON.parse(encoded),
      "MCP SQL manifest differs from actual Source",
    );
  console.log(
    JSON.stringify({
      queries: Object.keys(captured).length,
      source: "actual McpRepository builders",
    }),
  );
} finally {
  globalThis.Date = realDate;
}
