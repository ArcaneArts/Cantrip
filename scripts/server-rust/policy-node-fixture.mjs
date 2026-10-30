// Disposable IPC driver of the actual Node repository, using real migrations.
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { readServerConfig } from "../../cantrip_server/src/config.ts";
import { connectDatabase } from "../../cantrip_server/src/db/index.ts";
import { PolicyScopeNotFoundError } from "../../cantrip_server/src/db/policies.ts";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { sql } = require("drizzle-orm");
const database = await connectDatabase(readServerConfig());
const repository = database.repository.policies;
console.log(
  JSON.stringify({
    event: "server.listening",
    origin: "policy-repository-fixture",
  }),
);
try {
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    try {
      let value;
      switch (request.op) {
        case "sql":
          await repository.database.execute(sql.raw(request.sql));
          value = null;
          break;
        case "query-json": {
          const result = await repository.database.execute(
            sql.raw(request.sql),
          );
          value =
            (Array.isArray(result) ? result : result.rows)[0]?.result ?? null;
          break;
        }
        case "templates":
          value = repository.listTemplates();
          break;
        case "template":
          value = repository.getTemplate(request.key);
          break;
        case "list":
          value = await repository.list(request.owner);
          break;
        case "get":
          value = await repository.get(request.owner, request.policy);
          break;
        case "bootstrap":
          value = await repository.bootstrap(request.owner, request.input);
          break;
        case "create":
          value = await repository.create(request.owner, request.input);
          break;
        case "update":
          value = await repository.update(
            request.owner,
            request.policy,
            request.input,
          );
          break;
        case "delete":
          value = await repository.delete(
            request.owner,
            request.policy,
            request.version,
          );
          break;
        case "order":
          value = await repository.reorder(request.owner, request.input);
          break;
        case "replace":
          value = await (
            request.workspace
              ? repository.replaceWorkspaceAssignments
              : repository.replaceProjectAssignments
          ).call(repository, request.owner, request.scope, request.input);
          break;
        case "assignments":
          value = await (
            request.workspace
              ? repository.listWorkspaceAssignments
              : repository.listProjectAssignments
          ).call(repository, request.owner, request.scope);
          break;
        case "effective":
          value = await repository.resolveEffective(
            request.owner,
            request.project,
          );
          break;
        case "standalone":
          value = await repository.resolveStandalone(request.owner);
          break;
        default:
          throw new Error("Unknown policy fixture operation: " + request.op);
      }
      console.log(JSON.stringify({ id: request.id, rejected: false, value }));
    } catch (error) {
      console.log(
        JSON.stringify({
          id: request.id,
          rejected: true,
          code:
            error instanceof PolicyScopeNotFoundError
              ? "scope-not-found"
              : error.code,
          diagnostic: error.cause?.message ?? error.message,
        }),
      );
    }
  }
} finally {
  await database.close();
}
