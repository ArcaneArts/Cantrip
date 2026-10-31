// Actual HTTP/Live services and unchanged Node worker transport. Controlled
// worker gates establish publication boundaries before observing durable state.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildRustServer, buildRustExample } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { LiveProbe } from "./live-sockets.mjs";
import { heartbeat, projectLabel, password } from "./security-fixtures.mjs";
import { WorkerConnection } from "../../cantrip_worker/src/transport.ts";
import { saveWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import {
  chatLifecycleHttpCases,
  chatLifecycleWorkerResult,
  chatLifecycleProjectSeedSql,
  chatLifecycleProjectHttpCases,
} from "./chat-lifecycle-http-cases.mjs";
import { createRequire } from "node:module";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
const workerId = option("--worker-id") ?? "scratch-worker";
const root = await mkdtemp(path.join(tmpdir(), "cantrip-standalone-http-"));
const report = {
  suite: "actual-standalone-chat-catalog-and-scratch-executor",
  databaseMode,
  workerId,
  leaseRenewal: process.argv.includes("--lease-renewal"),
  capacity: process.argv.includes("--capacity"),
  lifecycle: process.argv.includes("--lifecycle"),
  completeReplacement: false,
  profiles: [],
};
const ids = Array.from(
  { length: 12 },
  (_, i) => `33333333-3333-4333-8333-${String(i + 1).padStart(12, "0")}`,
);
const titleProtection = {
  ...projectLabel,
  classification: { recordKind: "chat" },
};
const handle = (n) => "ctrr_" + Buffer.alloc(32, n).toString("base64url");
async function until(read, check, timeout = 20000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await read();
    try {
      check(v);
      return v;
    } catch (e) {
      if (Date.now() >= deadline) throw e;
    }
    await delay(20);
  }
}
let pg, failure;
try {
  const passwordHash = await hashPassword(password);
  const executable = await buildRustServer(),
    repositoryExecutable = await buildRustExample("project-repository-fixture");
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"]) {
    const outputs = [];
    report.profiles.push({ profile, runtimes: outputs });
    for (const kind of ["node", "rust"]) {
      const url =
        pg && (kind === "node" || databaseMode === "postgres")
          ? await pg.database()
          : undefined;
      const fixture = new HttpFixture({
        kind,
        executable,
        root,
        name: profile,
        databaseMode,
        environment: {
          CANTRIP_AUTH_MODE: profile,
          CANTRIP_REGISTRATION_ENABLED: "true",
          ...(profile === "password"
            ? { CANTRIP_PASSWORD_HASH: passwordHash }
            : {}),
          ...(url ? { DATABASE_URL: url } : {}),
          ...(kind === "rust" && databaseMode === "bundled-postgres"
            ? {
                CANTRIP_POSTGRES_BIN_DIR:
                  process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
              }
            : {}),
        },
      });
      const result = {
        kind,
        observations: [],
        commands: [],
        reconciliations: [],
        lifecycleCommands: [],
        events: [],
      };
      // The URL is created by this test's disposable PostgreSQL owner. Passing
      // another mode to the explicit lease probe fails actual URL construction.
      const leaseControl =
        report.leaseRenewal || report.capacity
          ? postgres(new URL(url).href, { max: 2 })
          : undefined;
      outputs.push(result);
      const projectControl =
        report.lifecycle && databaseMode === "postgres"
          ? postgres(new URL(url).href, { max: 1 })
          : undefined;
      let worker,
        live,
        foreign,
        repository,
        connections = 0,
        runtimeFailure;
      const gates = new Map(),
        modes = new Map();
      const visit = async (label, method, route, options = {}) => {
        const value = await fixture.observe(label, method, route, {
          csrf:
            !["GET", "HEAD"].includes(method) &&
            !!fixture.client(options.client).csrf,
          ...options,
        });
        result.observations.push({ label, ...value });
        return fixture.records.get(label);
      };
      try {
        await fixture.start();
        if (profile === "accounts")
          for (const client of ["main", "other"])
            await visit("register " + client, "POST", "/api/auth/register", {
              client,
              status: 201,
              json: {
                email: `scratch-${client}@example.invalid`,
                displayName: "Scratch " + client,
                password,
              },
            });
        else {
          await visit("session", "GET", "/api/auth/session");
          if (profile === "password")
            await visit("login", "POST", "/api/auth/login", {
              json: { password },
            });
        }
        for (const route of [
          "/api/chats",
          "/api/chats?context=project",
          "/api/chats?context=standalone&context=standalone",
          "/api/chats/archived",
          "/api/chats/archived?context=project",
        ])
          await visit("invalid context " + route, "GET", route, {
            status: 400,
          });
        for (const route of [
          "/api/chats?context=standalone",
          "/api/chats/archived?context=standalone",
        ])
          await visit("empty " + route, "GET", route);
        for (const input of [
          null,
          {},
          [],
          { id: ids[0], titleProtection: projectLabel },
          { id: ids[0], titleProtection, extra: 1 },
          { id: "invalid", titleProtection },
        ])
          await visit(
            "invalid create " + JSON.stringify(input),
            "POST",
            "/api/chats",
            { status: 400, json: input },
          );
        await visit("no online scratch worker", "POST", "/api/chats", {
          status: 409,
          json: { id: ids[0], titleProtection },
        });
        await visit(
          "enrollment code",
          "POST",
          "/api/workers/enrollment-codes",
          { status: 201, json: { label: "Scratch worker" } },
        );
        await visit("enrollment", "POST", "/api/internal/workers/enroll", {
          client: "worker",
          status: 201,
          json: {
            code: fixture.records.get("enrollment code").code,
            heartbeat: {
              ...heartbeat,
              workerId,
              standaloneChat: {
                protocolVersion: 1,
                scratch: {
                  provision: true,
                  resolve: true,
                  archive: true,
                  restore: true,
                  remove: true,
                  reconcile: true,
                  routingHandles: true,
                },
                files: report.lifecycle
                  ? {
                      list: true,
                      read: true,
                      write: true,
                      remove: true,
                      download: true,
                      archive: true,
                    }
                  : heartbeat.standaloneChat.files,
              },
            },
          },
        });
        await visit(
          "offline enrolled worker unavailable",
          "POST",
          "/api/chats",
          { status: 409, json: { id: ids[0], titleProtection } },
        );
        live = await new LiveProbe(fixture).open();
        await live.initialized();
        await live.subscribed();
        if (profile === "accounts") {
          foreign = await new LiveProbe(fixture, { client: "other" }).open();
          await foreign.initialized();
          await foreign.subscribed();
        }
        const config = {
          dataDirectory: path.join(root, profile, kind, "controlled-worker"),
          name: "Scratch transport",
          serverUrl: fixture.server.origin,
          enrollmentCode: null,
          replacement: null,
          token: fixture.records.get("enrollment").credential,
          tokenSource: "persisted",
          workerId,
        };
        saveWorkerCredential({
          credential: config.token,
          dataDirectory: config.dataDirectory,
          serverUrl: config.serverUrl,
          workerId: config.workerId,
        });
        worker = new WorkerConnection(
          config,
          async (command) => {
            if (command.type === "chat.scratch.reconcile") {
              result.reconciliations.push(command);
              return {
                retainedRootIds: command.roots.map((r) => r.rootId),
                missingRootIds: [],
                orphanedRootIds: [],
                dueRootIds: [],
              };
            }
            if (command.type !== "chat.scratch.provision")
              return chatLifecycleWorkerResult({
                command,
                result,
                modes,
                fixture,
                gates,
              });
            result.commands.push(command);
            await new Promise((resolve) => gates.set(command.chatId, resolve));
            const mode = modes.get(command.chatId);
            if (mode === "worker-error")
              throw new Error("Controlled scratch worker failure");
            if (mode === "invalid") return { invalid: true };
            return {
              status: "ready",
              jobId: command.jobId,
              attempt: command.attempt,
              rootId: command.rootId,
              chatId: command.chatId,
              path:
                mode === "plaintext"
                  ? "/private/worker/path"
                  : handle(1 + ids.indexOf(command.chatId)),
              displayPath: handle(20 + ids.indexOf(command.chatId)),
              reused: false,
            };
          },
          undefined,
          undefined,
          undefined,
          1000,
          () => connections++,
        );
        worker.start();
        await until(
          () => connections,
          (n) => assert.equal(n, 1),
        );
        await until(
          () => result.reconciliations.length,
          (n) => assert.equal(n, 1),
        );
        assert.deepEqual(result.reconciliations[0], {
          type: "chat.scratch.reconcile",
          roots: [],
        });
        for (const [index, mode] of [
          "success",
          "invalid",
          "worker-error",
          "plaintext",
        ].entries()) {
          modes.set(ids[index], mode);
          const created = await visit("create " + mode, "POST", "/api/chats", {
            status: 202,
            json: { id: ids[index], titleProtection, autoTitle: index === 0 },
          });
          assert.equal(created.activeWorkerId, workerId);
          assert.equal(created.position, index);
          await until(
            () => gates.has(ids[index]),
            (v) => assert.equal(v, true),
          );
          await live.ping("held " + mode);
          if (index === 0 && report.leaseRenewal) {
            const read = () =>
              leaseControl`SELECT id,state,state_revision,attempt,command_id,started_at,updated_at,lease_expires_at FROM standalone_chat_root_jobs WHERE chat_id=${ids[index]}`;
            const initial = (await read())[0];
            assert.equal(initial.state, "running");
            assert.equal(initial.attempt, 1);
            assert.equal(initial.state_revision, 2);
            assert.equal(
              initial.lease_expires_at.getTime() - initial.updated_at.getTime(),
              120000,
            );
            const renewed = await until(
              read,
              (rows) => {
                assert.equal(rows.length, 1);
                const current = rows[0];
                assert.ok(
                  current.lease_expires_at.getTime() >
                    initial.lease_expires_at.getTime(),
                  "actual production renewal extended the stored lease",
                );
                assert.equal(current.command_id, initial.command_id);
                assert.equal(current.attempt, 1);
                assert.equal(current.state_revision, 2);
                assert.equal(
                  current.started_at.getTime(),
                  initial.started_at.getTime(),
                );
                assert.equal(
                  current.lease_expires_at.getTime() -
                    current.updated_at.getTime(),
                  120000,
                );
              },
              45000,
            );
            assert.equal(
              result.commands.filter((c) => c.chatId === ids[index]).length,
              1,
            );
            result.leaseProof = { initial, renewed: renewed[0] };
          }
          const before = live.history.length;
          gates.get(ids[index])();
          gates.delete(ids[index]);
          await until(
            () =>
              live.history
                .slice(before)
                .filter(
                  (e) =>
                    e.type === "event" &&
                    e.resource === "chat" &&
                    e.entityId === ids[index],
                ),
            (events) => assert.equal(events.length, 1),
          );
          await live.ping("settled " + mode);
        }
        await visit("duplicate Chat", "POST", "/api/chats", {
          status: /unique|duplicate/i.test(workerId) ? 409 : 500,
          json: { id: ids[0], titleProtection },
        });
        if (report.capacity) {
          const pending = ids.slice(4, 10);
          for (const id of pending)
            await visit("capacity create " + id, "POST", "/api/chats", {
              status: 202,
              json: { id, titleProtection },
            });
          await until(
            () => pending.filter((id) => gates.has(id)),
            (active) => assert.deepEqual(active, ids.slice(4, 8)),
          );
          const state = () =>
            leaseControl`SELECT id,chat_id,state,attempt,state_revision,command_id FROM standalone_chat_root_jobs WHERE chat_id=ANY(${pending}::text[]) ORDER BY chat_id`;
          result.capacityProof = [];
          const counts = async (label, expected) => {
            const rows = await state();
            assert.equal(rows.length, 6);
            const actual = rows.reduce((counts, row) => {
              counts[row.state] = (counts[row.state] ?? 0) + 1;
              return counts;
            }, {});
            assert.deepEqual(actual, expected, label);
            for (const row of rows) {
              assert.equal(row.attempt, row.state === "queued" ? 0 : 1);
              assert.equal(
                row.state_revision,
                { queued: 1, running: 2, succeeded: 3 }[row.state],
              );
            }
            result.capacityProof.push({ label, rows });
          };
          await counts("four active and two queued", { running: 4, queued: 2 });
          for (const [index, id] of pending.entries()) {
            gates.get(id)();
            gates.delete(id);
            await until(
              () =>
                live.history.filter(
                  (e) =>
                    e.type === "event" &&
                    e.resource === "chat" &&
                    e.entityId === id,
                ),
              (events) => assert.equal(events.length, 2),
            );
            if (index < 2) {
              await until(
                () => gates.has(ids[8 + index]),
                (ready) => assert.equal(ready, true),
              );
              await counts("next queued job dispatched " + index, {
                succeeded: index + 1,
                running: 4,
                ...(index === 0 ? { queued: 1 } : {}),
              });
            }
          }
          await counts("all six jobs completed once", { succeeded: 6 });
        }
        await visit("active catalog", "GET", "/api/chats?context=standalone");
        await visit("catalog HEAD", "HEAD", "/api/chats?context=standalone", {
          compareContentLength: true,
        });
        await visit(
          "archived catalog",
          "GET",
          "/api/chats/archived?context=standalone",
        );
        if (profile === "accounts") {
          await visit(
            "foreign catalog empty",
            "GET",
            "/api/chats?context=standalone",
            { client: "other" },
          );
          await foreign.ping("no foreign Chat events");
          assert.equal(
            foreign.history.filter(
              (e) => e.type === "event" && e.resource === "chat",
            ).length,
            0,
          );
        }
        if (report.lifecycle)
          await chatLifecycleHttpCases({
            fixture,
            visit,
            result,
            live,
            foreign,
            worker,
            modes,
            gates,
            until,
            ids,
            workerId,
            profile,
            titleProtection,
          });
        await live.ping("final scratch events");
        result.rawEvents = live.history.filter(
          (e) => e.type === "event" && e.resource === "chat",
        );
        result.events = result.rawEvents.map(
          ({ scope, resource, action, entityId, revision, payload }) =>
            fixture.normalize({
              scope,
              resource,
              action,
              entityId,
              revision,
              payload,
            }),
        );
        result.rawCommands = result.commands;
        const compared = report.capacity
          ? [...result.commands].sort((a, b) =>
              a.chatId.localeCompare(b.chatId),
            )
          : result.commands;
        result.commands = compared.map((c) => fixture.normalize(c));
        result.rawLifecycleCommands = result.lifecycleCommands;
        result.lifecycleCommands = result.lifecycleCommands.map((c) =>
          fixture.normalize(c),
        );
        worker.close();
        worker = undefined;
        await live.close();
        live = undefined;
        await foreign?.close();
        foreign = undefined;
        await fixture.close();
        repository = await repositoryFixture({
          kind,
          executable: repositoryExecutable,
          root: path.join(root, profile),
          databaseMode,
          databaseUrl: url,
        });
        const state = await repository.request({
          op: "query-json",
          sql: `SELECT jsonb_build_object(
          'chats',(SELECT jsonb_agg(to_jsonb(c) ORDER BY position) FROM chats c),
          'roots',(SELECT jsonb_agg(to_jsonb(r) ORDER BY chat_id) FROM standalone_chat_roots r),
          'jobs',(SELECT jsonb_agg(to_jsonb(j) ORDER BY chat_id) FROM standalone_chat_root_jobs j),
          'runtimes',(SELECT jsonb_agg(to_jsonb(s) ORDER BY chat_id) FROM chat_runtime_sessions s),
          'lanes',(SELECT jsonb_agg(to_jsonb(l) ORDER BY chat_id) FROM chat_execution_lanes l)) result`,
        });
        assert.equal(state.rejected, false, state.diagnostic);
        for (const [index, mode] of [
          "success",
          "invalid",
          "worker-error",
          "plaintext",
        ].entries()) {
          const job = state.value.jobs.find((j) => j.chat_id === ids[index]),
            scratch = state.value.roots.find((r) => r.chat_id === ids[index]);
          assert.equal(job.state, mode === "success" ? "succeeded" : "failed");
          assert.equal(job.state_revision, 3);
          assert.equal(job.attempt, 1);
          assert.equal(
            job.last_error_code,
            {
              success: null,
              invalid: "invalid-result",
              "worker-error": "worker-error",
              plaintext: "root-conflict",
            }[mode],
          );
          assert.equal(scratch.status, mode === "success" ? "ready" : "failed");
          assert.equal(
            scratch.provisioning_revision,
            mode === "success" ? 2 : 1,
          );
        }
        if (report.capacity)
          for (const id of ids.slice(4, 10)) {
            const job = state.value.jobs.find((j) => j.chat_id === id);
            assert.equal(job.state, "succeeded");
            assert.equal(job.attempt, 1);
            assert.equal(job.state_revision, 3);
            assert.equal(
              state.value.roots.find((r) => r.chat_id === id).status,
              "ready",
            );
          }
        const normalize = (v, key = "") =>
          Array.isArray(v)
            ? v.map((x) => normalize(x))
            : v && typeof v === "object"
              ? Object.fromEntries(
                  Object.entries(v).map(([k, x]) => [k, normalize(x, k)]),
                )
              : typeof v === "string" && key.endsWith("_at")
                ? (assert.ok(Number.isFinite(Date.parse(v))), "<timestamp>")
                : fixture.normalize(v, key);
        result.state = normalize(state.value);
        if (report.lifecycle) {
          for (const sql of chatLifecycleProjectSeedSql(
            state.value.chats[0].owner_id,
          ))
            await repository.seed(sql);
          await repository.close();
          repository = undefined;
          await fixture.start();
          await chatLifecycleProjectHttpCases({
            fixture,
            visit,
            result,
            profile,
            titleProtection,
            projectControl,
          });
          await fixture.close();
          repository = await repositoryFixture({
            kind,
            executable: repositoryExecutable,
            root: path.join(root, profile),
            databaseMode,
            databaseUrl: url,
          });
          const projectState = await repository.request({
            op: "query-json",
            sql: "SELECT jsonb_build_object('chats',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM chats c WHERE context_kind='project'),'messages',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM chat_messages m),'projects',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM projects p),'groups',(SELECT jsonb_agg(to_jsonb(g) ORDER BY project_id,region,position) FROM tab_groups g),'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY tab_key) FROM tab_group_members m)) result",
          });
          assert.equal(projectState.rejected, false, projectState.diagnostic);
          result.projectState = normalize(projectState.value);
        }
      } catch (error) {
        runtimeFailure = error;
        result.failure = { message: error.message, stack: error.stack };
        result.diagnostics = fixture.server?.diagnostics();
        throw error;
      } finally {
        for (const resume of gates.values()) resume();
        for (const cleanup of [
          () => worker?.close(),
          () => live?.close(),
          () => foreign?.close(),
          () => fixture.close(),
          () => repository?.close(),
          () => leaseControl?.end({ timeout: 5 }),
          () => projectControl?.end({ timeout: 5 }),
        ]) {
          try {
            await cleanup();
          } catch (error) {
            (result.cleanupFailures ??= []).push(String(error));
            runtimeFailure ??= error;
          }
        }
        if (runtimeFailure && !result.failure) throw runtimeFailure;
      }
    }
    assert.deepEqual(
      outputs[1].observations,
      outputs[0].observations,
      profile + ": HTTP",
    );
    assert.deepEqual(
      outputs[1].commands,
      outputs[0].commands,
      profile + ": real worker commands",
    );
    assert.deepEqual(
      outputs[1].reconciliations,
      outputs[0].reconciliations,
      profile + ": actual scratch reconnect reconciliation",
    );
    assert.deepEqual(
      outputs[1].events,
      outputs[0].events,
      profile + ": exact ordered Chat events",
    );
    assert.deepEqual(
      outputs[1].state,
      outputs[0].state,
      profile + ": complete creation and executor state",
    );
    assert.deepEqual(
      outputs[1].lifecycleCommands,
      outputs[0].lifecycleCommands,
      profile + ": lifecycle worker commands",
    );
    if (report.lifecycle)
      assert.deepEqual(
        outputs[1].fileEvents,
        outputs[0].fileEvents,
        profile + ": scoped Chat file invalidations",
      );
    if (report.lifecycle)
      assert.deepEqual(
        outputs[1].disconnectedArchive,
        outputs[0].disconnectedArchive,
        profile + ": admitted archive survives its HTTP caller",
      );
    if (report.lifecycle) {
      assert.deepEqual(
        outputs[1].projectEvents,
        outputs[0].projectEvents,
        profile + ": project lifecycle events",
      );
      assert.deepEqual(
        outputs[1].projectState,
        outputs[0].projectState,
        profile + ": complete project lifecycle state",
      );
    }
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
  report.retainedRoot = root;
} finally {
  try {
    await pg?.close();
  } catch (error) {
    failure ??= error;
    report.databaseCleanupFailure = String(error);
  }
  if (option("--report")) {
    const p = path.resolve(option("--report"));
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    profiles: report.profiles.length,
    passed: true,
  }),
);
