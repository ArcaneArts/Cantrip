// Development-only driver of the actual reference connector/repository.
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { sql } = require("drizzle-orm");
import { readServerConfig } from "../../cantrip_server/src/config.ts";
import { connectDatabase } from "../../cantrip_server/src/db/index.ts";
import { buildExecutionTargetCatalog } from "../../cantrip_server/src/execution-targets/catalog.ts";
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
      } else if (request.op === "query-json") {
        const result = await database.repository.projects.database.execute(
          sql.raw(request.sql),
        );
        value =
          (Array.isArray(result) ? result : result.rows)[0]?.result ?? null;
      } else if (request.op === "terminal-services") {
        value = await database.repository.listTerminalServicesForWorker(
          request.worker,
          request.server,
        );
      } else if (request.op === "terminal-status") {
        await database.repository.setTerminalStatus(
          request.terminal,
          request.status,
        );
        value = null;
      } else if (request.op.startsWith("folder-")) {
        const repo = database.repository;
        const jobs = repo.projectFolderSetupJobs;
        switch (request.op) {
          case "folder-default":
            value = {
              id: (await repo.ensureDefaultProjectWorkspace(request.owner)).id,
            };
            break;
          case "folder-storage":
            value = await repo.getProjectWorkspaceStorageContext(
              request.owner,
              request.project,
            );
            break;
          case "folder-create":
            value = await repo.createManagedFolderProject(
              request.owner,
              request.input,
            );
            break;
          case "folder-get":
            value = await jobs.get(request.owner, request.project);
            break;
          case "folder-claim":
            value = await jobs.claimNext();
            break;
          case "folder-renew":
            value = await jobs.renewLease(
              request.job,
              request.command,
              request.attempt,
            );
            break;
          case "folder-settle":
            value = await jobs[request.state === "failed" ? "fail" : "block"](
              request.job,
              request.command,
              request.error,
            );
            break;
          case "folder-complete":
            value = await jobs.complete(
              request.job,
              request.command,
              request.input,
            );
            break;
          case "folder-retry":
            value = await jobs.retry(
              request.owner,
              request.project,
              request.revision,
            );
            break;
          case "folder-recover":
            value = await jobs.recoverInterrupted(
              request.force ?? true,
              request.at ? new Date(request.at) : new Date(),
            );
            break;
          case "folder-requeue":
            value = await jobs.requeueRetryableForWorker(request.worker);
            break;
          default:
            throw new Error("Unknown folder fixture operation");
        }
      } else if (request.op === "session-active")
        value = await database.repository.isUserSessionActive(
          request.session,
          request.owner,
        );
      else if (request.op === "target-resolve")
        value = await database.repository.resolveExecutionTarget(
          request.owner,
          request.project,
          request.target,
          Array.isArray(request.connected)
            ? (worker) => request.connected.includes(worker)
            : undefined,
          request.allowUnavailable ?? false,
        );
      else if (request.op === "catalog-repository")
        value = await database.repository.listProjectExecutionTargets(
          request.owner,
          request.project,
          Array.isArray(request.connected)
            ? (worker) => request.connected.includes(worker)
            : undefined,
        );
      else if (request.op === "target-catalog")
        value = buildExecutionTargetCatalog({
          ...request.input,
          ...(Array.isArray(request.connected)
            ? {
                isWorkerConnected: (worker) =>
                  request.connected.includes(worker),
              }
            : {}),
        });
      else if (request.op === "placement")
        value = await database.repository.resolveProjectExecutionPlacement(
          request.owner,
          request.project,
          request.surface,
          request.target,
          Array.isArray(request.connected)
            ? (worker) => request.connected.includes(worker)
            : undefined,
          request.allowOffline ?? false,
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
          diagnostic: request.op.startsWith("terminal-")
            ? error.message
            : (error.cause?.message ?? error.message),
          ...(request.op.startsWith("folder-")
            ? { folderError: error.constructor.name }
            : {}),
          ...(["placement", "target-resolve"].includes(request.op)
            ? { code: error.code }
            : {}),
        }),
      );
    }
  }
} finally {
  await database.close();
}
