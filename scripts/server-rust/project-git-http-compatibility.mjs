import { runSecretHttpCases } from "./run-secret-http-cases.mjs";
// Actual Node/Rust HTTP routes with the unchanged worker protocol decoder.
import {
  runLifecycleCases,
  runDefinition,
} from "./run-lifecycle-http-cases.mjs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import {
  targetStateSql,
  localOwner,
  otherOwner,
  literal,
} from "./project-target-state.mjs";
import { fileDocumentWireFixtures } from "./file-document-wire-fixtures.mjs";
import { fileDocumentHttpWorker } from "./file-document-http-worker.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import { LiveProbe, currentUser } from "./live-sockets.mjs";
import { eventually } from "./full-worker.mjs";
import { observeResponseCompletion } from "./response-observations.mjs";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const gitProject = "99999999-9999-4999-8999-999999999999";
const runtimeWorktree = "55555555-5555-4555-8555-555555555555";
const runtimeId = "66666666-6666-4666-8666-666666666666";
const observedRuntime = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const lostRuntime = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const root = await mkdtemp(path.join(tmpdir(), "cantrip-project-git-http-"));
const report = {
  suite: "project-git-http",
  databaseMode,
  completeReplacement: false,
  profiles: [],
};
let pg, failure;
try {
  const executable = await buildRustServer(),
    repositoryBinary = await buildRustExample("project-repository-fixture");
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  const passwordHash = await hashPassword(password);
  for (const profile of option("--profile")
    ? [option("--profile")]
    : ["none", "password", "accounts"]) {
    const runtimes = [];
    report.profiles.push({ profile, runtimes });
    for (const kind of ["node", "rust"]) {
      const databaseUrl =
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined;
      const fixture = new HttpFixture({
        kind,
        executable,
        root,
        name: profile,
        databaseMode,
        responseObservations: true,
        environment: {
          CANTRIP_FIXTURE_LOGGING: process.env.CANTRIP_FIXTURE_LOGGING,
          CANTRIP_AUTH_MODE: profile,
          CANTRIP_REGISTRATION_ENABLED: "true",
          ...(profile === "password"
            ? { CANTRIP_PASSWORD_HASH: passwordHash }
            : {}),
          ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
          ...(kind === "rust" && databaseMode === "bundled-postgres"
            ? {
                CANTRIP_POSTGRES_BIN_DIR:
                  process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
              }
            : {}),
        },
      });
      const result = { kind, observations: [], commands: [], changes: [] };
      runtimes.push(result);
      let repo, worker, live;
      let agentRoute = "git-route";
      let runtimeReplyMode = "exited";
      let runtimeReconcileLost = false;
      let outputMismatch = null;
      const visit = async (name, method, url, options = {}) => {
        const before = live?.history.length ?? 0;
        const response = await fixture.observe(name, method, url, {
          csrf: !!fixture.client(options.client).csrf,
          ...options,
        });
        result.observations.push({ name, ...response });
        if (live) {
          if (kind === "node") await observeResponseCompletion(fixture, name);
          await live.ping(name + " completed");
          const changes = live.history
            .slice(before)
            .filter(
              (e) =>
                e.type === "event" &&
                [
                  "worktree",
                  "project-token-usage",
                  "run",
                  "terminal",
                  "run-configuration",
                ].includes(e.resource),
            )
            .map(
              ({ resource, scope, entityId, revision, payload, action }) => ({
                resource,
                scope,
                entityId,
                revision,
                payload,
                action,
              }),
            );
          result.changes.push({ name, events: fixture.normalize(changes) });
        }
        return fixture.records.get(name);
      };
      try {
        await fixture.start();
        let owner = localOwner,
          other = otherOwner;
        if (profile === "accounts") {
          for (const client of ["main", "other"])
            await visit("register " + client, "POST", "/api/auth/register", {
              client,
              json: {
                email: `git-${client}@example.invalid`,
                displayName: client,
                password,
              },
              status: 201,
            });
          owner = fixture.records.get("register main").currentUser.id;
          other = fixture.records.get("register other").currentUser.id;
        } else if (profile === "password")
          await visit("login", "POST", "/api/auth/login", {
            json: { password },
          });
        else await visit("session", "GET", "/api/auth/session");
        await fixture.close();
        repo = await repositoryFixture({
          kind,
          executable: repositoryBinary,
          root: path.join(root, profile),
          databaseMode,
          databaseUrl,
        });
        for (const sql of targetStateSql(owner, other))
          await repo.seed(
            sql.startsWith("INSERT INTO projects(")
              ? sql.replace("VALUES('github'", `VALUES('${gitProject}'`)
              : sql.replaceAll("'github'", `'${gitProject}'`),
          );
        await repo.seed(
          `UPDATE project_sources SET removed_at='2026-10-25' WHERE project_id<>'${gitProject}'`,
        );
        await repo.seed(
          `INSERT INTO project_worktrees (id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state) VALUES ('${runtimeWorktree}','github-alpha','alpha','runtime','ctrr_${"r".repeat(43)}','runtime',false,'user','ready')`,
        );
        await repo.seed(
          `INSERT INTO run_configuration_runtimes (id,owner_id,project_id,configuration_id,worktree_id,worker_id,terminal_id,definition_revision,generation,requested_operation_id,state) VALUES ('${runtimeId}',${literal(owner)},'${gitProject}','77777777-7777-4777-8777-777777777777','${runtimeWorktree}','alpha','${runtimeId}','${"a".repeat(64)}',3,'88888888-8888-4888-8888-888888888888','running')`,
        );
        await repo.seed(
          `INSERT INTO terminals (id,project_id,kind,status,active_worker_id,worktree_id,run_configuration_id,run_configuration_runtime_id,service_enabled) VALUES ('${runtimeId}','${gitProject}','run-configuration','running','alpha','${runtimeWorktree}','77777777-7777-4777-8777-777777777777','${runtimeId}',false)`,
        );
        for (const id of [observedRuntime, lostRuntime]) {
          await repo.seed(
            `INSERT INTO run_configuration_runtimes (id,owner_id,project_id,configuration_id,worktree_id,worker_id,terminal_id,definition_revision,generation,requested_operation_id,state) VALUES ('${id}',${literal(owner)},'${gitProject}','${id}','${runtimeWorktree}','alpha','${id}','${"a".repeat(64)}',3,'88888888-8888-4888-8888-888888888888','running')`,
          );
          await repo.seed(
            `INSERT INTO terminals (id,project_id,kind,status,active_worker_id,worktree_id,run_configuration_id,run_configuration_runtime_id,service_enabled) VALUES ('${id}','${gitProject}','run-configuration','running','alpha','${runtimeWorktree}','${id}','${id}',false)`,
          );
        }
        // Cross the retirement page boundary with real persisted terminals.
        // Inactive rows must also be removed, without worker stop commands.
        await repo.seed(
          `INSERT INTO run_configuration_runtimes (id,owner_id,project_id,configuration_id,worktree_id,worker_id,terminal_id,definition_revision,generation,requested_operation_id,state) SELECT 'cccccccc-cccc-4ccc-8ccc-' || lpad(n::text,12,'0'),${literal(owner)},'${gitProject}','cccccccc-cccc-4ccc-8ccc-' || lpad(n::text,12,'0'),'${runtimeWorktree}','alpha','cccccccc-cccc-4ccc-8ccc-' || lpad(n::text,12,'0'),'${"a".repeat(64)}',3,'88888888-8888-4888-8888-888888888888','idle' FROM generate_series(1,257) n`,
        );
        await repo.seed(
          `INSERT INTO terminals (id,project_id,kind,status,active_worker_id,worktree_id,run_configuration_id,run_configuration_runtime_id,service_enabled) SELECT id,project_id,'run-configuration','exited',worker_id,worktree_id,configuration_id,id,false FROM run_configuration_runtimes WHERE id LIKE 'cccccccc-cccc-4ccc-8ccc-%'`,
        );
        // Give both databases identical ordering inputs instead of relying on
        // how many seed statements happen to land within one clock tick.
        await repo.seed(
          `WITH ordered AS (SELECT id,row_number() OVER (ORDER BY id) n FROM run_configuration_runtimes) UPDATE run_configuration_runtimes r SET created_at='2026-10-01'::timestamptz + ordered.n * interval '1 second',updated_at='2026-10-01'::timestamptz + ordered.n * interval '1 second' FROM ordered WHERE r.id=ordered.id`,
        );
        for (const [reference, revision] of [
          ["run/api", 2],
          ["run/platform", 3],
          ["unrelated", 4],
        ]) {
          const value =
            fileDocumentWireFixtures().fileDocumentCreateSchema[0]
              .stateProtection.protectedState;
          await repo.seed(
            `INSERT INTO run_configuration_secrets(id,owner_id,project_id,reference,protected_value,revision) VALUES (${literal(`ffffffff-ffff-4fff-8fff-${String(revision).padStart(12, "0")}`)},${literal(owner)},'${gitProject}',${literal(reference)},${literal(JSON.stringify(value))}::jsonb,${revision})`,
          );
        }
        await repo.seed(
          `UPDATE user_settings SET default_model_id=NULL WHERE user_id=${literal(owner)}`,
        );
        await repo.seed(
          `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('git-provider',${literal(owner)},'Git provider','openai-compatible','https://example.invalid/api')`,
        );
        await repo.seed(
          `INSERT INTO model_profiles(id,owner_id,name) VALUES('git-model',${literal(owner)},'Git model')`,
        );
        await repo.seed(
          "INSERT INTO model_routes(id,model_id,provider_id,model_name,position,enabled) VALUES('git-route','git-model','git-provider','git-model',0,true)",
        );
        await repo.close();
        repo = undefined;
        await fixture.start();
        live = await new LiveProbe(fixture).open();
        await live.initialized();
        await live.subscribed("git-http", [
          currentUser,
          { kind: "project", projectId: gitProject },
        ]);
        const input = {
          operationId: "11111111-1111-4111-8111-111111111111",
          protectedRequest:
            fileDocumentWireFixtures().surfaceStreamWireRequestSchema[0]
              .protectedRequest,
        };
        const endpoint = (project = "github", worktree = "github-alpha-main") =>
          `/api/projects/${project === "github" ? gitProject : project}/worktrees/${worktree}/repository-operation`;
        const worktreeBase = `/api/projects/${gitProject}/worktrees`;
        const protectedRunOutput = {
          ...input.protectedRequest,
          domain: "run-content",
        };
        const runBase = "/api/run-configuration-runtimes";
        const runQuery = {
          operationId: input.operationId,
          projectId: gitProject,
          configurationId: "77777777-7777-4777-8777-777777777777",
          worktreeId: runtimeWorktree,
        };
        const statusQuery = {
          operationId: input.operationId,
          projectId: gitProject,
          configurationId: null,
          targetWorktreeId: null,
        };
        for (const route of ["status", "output"])
          await visit(`invalid Run ${route}`, "POST", `${runBase}/${route}`, {
            json: {},
            status: 400,
          });
        const statusRows = await visit(
          "Run status before worker",
          "POST",
          `${runBase}/status`,
          { json: statusQuery },
        );
        assert.equal(statusRows.runtimes.length, 256);
        await visit("Run output offline", "POST", `${runBase}/output`, {
          json: runQuery,
          status: 503,
        });
        await visit("Run output missing", "POST", `${runBase}/output`, {
          json: { ...runQuery, configurationId: input.operationId },
          status: 404,
        });
        if (profile === "accounts") {
          const foreign = await visit(
            "foreign Run status",
            "POST",
            `${runBase}/status`,
            { client: "other", json: statusQuery },
          );
          assert.deepEqual(foreign.runtimes, []);
          await visit("foreign Run output", "POST", `${runBase}/output`, {
            client: "other",
            json: runQuery,
            status: 404,
          });
        }

        await visit(
          "remove missing worktree",
          "DELETE",
          `${worktreeBase}/missing`,
          { json: {}, status: 404 },
        );
        await visit(
          "remove primary rejected",
          "DELETE",
          `${worktreeBase}/github-alpha-main`,
          { json: {}, status: 409 },
        );
        await visit(
          "remove invalid options",
          "DELETE",
          `${worktreeBase}/${runtimeWorktree}`,
          { json: { force: "yes" }, status: 400 },
        );
        await visit(
          "remove active runtime offline",
          "DELETE",
          `${worktreeBase}/${runtimeWorktree}`,
          { json: {}, status: 503 },
        );
        await visit(
          "folder capability precedes create validation",
          "POST",
          "/api/projects/folder/worktrees",
          { json: {}, status: 409 },
        );
        await visit(
          "local git cannot prune worktrees",
          "POST",
          "/api/projects/local-git/worktrees/prune",
          { json: {}, status: 409 },
        );
        await visit("worktree catalog", "GET", worktreeBase);
        await visit(
          "missing worktree catalog",
          "GET",
          "/api/projects/missing/worktrees",
          { status: 404 },
        );
        await visit("invalid worktree creation", "POST", worktreeBase, {
          json: {},
          status: 400,
        });
        await visit(
          "missing worktree creation source",
          "POST",
          "/api/projects/missing/worktrees",
          {
            json: { name: "new", mode: { type: "newBranch", branch: "topic" } },
            status: 404,
          },
        );
        await visit(
          "invalid worktree lock",
          "POST",
          `${worktreeBase}/github-alpha-main/lock`,
          { json: { reason: " " }, status: 400 },
        );
        await visit(
          "missing worktree lock",
          "POST",
          `${worktreeBase}/missing/lock`,
          { json: null, status: 404 },
        );
        await visit(
          "missing worktree unlock",
          "POST",
          `${worktreeBase}/missing/unlock`,
          { status: 404 },
        );
        await visit("offline reconcile", "POST", `${worktreeBase}/reconcile`, {
          status: 503,
        });
        await visit("offline prune", "POST", `${worktreeBase}/prune`, {
          json: {},
          status: 503,
        });
        await visit("invalid worktree prune", "POST", `${worktreeBase}/prune`, {
          json: { allowExternal: 1 },
          status: 400,
        });
        await live.ping("initial worktree routes completed");
        await visit("invalid body", "POST", endpoint(), {
          json: {},
          status: 400,
        });
        await visit("missing project", "POST", endpoint("missing"), {
          json: input,
          status: 404,
        });
        await visit("foreign project", "POST", endpoint("other"), {
          json: input,
          status: 404,
        });
        await visit("missing worktree", "POST", endpoint("github", "missing"), {
          json: input,
          status: 404,
        });
        await visit("missing peer", "POST", endpoint(), {
          json: { ...input, peerWorktreeId: "missing" },
          status: 404,
        });
        await visit("same peer", "POST", endpoint(), {
          json: { ...input, peerWorktreeId: "github-alpha-main" },
          status: 409,
        });
        await visit("offline worker", "POST", endpoint(), {
          json: input,
          status: 503,
        });
        worker = await fileDocumentHttpWorker({
          fixture,
          root: path.join(root, profile, kind),
          visit,
          result,
          operationType: "repository.operation",
          runtimeResponse: (command) =>
            command.type === "project.run-configuration-definitions.get"
              ? runDefinition(command)
              : command.type.endsWith(".output")
                ? {
                    requestOperationId:
                      outputMismatch === "requestOperationId"
                        ? runtimeId
                        : command.requestOperationId,
                    identity: {
                      ...command.identity,
                      ...(outputMismatch &&
                      outputMismatch !== "requestOperationId"
                        ? {
                            [outputMismatch]:
                              outputMismatch === "generation"
                                ? command.identity.generation + 1
                                : outputMismatch === "definitionRevision" ||
                                    outputMismatch ===
                                      "codexEnvironmentRevision"
                                  ? "b".repeat(64)
                                  : outputMismatch === "workerId"
                                    ? "foreign-worker"
                                    : input.operationId,
                          }
                        : {}),
                    },
                    protectedOutput: protectedRunOutput,
                  }
                : command.type.endsWith(".reconcile")
                  ? {
                      orphanedRuntimeIds: [],
                      runtimes: command.identities.map((identity) =>
                        runtimeReconcileLost &&
                        identity.runtimeId === lostRuntime
                          ? { found: false, identity }
                          : {
                              found: true,
                              observation: {
                                ...identity,
                                state: "running",
                                startedAt: null,
                                endedAt: null,
                                exitCode: null,
                                signal: null,
                                failure: null,
                              },
                            },
                      ),
                    }
                  : runtimeReplyMode === "not-found"
                    ? { outcome: "not-found", observation: null }
                    : {
                        outcome: "accepted",
                        observation: {
                          ...command.identity,
                          generation:
                            command.identity.generation +
                            (runtimeReplyMode === "future"
                              ? 1
                              : runtimeReplyMode === "stale"
                                ? -1
                                : 0),
                          state:
                            runtimeReplyMode === "active"
                              ? "running"
                              : runtimeReplyMode === "stopping"
                                ? "stopping"
                                : "exited",
                          startedAt: null,
                          endedAt: ["active", "stopping"].includes(
                            runtimeReplyMode,
                          )
                            ? null
                            : new Date().toISOString(),
                          exitCode: ["active", "stopping"].includes(
                            runtimeReplyMode,
                          )
                            ? null
                            : 0,
                          signal: null,
                          failure: null,
                        },
                      },
          worktreeResponse: (command) => {
            const primary = {
              path: "ctrr_" + "s".repeat(43),
              head: "inventory-head",
              branch: "inventory-branch",
              detached: false,
              isPrimary: true,
              managed: true,
              locked: command.type !== "worktree.unlock",
              lockReason:
                command.type === "worktree.unlock" ? null : "inventory-lock",
              prunable: false,
              pruneReason: null,
              missing: false,
            };
            const inventory = {
              sourcePath: command.sourcePath,
              primaryPath: primary.path,
              gitCommonDir: "opaque-common-dir",
              managedRoot: "opaque-managed-root",
              repositoryFingerprint: "a".repeat(64),
              worktrees: [
                primary,
                {
                  ...primary,
                  path: "ctrr_" + "r".repeat(43),
                  branch: "runtime",
                  isPrimary: false,
                },
              ],
            };
            if (command.type === "worktree.remove")
              return {
                removedPath: command.worktreePath,
                inventory: {
                  ...inventory,
                  worktrees: [
                    primary,
                    {
                      ...primary,
                      path: "ctrr_" + "c".repeat(43),
                      branch: "new-topic",
                      isPrimary: false,
                    },
                  ],
                },
              };
            if (command.type === "worktree.reconcile") return inventory;
            if (command.type === "worktree.prune")
              return { prunedPaths: [], inventory };
            if (command.type === "worktree.create") {
              const worktree = {
                ...primary,
                path: "ctrr_" + "c".repeat(43),
                branch: "new-topic",
                isPrimary: false,
              };
              return {
                created: true,
                worktree,
                inventory: {
                  ...inventory,
                  worktrees: [...inventory.worktrees, worktree],
                },
              };
            }
            return { worktree: primary, inventory };
          },
          observationResponse: (command) => ({
            accepted: true,
            paths: command.targets
              .filter((target) => target.worktreeId === "github-alpha-main")
              .map((target) => ({
                projectId: target.projectId,
                worktreeId: target.worktreeId,
                sourcePath: "ctrr_sssssssssssssssssssssssssssssssssssssssssss",
                worktreePath:
                  "ctrr_wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww",
              })),
          }),
          operationResponse: (command) => ({
            operationId: command.operationId,
            protectedResponse: input.protectedRequest,
            agentExecution: command.agent
              ? {
                  routeId: agentRoute,
                  turnId: "git-turn",
                  measuredUsage: {
                    inputTokens: 12,
                    outputTokens: 7,
                    totalTokens: 19,
                  },
                }
              : null,
          }),
        });
        await eventually(
          () => worker.observationCommands.length,
          (n) => assert.ok(n > 0),
        );
        const runOutput = await visit(
          "Run protected output",
          "POST",
          `${runBase}/output`,
          { json: runQuery },
        );
        assert.deepEqual(runOutput.protectedOutput, protectedRunOutput);
        for (const field of [
          "requestOperationId",
          "runtimeId",
          "projectId",
          "configurationId",
          "worktreeId",
          "workerId",
          "definitionRevision",
          "codexEnvironmentRevision",
          "generation",
          "operationId",
          "terminalId",
        ]) {
          outputMismatch = field;
          const rejected = await visit(
            `Run output mismatched ${field}`,
            "POST",
            `${runBase}/output`,
            { json: runQuery, status: 502 },
          );
          assert.equal(
            rejected.error,
            "The Run configuration output response was misrouted.",
          );
        }
        outputMismatch = null;
        const outputCommands = worker.runtimeCommands.filter((command) =>
          command.type.endsWith(".output"),
        );
        assert.equal(outputCommands.length, 12);
        assert.ok(outputCommands.every((command) => command.tail === 10_000));
        result.runtimeOutputCommands = fixture.normalize(outputCommands);
        result.initialObservation = fixture.normalize(
          worker.observationCommands[0],
        );
        await eventually(
          () => worker.observationCommands.at(-1),
          (command) => {
            const target = command.targets.find(
              (target) => target.worktreeId === "github-alpha-main",
            );
            assert.equal(
              target.sourcePath,
              "ctrr_sssssssssssssssssssssssssssssssssssssssssss",
            );
            assert.equal(
              target.worktreePath,
              "ctrr_wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww",
            );
          },
        );
        result.reconciledObservation = fixture.normalize(
          worker.observationCommands.at(-1),
        );
        const initialObservationCount = worker.observationCommands.length;
        if (profile !== "none") {
          await visit("missing csrf", "POST", endpoint(), {
            json: input,
            csrf: false,
            status: 403,
          });
          await visit("anonymous caller", "POST", endpoint(), {
            json: input,
            client: "anonymous",
            status: 401,
          });
        }
        if (profile === "accounts")
          await visit("other account cannot operate", "POST", endpoint(), {
            json: input,
            client: "other",
            status: 404,
          });
        await visit("agent missing model", "POST", endpoint(), {
          json: { ...input, agent: true },
          status: 409,
        });
        await visit("agent unknown model", "POST", endpoint(), {
          json: { ...input, agent: true, modelId: "missing" },
          status: 502,
        });
        await visit("agent selected model", "POST", endpoint(), {
          json: { ...input, agent: true, modelId: "git-model" },
        });
        agentRoute = "unknown";
        await visit("agent unknown returned route", "POST", endpoint(), {
          json: { ...input, agent: true, modelId: "git-model" },
          status: 502,
        });
        agentRoute = "git-route";
        await visit("read operation", "POST", endpoint(), {
          json: { ...input, access: "read" },
        });
        await visit("write operation", "POST", endpoint(), { json: input });
        worker.mode = "error";
        await visit("worker error", "POST", endpoint(), {
          json: input,
          status: 502,
        });
        worker.mode = "invalid";
        await visit("invalid worker response", "POST", endpoint(), {
          json: input,
          status: 502,
        });
        result.commands = fixture.normalize(result.commands);
        assert.equal(result.commands.length, 6);
        await eventually(
          () => worker.observationCommands.length,
          (n) => assert.ok(n > initialObservationCount),
        );
        result.refreshedObservation = fixture.normalize(
          worker.observationCommands.at(-1),
        );
        result.filesystemChanges = [];
        const runtimeEvents = (from) =>
          live.history
            .slice(from)
            .filter(
              (event) =>
                event.type === "event" &&
                ["run", "terminal"].includes(event.resource),
            )
            .map(
              ({ resource, scope, entityId, revision, payload, action }) => ({
                resource,
                scope,
                entityId,
                revision,
                payload,
                action,
              }),
            );
        await eventually(
          () =>
            worker.runtimeCommands.filter((command) =>
              command.type.endsWith(".reconcile"),
            ).length,
          (n) => assert.ok(n > 0),
        );
        const notifiedAt = live.history.length;
        const notification = {
          type: "project.run-configuration-runtime.observed",
          observation: {
            runtimeId: observedRuntime,
            projectId: gitProject,
            configurationId: observedRuntime,
            worktreeId: runtimeWorktree,
            workerId: "alpha",
            definitionRevision: "a".repeat(64),
            codexEnvironmentRevision: null,
            generation: 3,
            operationId: "88888888-8888-4888-8888-888888888888",
            terminalId: observedRuntime,
            state: "failed",
            startedAt: null,
            endedAt: new Date().toISOString(),
            exitCode: 1,
            signal: null,
            failure: {
              phase: "spawn",
              code: "fixture-failed",
              message: "Fixture process failed",
              retryable: true,
            },
          },
        };
        assert.equal(
          worker.notify({
            ...notification,
            observation: {
              ...notification.observation,
              projectId: lostRuntime,
            },
          }),
          true,
        );
        assert.equal(
          worker.notify({
            ...notification,
            observation: { ...notification.observation, generation: 2 },
          }),
          true,
        );
        assert.equal(worker.notify(notification), true);
        await eventually(
          () => runtimeEvents(notifiedAt),
          (events) =>
            assert.deepEqual(
              events.map((event) => event.resource),
              ["run", "terminal"],
            ),
        );
        result.runtimeNotificationChanges = fixture.normalize(
          runtimeEvents(notifiedAt),
        );
        for (const reconnect of [false, true]) {
          if (reconnect) {
            runtimeReconcileLost = true;
            const reconnectAt = live.history.length;
            await worker.reconnect();
            await eventually(
              () => runtimeEvents(reconnectAt),
              (events) =>
                assert.deepEqual(
                  events.map((event) => event.resource),
                  ["run", "terminal"],
                ),
            );
            result.runtimeRecoveryChanges = fixture.normalize(
              runtimeEvents(reconnectAt),
            );
          }
          const filesystemStart = live.history.length;
          assert.equal(
            worker.notify({
              type: "worktree.filesystem.changed",
              projectId: gitProject,
              worktreeId: "github-alpha-main",
              sourcePath: "ctrr_" + "s".repeat(43),
              worktreePath: "ctrr_" + "w".repeat(43),
            }),
            true,
          );
          await eventually(
            () =>
              live.history
                .slice(filesystemStart)
                .filter(
                  (event) =>
                    event.type === "event" &&
                    event.resource === "explorer-filesystem",
                ),
            (events) => assert.equal(events.length, 1),
          );
          await live.ping("filesystem observation delivered");
          const events = live.history
            .slice(filesystemStart)
            .filter(
              (event) =>
                event.type === "event" &&
                event.resource === "explorer-filesystem",
            );
          assert.equal(events.length, 1);
          assert.equal(events[0].entityId, "github-alpha-main");
          result.filesystemChanges.push(
            ...events.map(
              ({ resource, scope, entityId, revision, payload, action }) => ({
                resource,
                scope,
                entityId,
                revision,
                payload,
                action,
              }),
            ),
          );
        }
        const graphStart = live.history.length;
        const graphClock = Date.now();
        const graphStatus = {
          projectId: gitProject,
          worktreeId: "github-alpha-main",
          state: "ready",
          lastIndexedAt: null,
          lastSuccessfulSyncAt: null,
          fileCount: 3,
          nodeCount: 7,
          edgeCount: 9,
          pendingChanges: 0,
          statusMessage: null,
          job: null,
        };
        for (const worktreeId of ["missing-worktree", "github-beta-main"]) {
          assert.equal(
            worker.notify({
              type: "codegraph.status.observed",
              status: { ...graphStatus, worktreeId },
            }),
            true,
          );
        }
        assert.equal(
          worker.notify({
            type: "codegraph.status.observed",
            status: graphStatus,
          }),
          true,
        );
        const graphEvents = () =>
          live.history
            .slice(graphStart)
            .filter(
              (event) =>
                event.type === "event" && event.resource === "codegraph-status",
            );
        await eventually(graphEvents, (events) =>
          assert.equal(events.length, 1),
        );
        // A duplicate followed by an acknowledged changed status exercises the
        // publication fingerprint without relying on a sleep for absence.
        assert.equal(
          worker.notify({
            type: "codegraph.status.observed",
            status: graphStatus,
          }),
          true,
        );
        assert.equal(
          worker.notify({
            type: "codegraph.status.observed",
            status: { ...graphStatus, fileCount: 4 },
          }),
          true,
        );
        await eventually(graphEvents, (events) => {
          assert.equal(events.length, 2);
          assert.equal(events[1].payload.fileCount, 4);
        });
        assert.ok(graphEvents()[1].revision > graphEvents()[0].revision);
        result.codegraphChanges = graphEvents().map(
          ({ resource, scope, entityId, revision, payload, action }) => {
            assert.ok(
              Number.isSafeInteger(revision) &&
                revision >= graphClock * 1000 &&
                revision <= Date.now() * 1000 + 1000,
            );
            return {
              resource,
              scope,
              entityId,
              revision: "verified-monotonic-clock",
              payload,
              action,
            };
          },
        );
        const inventoryStart = live.history.length;
        const inventoryObservationCount = worker.observationCommands.length;
        const inventory = {
          sourcePath: "ctrr_" + "s".repeat(43),
          primaryPath: "ctrr_" + "w".repeat(43),
          gitCommonDir: "opaque-common-dir",
          managedRoot: "opaque-managed-root",
          repositoryFingerprint: "a".repeat(64),
          worktrees: [
            {
              path: "ctrr_" + "s".repeat(43),
              head: "inventory-head",
              branch: "inventory-branch",
              detached: false,
              isPrimary: true,
              managed: true,
              locked: true,
              lockReason: "inventory-lock",
              prunable: false,
              pruneReason: null,
              missing: false,
            },
          ],
        };
        for (const observed of [
          { ...inventory, sourcePath: "ctrr_" + "x".repeat(43) },
          { ...inventory, primaryPath: "ctrr_" + "x".repeat(43) },
          inventory,
        ])
          assert.equal(
            worker.notify({
              type: "worktree.inventory.observed",
              projectId: gitProject,
              sourcePath: inventory.sourcePath,
              inventory: observed,
            }),
            true,
          );
        const inventoryEvents = () =>
          live.history
            .slice(inventoryStart)
            .filter(
              (event) =>
                event.type === "event" && event.resource === "worktree",
            );
        await eventually(inventoryEvents, (events) =>
          assert.equal(events.length, 1),
        );
        await eventually(
          () => worker.observationCommands.length,
          (count) => assert.ok(count >= inventoryObservationCount + 2),
        );
        await live.ping("inventory reconciled and paths refreshed");
        assert.equal(inventoryEvents().length, 1);
        result.inventoryChanges = inventoryEvents().map(
          ({ resource, scope, entityId, revision, payload, action }) => ({
            resource,
            scope,
            entityId,
            revision,
            payload,
            action,
          }),
        );
        for (const [label, path, body] of [
          ["unlock", `${worktreeBase}/github-alpha-main/unlock`, undefined],
          [
            "lock",
            `${worktreeBase}/github-alpha-main/lock`,
            { reason: " inventory-lock " },
          ],
          ["reconcile", `${worktreeBase}/reconcile`, undefined],
          ["prune", `${worktreeBase}/prune`, {}],
          [
            "create",
            worktreeBase,
            {
              name: " New worktree ",
              mode: { type: "newBranch", branch: "new-topic" },
            },
          ],
        ]) {
          const start = Date.now();
          const value = await visit(`online worktree ${label}`, "POST", path, {
            ...(body === undefined ? {} : { json: body }),
            status: label === "create" ? 201 : 200,
          });
          for (const row of Array.isArray(value) ? value : [value]) {
            if (row.workerId !== "alpha") continue;
            for (const key of [
              "updatedAt",
              "lastScannedAt",
              ...(label === "create" ? ["createdAt"] : []),
            ])
              assert.ok(
                Date.parse(row[key]) >= start &&
                  Date.parse(row[key]) <= Date.now(),
                `${label} actual ${key}`,
              );
          }
          if (label === "unlock") assert.equal(value.locked, false);
          if (label === "lock") assert.equal(value.locked, true);
          if (label === "create") {
            assert.equal(value.origin, "user");
            assert.equal(value.name, "New worktree");
          }
        }
        result.worktreeCommands = fixture.normalize(worker.worktreeCommands);
        assert.equal(result.worktreeCommands.length, 5);
        await eventually(
          () => worker.observationCommands.at(-1),
          (command) =>
            assert.ok(
              command.targets.some(
                (target) => target.worktreePath === "ctrr_" + "w".repeat(43),
              ) &&
                command.targets.some(
                  (target) => target.worktreePath === "ctrr_" + "c".repeat(43),
                ),
            ),
        );
        for (const mode of [
          "not-found",
          "active",
          "stopping",
          "stale",
          "future",
        ]) {
          runtimeReplyMode = mode;
          const rejection = await visit(
            `runtime ${mode} prevents worktree removal`,
            "DELETE",
            `${worktreeBase}/${runtimeWorktree}`,
            { json: {}, status: 409 },
          );
          if (mode === "stopping")
            assert.equal(
              rejection.error,
              "The Run configuration instance remained active after its stop request.",
            );
          assert.equal(
            worker.worktreeCommands.length,
            5,
            "No worktree removal is dispatched before runtime retirement",
          );
        }
        runtimeReplyMode = "exited";
        const observationCountBeforeRemoval = worker.observationCommands.length;
        const removed = await visit(
          "remove worktree stops active runtime",
          "DELETE",
          `${worktreeBase}/${runtimeWorktree}`,
          { json: {} },
        );
        assert.equal(removed.lifecycleState, "missing");
        const stops = worker.runtimeCommands.filter((command) =>
          command.type.endsWith(".stop"),
        );
        assert.equal(stops.length, 6);
        assert.equal(stops[0].identity.runtimeId, runtimeId);
        assert.equal(stops[0].identity.generation, 3);
        result.runtimeCommands = fixture.normalize(stops);
        const reconciliations = worker.runtimeCommands.filter((command) =>
          command.type.endsWith(".reconcile"),
        );
        assert.equal(reconciliations.length, 2);
        assert.deepEqual(
          reconciliations.map((command) => command.identities.length),
          [3, 2],
        );
        result.runtimeReconciliations = fixture.normalize(reconciliations);
        result.worktreeCommands = fixture.normalize(worker.worktreeCommands);
        assert.equal(result.worktreeCommands.length, 6);
        await eventually(
          () => worker.observationCommands.at(-1),
          (command) => {
            assert.ok(
              worker.observationCommands.length > observationCountBeforeRemoval,
            );
            assert.ok(
              command.targets.some(
                (target) => target.worktreePath === "ctrr_" + "w".repeat(43),
              ),
            );
            assert.ok(
              command.targets.some(
                (target) =>
                  target.worktreeId === runtimeWorktree &&
                  target.worktreePath === "ctrr_" + "r".repeat(43),
              ),
            );
          },
        );
        result.runLifecycle = await runLifecycleCases({
          groupConcurrent: async (name, run) => {
            const eventStart = live.history.length;
            const changeStart = result.changes.length;
            const responseStart = result.observations.length;
            await run();
            // Concurrent HTTP completions cannot own disjoint Live slices.
            // Compare every event once in its original stream order instead.
            const events = live.history
              .slice(eventStart)
              .filter(
                (e) =>
                  e.type === "event" &&
                  [
                    "worktree",
                    "project-token-usage",
                    "run",
                    "terminal",
                  ].includes(e.resource),
              )
              .map(
                ({ resource, scope, entityId, revision, payload, action }) => ({
                  resource,
                  scope,
                  entityId,
                  revision,
                  payload,
                  action,
                }),
              );
            result.changes.splice(
              changeStart,
              result.changes.length - changeStart,
              {
                name,
                events: fixture.normalize(events),
              },
            );
            const responses = result.observations.splice(responseStart);
            responses.sort((a, b) => a.name.localeCompare(b.name));
            result.observations.push(...responses);
          },
          visit,
          fixture,
          worker,
          projectId: gitProject,
          worktreeId: fixture.records.get("online worktree create").id,
          setMode: (value) => {
            runtimeReplyMode = value;
          },
        });
        await runSecretHttpCases({ visit, projectId: gitProject, profile });
        for (const name of [
          "secret create",
          "secret update same envelope",
          "secret replay old receipt",
        ]) {
          // The route publishes first; the existing mutation hook then emits
          // its project-scoped invalidation after response completion.
          assert.deepEqual(
            result.changes.find((change) => change.name === name).events,
            [null, gitProject].map((entityId) => ({
              resource: "run-configuration",
              scope: { kind: "project", projectId: gitProject },
              entityId,
              revision: null,
              payload: null,
              action: "invalidated",
            })),
          );
        }
        await worker.close();
        worker = undefined;
        await live.close();
        live = undefined;
        await fixture.close();
        repo = await repositoryFixture({
          kind,
          executable: repositoryBinary,
          root: path.join(root, profile),
          databaseMode,
          databaseUrl,
        });
        const secretAudit = await repo.request({
          op: "query-json",
          sql: `SELECT coalesce(jsonb_agg(jsonb_build_object('action',action,'result',result,'resourceType',resource_type,'resourceId',resource_id,'owned',owner_id=${literal(owner)},'actor',actor_user_id=${literal(owner)},'session',actor_session_id IS NOT NULL,'request',length(request_id)>0)),'[]') result FROM audit_events WHERE action='run.configuration.secret.app.set'`,
        });
        assert.equal(secretAudit.rejected, false);
        assert.deepEqual(
          secretAudit.value,
          Array.from({ length: 3 }, () => ({
            action: "run.configuration.secret.app.set",
            result: "succeeded",
            resourceType: "run-configuration-secret",
            resourceId: "run/http-secret",
            owned: true,
            actor: true,
            session: profile !== "none",
            request: true,
          })),
        );
        result.secretAudit = secretAudit.value;
        const resolved = await repo.request({
          op: "worktree-context",
          owner,
          project: gitProject,
          worktree: "github-alpha-main",
        });
        assert.equal(resolved.rejected, false);
        assert.equal(resolved.value.worktree.branch, "inventory-branch");
        assert.equal(resolved.value.worktree.head, "inventory-head");
        assert.equal(resolved.value.worktree.locked, true);
        assert.equal(resolved.value.worktree.lockReason, "inventory-lock");
        assert.equal(
          resolved.value.worktree.path,
          "ctrr_wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww",
        );
        const persisted = await repo.request({
          op: "query-json",
          sql: "SELECT coalesce(jsonb_agg(to_jsonb(t)-'id'-'created_at'-'updated_at'-'started_at'-'completed_at'-'finalized_at' ORDER BY source_key),'[]') result FROM token_usage_records t",
        });
        assert.equal(persisted.rejected, false);
        assert.equal(persisted.value.length, 1);
        assert.equal(persisted.value[0].input_tokens, 12);
        assert.equal(persisted.value[0].output_tokens, 7);
        assert.equal(persisted.value[0].reported_total_tokens, 19);
        result.usage = fixture.normalize(persisted.value);
        const retired = await repo.request({
          op: "query-json",
          sql: `SELECT jsonb_build_object('runtime',(SELECT count(*) FROM run_configuration_runtimes WHERE id='${runtimeId}'),'terminal',(SELECT count(*) FROM terminals WHERE id='${runtimeId}'),'receipts',(SELECT count(*) FROM run_configuration_runtime_operations WHERE worktree_id='${runtimeWorktree}' AND operation='stop' AND outcome='accepted')) result`,
        });
        const remaining = await repo.request({
          op: "query-json",
          sql: `SELECT jsonb_build_object('runtimes',(SELECT count(*) FROM run_configuration_runtimes WHERE worktree_id='${runtimeWorktree}'),'terminals',(SELECT count(*) FROM terminals WHERE worktree_id='${runtimeWorktree}')) result`,
        });
        assert.equal(remaining.rejected, false);
        assert.deepEqual(remaining.value, { runtimes: 0, terminals: 0 });
        result.retirementBatch = { seeded: 260, remaining: remaining.value };
        assert.equal(retired.rejected, false);
        assert.deepEqual(retired.value, {
          runtime: 0,
          terminal: 0,
          receipts: 1,
        });
      } catch (error) {
        result.serverDiagnostics = fixture.server?.diagnostics();
        throw error;
      } finally {
        await worker?.close();
        await live?.close();
        await fixture.close();
        await repo?.close();
      }
    }
    for (const key of [
      "observations",
      "commands",
      "changes",
      "usage",
      "initialObservation",
      "reconciledObservation",
      "refreshedObservation",
      "filesystemChanges",
      "codegraphChanges",
      "inventoryChanges",
      "worktreeCommands",
      "runtimeCommands",
      "runtimeOutputCommands",
      "runtimeNotificationChanges",
      "runtimeRecoveryChanges",
      "runtimeReconciliations",
      "retirementBatch",
      "runLifecycle",
      "secretAudit",
    ])
      assert.deepEqual(runtimes[1][key], runtimes[0][key], profile + " " + key);
  }
} catch (error) {
  failure = error;
  report.failure = error.stack;
  report.retainedRoot = root;
} finally {
  try {
    await pg?.close();
  } catch (error) {
    failure ??= error;
  }
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    profiles: report.profiles.map(({ profile, runtimes }) => ({
      profile,
      observations: runtimes[0].observations.length,
      commands: runtimes[0].commands.length,
    })),
  }),
);
