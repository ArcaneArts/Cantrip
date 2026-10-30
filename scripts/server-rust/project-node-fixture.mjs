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
import { lockNativeCommandChat } from "../../cantrip_server/src/db/repository/native-command-lock.ts";
import { assertNativeRuntimeWritable } from "../../cantrip_server/src/db/repository/native-runtime-handoff-guard.ts";
import { managedConsoleFixture } from "./managed-console-node-fixture.mjs";
import { gitManagedOperationContext } from "../../cantrip_server/src/app/shared/git-managed-operations.ts";
import { worktreeCoordinatorFixture } from "./worktree-coordinator-node-fixture.mjs";
import { conversionFixture } from "./conversion-node-fixture.mjs";
import { discoveryFixture } from "./discovery-node-fixture.mjs";
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
    const consoleTrace = [];
    try {
      // Seeding owns only this disposable fixture. Runtime TS private storage is
      // used solely to exercise the actual connector on both PostgreSQL and PGlite.
      let value;
      if (request.op.startsWith("console-")) {
        value = await managedConsoleFixture(
          database.repository,
          request,
          consoleTrace,
        );
        value = { result: value, trace: consoleTrace };
      } else if (request.op.startsWith("discovery-")) {
        value = await discoveryFixture(
          database.repository.workspaceRepositoryDiscoveryJobs,
          request,
          database.repository,
        );
      } else if (request.op.startsWith("conversion-")) {
        value = await conversionFixture(
          database.repository.projectGithubConversionJobs,
          request,
        );
      } else if (request.op.startsWith("replica-")) {
        const repo = database.repository.projectReplicaJobs;
        const {
          owner,
          job,
          command,
          attempt,
          revision,
          update,
          error,
          worker,
        } = request;
        switch (request.op) {
          case "replica-provision":
            value = await repo.createProvision(
              owner,
              request.project,
              request.input,
            );
            break;
          case "replica-synchronize":
            value = await repo.createSynchronize(
              owner,
              request.project,
              request.replica,
              request.input,
            );
            break;
          case "replica-remove":
            value = await repo.createRemove(
              owner,
              request.project,
              request.replica,
              request.input,
            );
            break;
          case "replica-context":
            value = await repo.operationContext(job, command);
            break;
          case "replica-repair-context":
            value = await repo.linkRepairContext(
              owner,
              request.project,
              request.replica,
            );
            break;
          case "replica-removal-blocker":
            value = await repo.removalBlocker(request.replica, job);
            break;
          case "replica-removal-start":
            value = await repo.markRemovalStarted(request.replica);
            break;
          case "replica-removal-restore":
            await repo.restoreRemovalReady(request.replica);
            value = null;
            break;
          case "replica-complete-provision":
            value = await repo.completeProvision(job, command, request.result);
            break;
          case "replica-complete-synchronize":
            value = await repo.completeSynchronize(
              job,
              command,
              request.result,
            );
            break;
          case "replica-complete-remove":
            value = await repo.completeRemove(job, command, request.result);
            break;
          case "replica-provision-race":
            value = (
              await Promise.allSettled([
                repo.createProvision(owner, request.project, request.input),
                repo.createProvision(owner, request.project, request.input),
              ])
            ).map((r) =>
              r.status === "fulfilled"
                ? { ok: r.value }
                : { error: r.reason.message, kind: r.reason.constructor.name },
            );
            break;
          case "replica-get":
            value = await repo.get(owner, job);
            break;
          case "replica-list":
            value = await repo.list(owner, request.project);
            break;
          case "replica-claim":
            value = await repo.claimNext();
            break;
          case "replica-renew":
            value = await repo.renewLease(job, command, attempt);
            break;
          case "replica-progress":
            value = await repo.updateProgress(job, command, attempt, update);
            break;
          case "replica-block":
            value = await repo.block(job, command, error);
            break;
          case "replica-fail":
            value = await repo.fail(job, command, error);
            break;
          case "replica-retry":
            value = await repo.retry(owner, job, revision);
            break;
          case "replica-cancel":
            value = await repo.cancel(owner, job, revision);
            break;
          case "replica-recover":
            value = await repo.recoverInterrupted(
              request.force,
              new Date(request.now),
            );
            break;
          case "replica-requeue":
            value = await repo.requeueRetryableForWorker(worker);
            break;
          default:
            throw new Error("Unknown replica fixture operation");
        }
      } else if (request.op.startsWith("browser-")) {
        const repo = database.repository;
        switch (request.op) {
          case "browser-list":
            value = await repo.listBrowsers(request.owner, request.project);
            break;
          case "browser-owned":
            value = await repo.browserIsOwnedBy(request.owner, request.browser);
            break;
          case "browser-create":
            value = await repo.createBrowser(
              request.owner,
              request.project,
              request.input,
              request.connected
                ? (id) => request.connected.includes(id)
                : undefined,
            );
            break;
          case "browser-update":
            value = await repo.updateBrowser(
              request.owner,
              request.browser,
              request.input,
            );
            break;
          case "browser-delete":
            value = await repo.deleteBrowser(request.owner, request.browser);
            break;
          default:
            throw new Error("Unknown browser operation");
        }
      } else if (request.op.startsWith("project-surface-")) {
        const repo = database.repository;
        const { owner, project, subject, input, kind } = request;
        const suffix = {
          explorer: "Explorer",
          code: "CodeTab",
          view: "ProjectView",
        }[kind];
        switch (request.op) {
          case "project-surface-list":
            value = await repo[`list${suffix}s`](owner, project);
            break;
          case "project-surface-context":
            value = await repo[`get${suffix}ExecutionContext`](owner, subject);
            break;
          case "project-surface-project":
            value = await repo.getProjectViewProjectId(owner, subject);
            break;
          case "project-surface-update":
            value = await repo[`update${suffix}`](owner, subject, input);
            break;
          case "project-surface-worktree":
            value = await repo[`update${suffix}Worktree`](
              owner,
              subject,
              input,
            );
            break;
          case "project-surface-state":
            value = await repo.updateExplorerViewState(owner, subject, input);
            break;
          case "project-surface-pin":
            value = await repo.pinExplorer(owner, subject, input);
            break;
          case "project-surface-create":
            value = await repo[`create${suffix}`](owner, project, input);
            break;
          case "project-surface-delete":
            value = await repo[`delete${suffix}`](owner, subject);
            break;
          default:
            throw new Error("Unknown surface fixture operation");
        }
      } else if (request.op.startsWith("layout-")) {
        const repo = database.repository.tabLayouts;
        const { owner, project, subject, input } = request;
        switch (request.op) {
          case "layout-get":
            value = await repo.get(owner, project);
            break;
          case "layout-title":
            value = await repo.updatePane(owner, project, subject, input);
            break;
          case "layout-pane-order":
            value = await repo.reorderPanes(owner, project, input);
            break;
          case "layout-legacy-order":
            value = await repo.reorderLegacyPanes(owner, project, input);
            break;
          case "layout-member-order":
            value = await repo.reorderMembers(owner, project, subject, input);
            break;
          case "layout-dock":
            value = await repo.updateDockPresentation(owner, project, input);
            break;
          case "layout-resize":
            value = await repo.resizeCenterSplit(
              owner,
              project,
              subject,
              input,
            );
            break;
          case "layout-move":
            value = await repo.moveMember(owner, project, input);
            break;
          case "layout-split":
            value = await repo.splitMember(owner, project, input);
            break;
          case "layout-launchers":
            value = await repo.listSurfaceLaunchers(owner, project);
            break;
          case "layout-pin":
            value = await repo.setSurfaceLauncherPin(owner, project, input);
            break;
          case "layout-open":
            value = await repo.openSurfaceView(owner, project, input);
            break;
          case "layout-close":
            value = await repo.closeSurfaceView(owner, project, input);
            break;
          case "layout-builtin-worktree":
            value = await repo.updateBuiltInSurfaceWorktree(
              owner,
              project,
              subject,
              input.worktreeId,
            );
            break;
          default:
            throw new Error("Unknown pane fixture operation");
        }
      } else if (request.op.startsWith("workspace-")) {
        const repo = database.repository.workspaceLayouts;
        const input =
          request.inputRaw === undefined
            ? request.input
            : JSON.parse(request.inputRaw);
        if (request.op === "workspace-get")
          value = await repo.get(
            request.owner,
            request.project,
            request.workspace,
          );
        else if (request.op === "workspace-seed")
          value = await repo.seed(
            request.owner,
            request.project,
            request.workspace,
            input.mainWindowId,
            input,
          );
        else if (request.op === "workspace-execute")
          value = await repo.execute(request.owner, input);
        else if (request.op === "workspace-import")
          value = await repo.importLegacyFiles(
            request.owner,
            request.project,
            request.workspace,
            input,
          );
        else throw new Error("Unknown workspace operation");
      } else if (request.op.startsWith("document-")) {
        const repo = database.repository.fileDocuments;
        switch (request.op) {
          case "document-list":
            value = await repo.list(request.owner, request.project);
            break;
          case "document-get":
            value = await repo.get(request.owner, request.document);
            break;
          case "document-context":
            value = await repo.executionContext(
              request.owner,
              request.document,
            );
            break;
          case "document-create":
            value = await repo.create(
              request.owner,
              request.project,
              request.input,
            );
            break;
          default:
            throw new Error("Unknown document operation");
        }
      } else if (request.op === "sql") {
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
      } else if (request.op === "surface-context") {
        value = await database.repository.getRemoteSurfaceExecutionContext(
          request.owner,
          request.surface,
        );
      } else if (request.op === "surface-status") {
        await database.repository.setRemoteSurfaceStatus(
          request.surface,
          request.status,
          request.error,
        );
        value = null;
      } else if (request.op === "surface-reset") {
        await database.repository.resetTransientRemoteSurfaceStatuses();
        value = null;
      } else if (request.op === "surface-ensure-browsers") {
        await database.repository.ensureBrowserRemoteSurfaces(request.owner);
        value = null;
      } else if (request.op === "chat-context") {
        value = await database.repository.getChatExecutionContext(
          request.owner,
          request.chat,
        );
      } else if (request.op === "chat-model") {
        value = await database.repository.setChatModel(
          request.owner,
          request.chat,
          { modelId: request.model },
          request.reasoningEffort,
        );
      } else if (request.op === "chat-runtime") {
        await database.repository.updateChatRuntime(
          request.chat,
          request.worker,
          request.worktree ?? null,
          request.thread ?? null,
          request.route,
          request.status ?? "ready",
          request.providerAccountId,
          request.scratchRoot ?? null,
        );
        value = null;
      } else if (request.op === "chat-guard") {
        await database.repository.projects.database.transaction(async (tx) => {
          await lockNativeCommandChat(tx, request.owner, request.chat);
          await assertNativeRuntimeWritable(
            tx,
            request.chat,
            request.generation,
            request.epoch,
            request.access ?? "write",
          );
        });
        value = null;
      } else if (request.op === "mcp-effective") {
        value = await database.repository.listEffectiveMcpServers(
          request.owner,
          request.project ?? null,
          request.worker,
          request.audience,
        );
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
      } else if (
        request.op.startsWith("project-surface-") ||
        request.op.startsWith("tunnel-")
      ) {
        value = await (
          await import("./tunnel-node-fixture.mjs")
        ).tunnelOperation(database.repository, request);
      } else if (request.op.startsWith("terminal-")) {
        const repo = database.repository;
        switch (request.op) {
          case "terminal-list":
            value = await repo.listTerminals(request.owner, request.project);
            break;
          case "terminal-context":
            value = await repo.getTerminalExecutionContext(
              request.owner,
              request.terminal,
            );
            break;
          case "terminal-update":
            value = await repo.updateTerminal(
              request.owner,
              request.terminal,
              request.input,
            );
            break;
          case "terminal-worktree":
            value = await repo.updateTerminalWorktree(
              request.owner,
              request.terminal,
              request.input,
            );
            break;
          case "terminal-delete":
            value = await repo.deleteTerminal(request.owner, request.terminal);
            break;
          case "terminal-service":
            value = await repo.updateTerminalService(
              request.owner,
              request.terminal,
              request.input,
            );
            break;
          case "terminal-create":
            value = await repo.createTerminal(
              request.owner,
              request.project,
              request.input,
              (id) => request.connected?.includes(id) ?? false,
            );
            break;
          default:
            throw new Error("Unknown terminal operation");
        }
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
      else if (request.op === "git-agent-usage") {
        const { runtime, execution } = request;
        const attempt = request.operation + ":" + runtime.routeId;
        await database.repository.recordTokenUsage(request.owner, {
          sourceKey: "git-agent:" + attempt,
          projectId: request.project,
          chatId: null,
          modelRouteId: runtime.routeId,
          providerAccountId: runtime.provider.accountId,
          workerId: request.worker,
          turnId: execution.turnId,
          executionAttemptId: attempt,
          attemptKind: "git-agent",
          attemptStatus: "completed",
          reasoningEffort: runtime.model.reasoningEffort,
          workerVersion: null,
          serverVersion: "fixture-version",
          usage: execution.measuredUsage,
        });
        value = null;
      } else if (request.op === "run-secret-race") {
        value = await Promise.all(
          request.inputs.map((input) =>
            database.repository.setRunConfigurationSecret(
              request.owner,
              request.project,
              input,
            ),
          ),
        );
      } else if (request.op === "run-secret-set") {
        value = await database.repository.setRunConfigurationSecret(
          request.owner,
          request.project,
          request.input,
        );
      } else if (request.op === "run-secret-list") {
        value = await database.repository.listRunConfigurationSecretSummaries(
          request.owner,
          request.project,
        );
      } else if (request.op.startsWith("run-runtime-")) {
        switch (request.op) {
          case "run-runtime-observation-race":
            value = await Promise.all(
              request.inputs.map((observation) =>
                database.repository.applyRunConfigurationRuntimeObservation(
                  request.owner,
                  request.worker,
                  observation,
                ),
              ),
            );
            break;
          case "run-runtime-race":
            value = await Promise.all(
              request.inputs.map((input) =>
                database.repository.requestRunConfigurationRuntimeOperation(
                  request.owner,
                  input,
                ),
              ),
            );
            break;
          case "run-runtime-request":
            value =
              await database.repository.requestRunConfigurationRuntimeOperation(
                request.owner,
                request.input,
              );
            break;
          case "run-runtime-get":
            value = await database.repository.getRunConfigurationRuntime(
              request.owner,
              request.project,
              request.configuration,
              request.worktree,
            );
            break;
          case "run-runtime-list":
            value = await database.repository.listRunConfigurationRuntimes(
              request.owner,
              request.project,
              {
                configurationId: request.configuration,
                worktreeId: request.worktree,
                limit: request.limit,
              },
            );
            break;
          case "run-runtime-identities":
            value =
              await database.repository.listActiveRunConfigurationRuntimeIdentitiesForWorker(
                request.owner,
                request.worker,
              );
            break;
          case "run-runtime-delete":
            value = await database.repository.deleteRunConfigurationRuntimes(
              request.owner,
              request.project,
              request.ids,
            );
            break;
          case "run-runtime-observe":
            value =
              await database.repository.applyRunConfigurationRuntimeObservation(
                request.owner,
                request.worker,
                request.observation,
              );
            break;
          default:
            throw new Error("Unknown runtime operation");
        }
      } else if (request.op === "worktree-coordinator") {
        value = await worktreeCoordinatorFixture(
          database,
          request,
          (statement) =>
            database.repository.projects.database.execute(sql.raw(statement)),
        );
      } else if (request.op === "worktree-rollback") {
        value = await database.repository.rollbackProjectWorktreeCreation(
          request.owner,
          request.project,
          request.worker,
          request.created,
        );
      } else if (request.op === "worktree-set-lifecycle") {
        value = await database.repository.setProjectWorktreeLifecycle(
          request.owner,
          request.project,
          request.worktree,
          request.state,
        );
      } else if (request.op === "worktree-observe") {
        value = await database.repository.observeProjectWorktree(
          request.owner,
          request.project,
          request.worktree,
          request.observed,
        );
      } else if (request.op === "worktree-removal-blockers") {
        value = await database.repository.getWorktreeRemovalBlockers(
          request.owner,
          request.project,
          request.worktree,
        );
      } else if (request.op === "inventory-reconcile") {
        value = await database.repository.reconcileProjectWorktrees(
          request.owner,
          request.project,
          request.worker,
          request.inventory,
          request.created,
        );
      } else if (request.op === "observation-context") {
        value = await database.repository.getProjectWorktreeObservationContext(
          request.owner,
          request.worker,
          request.source,
          request.worktreePath,
        );
      } else if (request.op === "observation-operation") {
        const active = await database.repository.getActiveGitOperation(
          request.owner,
          request.project,
          request.worktree,
        );
        value = active
          ? {
              id: active.id,
              workerId: active.workerId,
              context: gitManagedOperationContext(active),
            }
          : null;
      } else if (request.op === "observation-source")
        value = await database.repository.getProjectSource(
          request.owner,
          request.project,
          { isWorkerAvailable: (worker) => request.connected.includes(worker) },
        );
      else if (request.op === "observation-targets")
        value = await database.repository[
          request.gitOnly
            ? "listWorkerWorktreeObservationTargets"
            : "listWorkerExecutionRootContexts"
        ](request.owner, request.worker, request.limit);
      else if (request.op === "observation-paths")
        value =
          await database.repository.reconcileWorkerProjectObservationPaths(
            request.owner,
            request.worker,
            request.paths,
          );
      else if (request.op === "worktree-context")
        value = await database.repository.getProjectWorktreeContext(
          request.owner,
          request.project,
          request.worktree,
        );
      else if (request.op === "github-context")
        value = await database.repository.getGithubProjectExecutionContext(
          request.owner,
          request.project,
          request.worker,
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
          ...((request.op === "sql" ||
            request.op.startsWith("project-surface-") ||
            request.op.startsWith("discovery-") ||
            request.op.startsWith("tunnel-") ||
            request.op.startsWith("browser-") ||
            request.op.startsWith("document-") ||
            request.op.startsWith("workspace-") ||
            request.op.startsWith("layout-")) &&
          error.cause?.code
            ? { databaseCode: error.cause.code }
            : {}),
          ...(request.op.startsWith("console-")
            ? {
                trace: consoleTrace,
                ...(error.failure ? { failure: error.failure } : {}),
                ...(error.code ? { code: error.code } : {}),
              }
            : {}),
          ...(request.op.startsWith("project-surface-") ||
          request.op.startsWith("workspace-") ||
          request.op.startsWith("layout-")
            ? {
                errorName: error.name,
                ...(error.code ? { code: error.code } : {}),
                ...(error.statusCode ? { statusCode: error.statusCode } : {}),
              }
            : {}),
          diagnostic:
            request.op.startsWith("project-surface-") ||
            request.op.startsWith("terminal-") ||
            request.op.startsWith("browser-") ||
            request.op.startsWith("document-") ||
            request.op.startsWith("workspace-") ||
            request.op.startsWith("layout-")
              ? error.message
              : (error.cause?.message ?? error.message),
          ...(request.op.startsWith("replica-")
            ? { replicaError: error.constructor.name }
            : {}),
          ...(request.op.startsWith("conversion-")
            ? { conversionError: error.constructor.name }
            : {}),
          ...(request.op.startsWith("discovery-")
            ? { discoveryError: error.constructor.name }
            : {}),
          ...(request.op.startsWith("folder-")
            ? { folderError: error.constructor.name }
            : {}),
          ...([
            "placement",
            "target-resolve",
            "terminal-create",
            "browser-create",
            "chat-model",
            "chat-runtime",
            "chat-guard",
          ].includes(request.op)
            ? { code: error.code }
            : {}),
        }),
      );
    }
  }
} finally {
  await database.close();
}
