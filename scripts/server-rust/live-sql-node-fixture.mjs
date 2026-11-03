// Disposable setup control, installed only by the explicitly opted-in oracle.
// Use its existing connection so live PGlite is never reopened by a helper.
import { createRequire } from "node:module";

const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { sql } = require("drizzle-orm");

export function installLiveSqlFixture(app, database) {
  app.post("/__fixture/sql", async (request) => {
    let values;
    try {
      values = await database.repository.settings.database.transaction(
        async (tx) => {
          for (const statement of request.body.statements)
            await tx.execute(sql.raw(statement));
          const values = [];
          for (const query of request.body.queries ?? []) {
            const result = await tx.execute(sql.raw(query));
            const row = (Array.isArray(result) ? result : result.rows)[0];
            values.push(JSON.parse(row.result));
          }
          return values;
        },
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "fixture.sql.failed",
          message: error.cause?.message ?? error.name,
          code: error.cause?.code ?? null,
        }),
      );
      throw error;
    }
    return values.length ? { ok: true, values } : { ok: true };
  });
}
