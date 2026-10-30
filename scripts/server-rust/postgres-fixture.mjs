import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { buildRustExample, repositoryRoot } from "./build.mjs";
import { fixtureEnvironment, startServer } from "./process.mjs";

const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const postgres = require("postgres");

export async function postgresFixture(directory, { url } = {}) {
  const executable = !url && (await buildRustExample("database-fixture"));
  const owner =
    !url &&
    (await startServer(
      executable,
      [
        "--data-dir",
        directory,
        "--postgres-bin-dir",
        process.env.CANTRIP_TEST_POSTGRES_BIN_DIR ?? "",
      ],
      { cwd: repositoryRoot, env: fixtureEnvironment(directory) },
    ));
  const connection = url || owner.origin;
  const sql = postgres(connection, { max: 1 });
  const names = [];
  const prefix = url
    ? "cantrip_transfer_" + randomUUID().replaceAll("-", "")
    : "cantrip_auth_fixture";
  let sequence = 0;
  return {
    async database() {
      const name = `${prefix}_${sequence++}`;
      await sql`CREATE DATABASE ${sql(name)}`;
      names.push(name);
      const databaseUrl = new URL(connection);
      databaseUrl.pathname = `/${name}`;
      return databaseUrl.href;
    },
    async close() {
      try {
        // For a caller-supplied test server, remove only databases this fixture
        // actually created. Never alter the caller's original database.
        if (url)
          for (const name of names)
            await sql`DROP DATABASE ${sql(name)} WITH (FORCE)`;
      } finally {
        await sql.end({ timeout: 5 });
        if (owner) await owner.close();
      }
    },
  };
}
