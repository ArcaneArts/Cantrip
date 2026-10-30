import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { buildRustExample, buildRustServer } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import {
  deviceScenarios,
  comparableDeviceEvents,
} from "./provider-device-scenarios.mjs";
import { SocketProbe } from "./worker-sockets.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { heartbeat } from "./security-fixtures.mjs";
import { policyEnvelope } from "./policy-wire-fixtures.mjs";
import { capturedCredentialFixture } from "./settings-provider-fixtures.mjs";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-auth-http-"));
const report = {
  suite: "actual-provider-auth-http",
  databaseMode,
  root,
  completeReplacement: false,
  referenceLifecycle:
    "Opt-in Node fixture drains actual source notification and repository promises before database close, including catalog work admitted by a notification. Original PGlite shutdown hangs are retained in settings-device-http-pglite-v3/v4/v5. Native uses production shutdown without instrumentation.",
  profiles: [],
};
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const ids = Object.fromEntries(
  [
    "signedOut",
    "migration",
    "reauth",
    "conflict",
    "signedIn",
    "disabled",
    "missing",
    "malformed",
    "failed",
    "available",
    "cancelled",
    "alias",
    "foreign",
    "devicePending",
    "deviceError",
    "deviceInvalid",
    "deviceMissing",
    "deviceSuccess",
    "deviceEarly",
    "deviceRace",
    "deviceCancelled",
    "deviceShutdown",
    "deviceConcurrent",
    "deviceParallelOne",
    "deviceParallelTwo",
    "deviceBadStatus",
    "deviceBadBinding",
  ].map((name, i) => [
    name,
    `11111111-1111-4111-8111-${String(i + 1).padStart(12, "0")}`,
  ]),
);
const credential = capturedCredentialFixture(91);
const statusUrl = (extra = {}) =>
  "/api/codex/auth/status?" +
  new URLSearchParams({ providerId: "status-chatgpt,", ...extra });
