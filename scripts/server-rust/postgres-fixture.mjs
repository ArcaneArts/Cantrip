import { createRequire } from "node:module";
import path from "node:path";
import { buildRustExample, repositoryRoot } from "./build.mjs";
import { fixtureEnvironment, startServer } from "./process.mjs";

const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const postgres = require("postgres");

export async function postgresFixture(directory) {
  const executable = await buildRustExample("database-fixture");
  const owner = await startServer(
    executable,
    [
      "--data-dir",
      directory,
      "--postgres-bin-dir",
      process.env.CANTRIP_TEST_POSTGRES_BIN_DIR ?? "",
    ],
    { cwd: repositoryRoot, env: fixtureEnvironment(directory) },
  );
  const sql = postgres(owner.origin, { max: 1 });
  let sequence = 0;
  return {
    async database() {
      const name = `cantrip_auth_fixture_${sequence++}`;
      await sql`CREATE DATABASE ${sql(name)}`;
      const url = new URL(owner.origin);
      url.pathname = `/${name}`;
      return url.href;
    },
    async close() {
      await sql.end({ timeout: 5 });
      await owner.close();
    },
  };
}
