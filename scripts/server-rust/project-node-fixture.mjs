// Development-only driver of the actual reference connector/repository.
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { sql } = require("drizzle-orm");
import { readServerConfig } from "../../cantrip_server/src/config.ts";
import { connectDatabase } from "../../cantrip_server/src/db/index.ts";
console.error(JSON.stringify({ event: "repository-fixture.database.opening" }));
const database = await connectDatabase(readServerConfig());
console.error(JSON.stringify({ event: "repository-fixture.database.ready" }));
console.log(
  JSON.stringify({
    event: "server.listening",
    origin: "repository-fixture",
    locale: new Intl.Collator().resolvedOptions().locale,
  }),
);
try {
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    try {
      // Seeding owns only this disposable fixture. Runtime TS private storage is
      // used solely to exercise the actual connector on both PostgreSQL and PGlite.
      let value;
      if (request.op === "sql") {
        await database.repository.projects.database.execute(
          sql.raw(request.sql),
        );
        value = null;
      } else if (request.op === "transaction") {
        await database.repository.projects.database.transaction(
          async (transaction) => {
            for (const statement of request.statements)
              await transaction.execute(sql.raw(statement));
          },
        );
        value = null;
      } else if (request.op === "session-active")
        value = await database.repository.isUserSessionActive(
          request.session,
          request.owner,
        );
      else if (request.op === "scope") {
        const scope = request.scope;
        value =
          scope.kind === "current-user"
            ? true
            : scope.kind === "project"
              ? (await database.repository.listProjects(request.owner)).some(
                  (p) => p.id === scope.projectId,
                )
              : scope.kind === "chat"
                ? Boolean(
                    await database.repository.getChatExecutionContext(
                      request.owner,
                      scope.chatId,
                    ),
                  )
                : false;
      } else value = await database.repository.listProjects(request.owner);
      console.log(JSON.stringify({ id: request.id, rejected: false, value }));
    } catch (error) {
      console.log(
        JSON.stringify({
          id: request.id,
          rejected: true,
          diagnostic: error.cause?.message ?? error.message,
        }),
      );
    }
  }
} finally {
  await database.close();
}