let postgresOwner, failure;
try {
  const executable =
      process.env.CANTRIP_RUST_SERVER_BINARY ?? (await buildRustServer()),
    repositoryExecutable = await buildRustExample(
      "settings-repository-fixture",
    );
  if (databaseMode !== "pglite")
    postgresOwner = await postgresFixture(path.join(root, "postgres"));
  for (const mode of ["accounts", "none"]) {
    const profile = { mode, runtimes: [] };
    report.profiles.push(profile);
    for (const kind of ["node", "rust"]) {
      const databaseUrl =
        postgresOwner && (kind === "node" || databaseMode === "postgres")
          ? await postgresOwner.database()
          : undefined;
      const fixture = new HttpFixture({
        kind,
        executable,
        root,
        name: mode,
        databaseMode,
        providerAuthDrain: true,
        environment: {
          CANTRIP_AUTH_MODE: mode,
          CANTRIP_REGISTRATION_ENABLED: "true",
          ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
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
        captureCalls: [],
        catalogAccounts: [],
      };
      profile.runtimes.push(result);
      const visit = async (label, url, options = {}) => {
        const observed = await fixture.observe(label, "GET", url, options);
        result.observations.push({ label, ...observed });
        return fixture.records.get(label);
      };
      const openRepository = () =>
        repositoryFixture({
          kind,
          executable: repositoryExecutable,
          root: path.join(root, mode),
          databaseMode,
          databaseUrl,
          nodeScript: "scripts/server-rust/settings-node-fixture.mjs",
        });
      let repository, worker, holdResolve, releaseHeld;
      const captureModes = new Map();
      const device = deviceScenarios({
        fixture,
        result,
        ids,
        captureModes,
        databaseMode,
      });
      try {
        await fixture.start();
        if (mode === "accounts") {
          await visit("anonymous auth status", statusUrl(), {
            client: "anonymous",
            status: 401,
          });
          for (const client of ["main", "other"])
            await fixture.observe(
              "register " + client,
              "POST",
              "/api/auth/register",
              {
                client,
                status: 201,
                json: {
                  displayName: "Auth " + client,
                  email: `provider-auth-${client}@example.invalid`,
                  password: "isolated provider auth fixture password",
                },
              },
            );
        }
        const owner =
          mode === "accounts"
            ? fixture.records.get("register main").currentUser.id
            : "00000000-0000-0000-0000-000000000001";
        const other =
          mode === "accounts"
            ? fixture.records.get("register other").currentUser.id
            : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        await fixture.observe(
          "worker code",
          "POST",
          "/api/workers/enrollment-codes",
          { csrf: true, json: {}, status: 201 },
        );
        await fixture.observe(
          "paired",
          "POST",
          "/api/internal/workers/enroll",
          {
            client: "worker",
            status: 201,
            json: {
              code: fixture.records.get("worker code").code,
              heartbeat: {
                ...heartbeat,
                workerId: "fixture-worker,\uFFFD",
                encryption: {
                  supported: true,
                  state: "ready",
                  principalId: "33333333-3333-4333-8333-333333333333",
                  grants: [
                    { component: "provider-credential", keyRevision: 1 },
                  ],
                  lastSyncedAt: null,
                  error: null,
                },
              },
            },
          },
        );
        await fixture.close();
        repository = await openRepository();
        if (mode === "none")
          await repository.seed(
            `INSERT INTO users(id,kind,display_name,email,normalized_email) VALUES(${literal(other)},'account','Other','provider-auth-other@example.invalid','provider-auth-other@example.invalid')`,
          );
        for (const [id, family, who] of [
          ["status-chatgpt,", "chatgpt", owner],
          ["status-foreign", "chatgpt", other],
          ["status-wrong", "openai-compatible", owner],
        ])
          await repository.seed(
            `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES(${literal(id)},${literal(who)},${literal(id)},${literal(family)},'https://chatgpt.com')`,
          );
        const states = {
          migration: "migration-needed",
          reauth: "reauth-required",
          conflict: "conflict",
          signedIn: "signed-in",
        };
        for (const [position, [name, id]] of Object.entries(ids).entries()) {
          const provider =
            name === "foreign" ? "status-foreign" : "status-chatgpt,";
          await repository.seed(
            `INSERT INTO model_provider_accounts(id,provider_id,protected_label,credential_home_key,position,enabled,credential_state,plan_type) VALUES(${literal(id)},${literal(provider)},${literal(JSON.stringify(policyEnvelope))},${literal(id)},${position},${name === "disabled" ? "false" : "true"},${literal(states[name] ?? "signed-out")},'pro')`,
          );
        }
        await repository.seed(
          `UPDATE model_provider_accounts SET protected_credential=${literal(JSON.stringify(credential.protectedCredential))},credential_subject_blind_index=${literal(credential.subjectBlindIndex)},credential_revision=1 WHERE id=${literal(ids.signedIn)}`,
        );
        await repository.seed(
          `UPDATE model_provider_accounts SET weekly_usage_used_basis_points=1234,weekly_usage_resets_at='2026-10-25T00:00:00Z' WHERE id=${literal(ids.reauth)}`,
        );
        await repository.seed(
          `ALTER TABLE model_provider_accounts ADD CONSTRAINT device_status_failure CHECK(id <> ${literal(ids.deviceBadStatus)} OR auth_last_synced_at IS NULL)`,
        );
        await repository.seed(
          `ALTER TABLE model_provider_account_workers ADD CONSTRAINT device_binding_failure CHECK(account_id <> ${literal(ids.deviceBadBinding)})`,
        );
        await repository.close();
        repository = undefined;
        await fixture.start();
        await visit("missing status provider", "/api/codex/auth/status", {
          status: 400,
        });
        await visit("empty status provider", statusUrl({ providerId: "" }), {
          status: 400,
        });
        for (const providerId of ["missing", "status-foreign", "status-wrong"])
          await visit(
            "unavailable status " + providerId,
            statusUrl({ providerId }),
            { status: 404 },
          );
        await visit(
          "unknown status account",
          statusUrl({ accountId: "missing" }),
          { status: 404 },
        );
        await visit(
          "repeated account keys remain strict",
          "/api/codex/auth/status?providerId=status-chatgpt%2C&accountId=" +
            ids.signedOut +
            "&accountId=" +
            ids.signedOut,
          { status: 404 },
        );
        await visit(
          "repeated provider keys retain database conversion",
          "/api/codex/auth/status?providerId=status-chatgpt&providerId=",
        );
        await visit("default status account", statusUrl());
        for (const name of [
          "signedOut",
          "migration",
          "reauth",
          "conflict",
          "signedIn",
          "disabled",
        ]) {
          const status = await visit(
            "stored auth status " + name,
            statusUrl({ accountId: ids[name] }),
          );
          assert.equal(status.authenticated, name === "signedIn");
          assert.equal(status.email, null);
        }
        await visit(
          "offline status does not capture",
          statusUrl({
            accountId: ids.missing,
            workerId: "fixture-worker,\uFFFD",
          }),
        );
        worker = new SocketProbe(fixture, {
          query:
            "workerId=fixture-worker%2C%EF%BF%BD&connectionGeneration=99999999-9999-4999-8999-999999999999",
          credential: fixture.records.get("paired").credential,
          onRequest(frame, socket) {
            if (device.onRequest(frame, socket)) return true;
            const command = frame.command;
            const reply = (ok, value) =>
              socket.send(
                JSON.stringify({
                  kind: "response",
                  requestId: frame.requestId,
                  ok,
                  ...(ok
                    ? { result: value }
                    : { error: { code: "fixture-auth", message: value } }),
                }),
              );
            if (command.type === "provider.auth.legacy.capture") {
              result.captureCalls.push(command);
              const mode =
                captureModes.get(command.providerAccountId) ?? "missing";
              if (mode === "hold") {
                releaseHeld = () =>
                  reply(true, {
                    status: "available",
                    credential,
                    metadata: { expiresAt: null },
                    portableAuth: true,
                  });
                holdResolve();
              } else if (mode === "failed")
                reply(false, "upstream-private-token DO_NOT_LEAK");
              else if (mode === "malformed")
                reply(true, { status: "malformed" });
              else if (mode === "invalidEnvelope")
                reply(true, {
                  status: "available",
                  credential: {},
                  metadata: { expiresAt: null },
                  portableAuth: true,
                });
              else if (mode === "available")
                reply(true, {
                  status: "available",
                  credential,
                  metadata: { expiresAt: null },
                  portableAuth: true,
                });
              else reply(true, { status: "missing" });
              return true;
            }
            if (command.type === "provider.auth.legacy.purge") {
              reply(true, {
                purged: true,
                serverCredentialRevision: command.serverCredentialRevision,
                subjectBlindIndex: command.expectedSubjectBlindIndex,
              });
              return true;
            }
            if (command.type === "model.chatgpt.catalog") {
              result.catalogAccounts.push(command.provider.accountId);
              reply(true, {
                models: [],
                observedAt: "2026-10-25T00:00:00.000Z",
              });
              return true;
            }
            if (command.type === "provider.quota.read") {
              reply(false, "Fixture has no quota reading.");
              return true;
            }
            return false;
          },
        });
        await worker.open();
        assert.equal((await worker.message()).state, "pending");
        assert.equal((await worker.message()).state, "ready");
        const before = result.captureCalls.length;
        await visit(
          "repeated worker query never captures",
          "/api/codex/auth/status?providerId=status-chatgpt%2C&accountId=" +
            ids.missing +
            "&workerId=fixture-worker&workerId=",
        );
        assert.ok(
          !result.captureCalls
            .slice(before)
            .some((command) => command.providerAccountId === ids.missing),
        );
        for (const mode of [
          "missing",
          "malformed",
          "invalidEnvelope",
          "failed",
          "available",
        ]) {
          const account = ids[mode === "invalidEnvelope" ? "failed" : mode];
          captureModes.set(account, mode);
          const status = await visit(
            "status capture " + mode,
            statusUrl({
              accountId: account,
              workerId: "fixture-worker,\uFFFD",
            }),
          );
          assert.equal(status.authenticated, mode === "available");
          assert.equal(status.email, null);
          assert.ok(!JSON.stringify(status).includes("DO_NOT_LEAK"));
          if (mode === "malformed")
            assert.equal(
              status.loginError,
              "The worker's provider credential is invalid. Sign in again to replace it.",
            );
          if (mode === "failed" || mode === "invalidEnvelope")
            assert.equal(
              status.loginError,
              "The worker could not protect and save provider authentication. Reconnect or update the worker, then try again.",
            );
        }
        const deadline = performance.now() + 15000;
        while (!result.catalogAccounts.includes(ids.available)) {
          if (performance.now() > deadline)
            throw new Error(
              "authenticated status did not start catalog refresh",
            );
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        result.authenticatedStatusStartedCatalog = true;
        await device.run(worker, credential);
        await device.close();
        const held = new Promise((resolve) => {
          holdResolve = resolve;
        });
        captureModes.set(ids.cancelled, "hold");
        const client = fixture.client();
        const headers = {
          origin: "http://127.0.0.1:5173",
          cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        };
        const caller = httpRequest(
          fixture.server.origin +
            statusUrl({
              accountId: ids.cancelled,
              workerId: "fixture-worker,\uFFFD",
            }),
          { headers: { ...headers, connection: "close" } },
        );
        const outcome = new Promise((resolve) => {
          caller.once("error", resolve);
          caller.once("response", (response) => {
            response.resume();
            resolve(
              new Error("status caller unexpectedly received a response"),
            );
          });
        });
        const closed = new Promise((resolve) => caller.once("close", resolve));
        caller.end();
        await Promise.race([
          held,
          new Promise((_, reject) => {
            const timer = setTimeout(
              () => reject(new Error("status capture not dispatched")),
              15000,
            );
            timer.unref();
          }),
        ]);
        const disconnected = new Error(
          "controlled auth status caller disconnect",
        );
        caller.destroy(disconnected);
        assert.equal(await outcome, disconnected);
        await closed;
        assert.equal(caller.socket.destroyed, true);
        releaseHeld();
        const originalCaptureCount = result.captureCalls.filter(
          (command) => command.providerAccountId === ids.cancelled,
        ).length;
        const until = performance.now() + 15000;
        for (;;) {
          const response = await fetch(
            fixture.server.origin + statusUrl({ accountId: ids.cancelled }),
            { headers, signal: AbortSignal.timeout(15000) },
          );
          const status = await response.json();
          assert.equal(response.status, 200);
          if (status.authenticated) break;
          if (performance.now() > until)
            throw new Error("disconnected status capture did not persist");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(
          result.captureCalls.filter(
            (command) => command.providerAccountId === ids.cancelled,
          ).length,
          originalCaptureCount,
          "observer did not issue another capture",
        );
        await visit(
          "status capture survives caller disconnect",
          statusUrl({ accountId: ids.cancelled }),
        );
        result.disconnectedCaptureCommitted = true;
        await device.shutdown();
        await worker.close();
        worker = undefined;
        await fixture.close();
        await fixture.start();
        await device.retainedShutdown();
        await visit(
          "captured status survives restart",
          statusUrl({ accountId: ids.available }),
        );
        await fixture.close();
        repository = await openRepository();
        for (const account of [
          ids.available,
          ids.cancelled,
          ids.deviceSuccess,
          ids.deviceRace,
          ids.deviceCancelled,
          ids.deviceShutdown,
        ]) {
          const saved = await repository.request({
            op: "credential-get",
            owner,
            provider: "status-chatgpt,",
            account,
          });
          assert.equal(saved.rejected, false, saved.diagnostic);
          assert.equal(saved.value.state, "signed-in");
          assert.deepEqual(saved.value.credential, credential);
        }
        const rollback = await repository.request({
          op: "query-json",
          sql: `SELECT jsonb_build_object('untouched',(SELECT count(*)=2 FROM model_provider_accounts WHERE id IN (${literal(ids.deviceBadStatus)},${literal(ids.deviceBadBinding)}) AND auth_last_synced_at IS NULL),'bindings',(SELECT count(*) FROM model_provider_account_workers WHERE account_id IN (${literal(ids.deviceBadStatus)},${literal(ids.deviceBadBinding)}))) AS result`,
        });
        assert.equal(rollback.rejected, false, rollback.diagnostic);
        assert.deepEqual(rollback.value, { untouched: true, bindings: 0 });
        result.deviceStatusRollback = true;
        result.opaqueCredentialRetained = true;
        await repository.close();
        repository = undefined;
      } finally {
        for (const close of [
          () => device.close(),
          () => worker?.close(),
          () => fixture.close(),
          () => repository?.close(),
        ])
          try {
            await close();
          } catch (error) {
            (report.cleanupFailures ??= []).push(error.stack ?? String(error));
          }
      }
    }
    const [expected, actual] = profile.runtimes;
    assert.deepEqual(
      actual.observations,
      expected.observations,
      mode + " auth status HTTP compatibility",
    );
    assert.deepEqual(
      comparableDeviceEvents(actual.deviceEvents),
      comparableDeviceEvents(expected.deviceEvents),
      mode + " device login Live compatibility",
    );
    for (const key of [
      "authenticatedStatusStartedCatalog",
      "disconnectedCaptureCommitted",
      "opaqueCredentialRetained",
      "deviceCallerDisconnected",
      "deviceNotificationShutdownCompleted",
      "deviceStatusRollback",
    ])
      assert.equal(actual[key], true, key);
  }
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  try {
    await postgresOwner?.close();
  } catch (error) {
    (report.cleanupFailures ??= []).push(error.stack ?? String(error));
  }
}
if (reportPath) {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
}
console.log(
  JSON.stringify({
    databaseMode,
    profiles: report.profiles.map((p) => ({
      mode: p.mode,
      runtimes: p.runtimes.map((r) => ({
        kind: r.kind,
        observations: r.observations.length,
      })),
    })),
    failure: report.failure?.message,
    cleanupFailures: report.cleanupFailures,
  }),
);
if (failure) throw failure;
assert.deepEqual(report.cleanupFailures ?? [], []);
