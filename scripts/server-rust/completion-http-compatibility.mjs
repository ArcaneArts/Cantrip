// Production server entrypoints, durable repository-created closures and the
// unchanged worker transport. Worker acknowledgment outcomes are controlled.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import {
  settingsHttpFixture,
  settingsChat,
  settingsWorker,
  until,
} from "./native-settings-http-fixture.mjs";
import { command } from "./native-command-admission-cases.mjs";
import { literal, stamp } from "./project-target-state.mjs";
import { WorkerConnection } from "../../cantrip_worker/src/transport.ts";
import { saveWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
const option = (k) => {
  const n = process.argv.indexOf(k);
  return n < 0 ? undefined : process.argv[n + 1];
};
const databaseMode = option("--database") ?? "pglite",
  root = await mkdtemp(path.join(tmpdir(), "cantrip-completion-http-"));
const roots = [
  "55555555-5555-4555-8555-555555555551",
  "55555555-5555-4555-8555-555555555552",
];
const privateError = "private-logical-worker-reply-marker";
const report = {
  suite: "production-logical-completion-delivery",
  databaseMode,
  completeReplacement: false,
  lifecycleComplete: false,
  profiles: [],
};
let pg, failure, active;
async function value(repository, input) {
  const r = await repository.request(input);
  assert.equal(r.rejected, false, r.diagnostic);
  return r.value;
}
async function state(repository) {
  return value(repository, {
    op: "query-json",
    sql: "SELECT jsonb_build_object('outbox',COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY root_operation_id) FROM native_logical_completions c),'[]'::jsonb),'roots',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',operation_id,'generation',operation_generation,'logical',logical_completed_at,'execution',execution_completed_at) ORDER BY operation_id) FROM native_commands),'[]'::jsonb)) result",
  });
}
function observed(server, action, root) {
  return server.events.filter(
    (e) =>
      e.event === "fixture.logical-completion.persisted" &&
      e.action === action &&
      e.identity[3] === root &&
      e.changed,
  );
}
try {
  const executable = await buildRustServer(),
    repositoryExecutable = await buildRustExample("project-repository-fixture"),
    passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"].filter(
    (p) => !option("--profile") || p === option("--profile"),
  )) {
    const outputs = [];
    report.profiles.push({ profile, outputs });
    for (const kind of ["node", "rust"]) {
      const result = { kind, commands: [], proofs: [] };
      outputs.push(result);
      const url =
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined;
      const keys = new Map();
      let attempts = 0,
        worker;
      const verify = (cmd) => {
        const index = roots.indexOf(cmd.rootOperationId);
        assert.ok(index >= 0, "known durable root");
        assert.equal(
          cmd.rootOperationGeneration,
          keys.get(cmd.rootOperationId),
          "exact retained generation",
        );
        assert.deepEqual(
          Object.keys(cmd).sort(),
          [
            "type",
            "chatId",
            "rootOperationId",
            "rootOperationGeneration",
          ].sort(),
        );
        assert.equal(cmd.chatId, settingsChat);
        assert.equal(cmd.type, "chat.native-logical.complete");
        result.commands.push({
          ...cmd,
          rootOperationGeneration: `<root-generation-${index}>`,
        });
      };
      const h = (active = await settingsHttpFixture({
        kind,
        profile,
        root,
        executable,
        repositoryExecutable,
        databaseMode,
        url,
        passwordHash,
        result: { observations: [], snapshotProofs: 0, defaultsProofs: 0 },
        observeCompletions: true,
        prepare: async ({ owner, scope, repository }) => {
          const session = { ...scope };
          delete session.workerId;
          for (const id of roots) {
            const admitted = await value(repository, {
              op: "native-command-admit",
              owner,
              input: command({
                workerId: settingsWorker,
                operationId: id,
                session,
              }),
            });
            assert.equal(
              admitted.receipt.status,
              "accepted",
              admitted.receipt.rejectionCode,
            );
            keys.set(id, admitted.receipt.operationGeneration);
            const finished = await value(repository, {
              op: "native-command-logical-finish",
              owner,
              worker: settingsWorker,
              operation: id,
              generation: keys.get(id),
              status: "failed",
            });
            assert.equal(finished, true);
          }
          await repository.seed(
            `UPDATE native_logical_completions SET next_attempt_at=${literal("2099-01-01T00:00:00.000Z")} WHERE root_operation_id=${literal(roots[1])}`,
          );
        },
        onLogicalCompletion: async (cmd) => {
          verify(cmd);
          assert.equal(cmd.rootOperationId, roots[0]);
          if (++attempts === 1) throw new Error(privateError);
          return {};
        },
      }));
      const open = () =>
        repositoryFixture({
          kind,
          executable: repositoryExecutable,
          root: path.join(root, profile),
          databaseMode,
          databaseUrl: url,
        });
      const checkPrivate = (server) =>
        assert.equal(
          server.diagnostics().includes(privateError),
          false,
          "completion errors stay out of server diagnostics",
        );
      try {
        const first = h.fixture.server;
        await until(
          () => observed(first, "ack", roots[0]),
          (rows) => rows.length === 1,
        );
        assert.equal(attempts, 2);
        assert.equal(h.connectionCount(), 1, "retry without reconnect");
        const retries = observed(first, "defer", roots[0]);
        assert.ok(retries.length >= 1, "actual durable retry writes");
        for (const e of retries) {
          assert.deepEqual(e.identity, [
            h.owner,
            settingsWorker,
            settingsChat,
            roots[0],
            keys.get(roots[0]),
          ]);
          assert.ok(Number.isSafeInteger(e.dueMs));
        }
        checkPrivate(first);
        await h.close();
        let repository = await open();
        try {
          const s = await state(repository);
          assert.deepEqual(
            s.outbox.map((r) => r.root_operation_id),
            [roots[1]],
          );
          for (const row of s.roots) {
            assert.ok(row.logical);
            assert.ok(row.execution);
            assert.equal(row.generation, keys.get(row.id));
          }
          await repository.seed(
            `UPDATE native_logical_completions SET next_attempt_at=${literal(stamp)} WHERE root_operation_id=${literal(roots[1])}`,
          );
        } finally {
          await repository.close();
        }
        result.proofs.push(
          "real worker rejection retries without user input or reconnect; acknowledged row deleted durably",
        );

        const connect = async (handler) => {
          let connected = 0;
          const config = {
            dataDirectory: path.join(root, profile, kind, "completion-worker"),
            name: "Logical completion transport",
            serverUrl: h.fixture.server.origin,
            enrollmentCode: null,
            replacement: null,
            token: h.credential,
            tokenSource: "persisted",
            workerId: settingsWorker,
          };
          saveWorkerCredential({
            credential: config.token,
            dataDirectory: config.dataDirectory,
            serverUrl: config.serverUrl,
            workerId: settingsWorker,
          });
          worker = new WorkerConnection(
            config,
            async (cmd) => {
              if (cmd.type === "chat.scratch.reconcile")
                return {
                  retainedRootIds: cmd.roots.map((r) => r.rootId),
                  missingRootIds: [],
                  orphanedRootIds: [],
                  dueRootIds: [],
                };
              if (cmd.type === "chat.native-logical.complete") {
                verify(cmd);
                return handler(cmd);
              }
              throw new Error("Controlled completion command is unsupported");
            },
            undefined,
            undefined,
            undefined,
            1000,
            () => connected++,
          );
          worker.start();
          await until(
            () => connected,
            (n) => n === 1,
          );
          return () => connected;
        };
        await h.fixture.start();
        const second = h.fixture.server;
        let release,
          held = false;
        const connected = await connect(async (cmd) => {
          assert.equal(cmd.rootOperationId, roots[1]);
          held = true;
          return new Promise((resolve) => (release = resolve));
        });
        await until(() => held, Boolean);
        assert.deepEqual(observed(second, "ack", roots[1]), []);
        await h.fixture.close();
        release({});
        worker.close();
        worker = null;
        checkPrivate(second);
        assert.equal(connected(), 1);
        repository = await open();
        try {
          const s = await state(repository),
            pending = s.outbox.find((r) => r.root_operation_id === roots[1]);
          assert.ok(pending, "shutdown retains in-flight completion");
          assert.equal(pending.root_operation_generation, keys.get(roots[1]));
          assert.equal(
            pending.attempts,
            observed(second, "defer", roots[1]).length,
            "shutdown causes no late retry write",
          );
          await repository.seed(
            `UPDATE native_logical_completions SET next_attempt_at=${literal(stamp)} WHERE root_operation_id=${literal(roots[1])}`,
          );
        } finally {
          await repository.close();
        }
        result.proofs.push(
          "real shutdown wins pending reply and retains exact generation without late acknowledgment or defer",
        );

        // Shared PostgreSQL lets the other real implementation consume the
        // stopped server's pending row without converting or resetting data.
        const restartedKind =
          databaseMode === "postgres"
            ? kind === "node"
              ? "rust"
              : "node"
            : kind;
        h.fixture.kind = restartedKind;
        result.restartImplementation = restartedKind;
        await h.fixture.start();
        const third = h.fixture.server;
        await connect(async () => ({}));
        await until(
          () => observed(third, "ack", roots[1]),
          (rows) => rows.length === 1,
        );
        const bootstrap = await h.visit(
          "identity after logical delivery restart",
          "GET",
          "/api/bootstrap",
        );
        assert.equal(bootstrap.server.id, h.serverId);
        worker.close();
        worker = null;
        await h.fixture.close();
        checkPrivate(third);
        repository = await open();
        try {
          assert.deepEqual((await state(repository)).outbox, []);
        } finally {
          await repository.close();
        }
        result.proofs.push(
          "production restart independently redelivers retained root, preserves server identity and commits acknowledgment",
        );
        if (databaseMode === "postgres")
          result.proofs.push(
            "shared PostgreSQL completion survives a Node/Rust implementation handoff in both directions",
          );
        assert.equal(result.commands.length, 4);
        result.privateErrorsRedacted = true;
      } finally {
        worker?.close();
        await h.close();
        active = null;
      }
    }
    assert.deepEqual(
      { ...outputs[1], kind: undefined, restartImplementation: undefined },
      { ...outputs[0], kind: undefined, restartImplementation: undefined },
      profile + " completion effects",
    );
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  try {
    await active?.close();
  } catch (error) {
    failure ??= error;
  }
  await pg?.close();
  if (option("--report")) {
    await mkdir(path.dirname(option("--report")), { recursive: true });
    await writeFile(option("--report"), JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
  else console.error("Retained failed completion fixture:", root);
  console.log(
    JSON.stringify({
      suite: report.suite,
      databaseMode,
      passed: report.passed ?? false,
      profiles: report.profiles.map((p) => ({
        profile: p.profile,
        runtimes: p.outputs.map((o) => ({
          kind: o.kind,
          commands: o.commands.length,
          proofs: o.proofs.length,
        })),
      })),
      ...(report.failure ? { failure: report.failure } : {}),
    }),
  );
}
if (failure) throw failure;
