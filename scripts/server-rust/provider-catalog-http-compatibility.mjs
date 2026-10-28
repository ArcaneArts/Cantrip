import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { buildRustExample, buildRustServer } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { SocketProbe } from "./worker-sockets.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { heartbeat } from "./security-fixtures.mjs";
import { policyEnvelope } from "./policy-wire-fixtures.mjs";

const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-catalog-http-"));
const report = {
  suite: "actual-provider-catalog-http",
  databaseMode,
  root,
  completeReplacement: false,
  profiles: [],
};
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const workerId = "catalog-worker,";
const generation = "99999999-9999-4999-8999-999999999999";
const model = (name) => ({
  name,
  modifiedAt: null,
  sizeBytes: 100,
  digest: "catalog-fixture",
  family: "llama",
  families: ["llama"],
  parameterSize: "8B",
  quantization: "Q4",
  capabilities: ["VISION", "TOOLS", "THINKING"],
  modelInfo: {
    "general.architecture": "llama",
    "llama.context_length": 128000,
  },
});
const inventory = (name) => ({
  models: [model(name)],
  observedAt: "2026-10-25T00:00:00.000Z",
});
const catalog = (provider, query = "") =>
  `/api/settings/providers/${provider}/catalog${query}`;
let postgresOwner, failure;
try {
  const executable = await buildRustServer(),
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
      const result = { kind, observations: [], commands: [] };
      profile.runtimes.push(result);
      const visit = async (label, method, url, options = {}) => {
        const started = Date.now();
        const observed = await fixture.observe(label, method, url, {
          csrf: method === "POST",
          ...options,
        });
        if (observed.body?.error?.startsWith("Failed query: ")) {
          (result.queryErrors ??= []).push({ label, raw: observed.body.error });
          observed.body.error = observed.body.error
            .replace(
              /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g,
              (id) => fixture.normalize(id),
            )
            .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, (stamp) => {
              assert.ok(
                Date.parse(stamp) >= started && Date.parse(stamp) <= Date.now(),
              );
              return "<query-timestamp>";
            });
        }
        result.observations.push({ label, ...observed });
        return fixture.records.get(label);
      };
      let repository,
        worker,
        hold = false,
        held,
        releaseHeld,
        heldSeen;
      let controlledFailure = false;
      let completedCancel = false;
      const pendingCatalog = (provider) =>
        catalog(provider, `?workerId=${encodeURIComponent(workerId)}`);
      const refresh = (provider) =>
        catalog(provider, `/refresh?workerId=${encodeURIComponent(workerId)}`);
      const rawWorkerQuery = "?workerId=catalog-worker&workerId=";
      try {
        await fixture.start();
        if (mode === "accounts") {
          await visit("anonymous catalog", "GET", catalog("catalog-zai"), {
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
                  displayName: "Catalog " + client,
                  email: `catalog-${client}@example.invalid`,
                  password: "isolated catalog fixture password",
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
              heartbeat: { ...heartbeat, workerId },
            },
          },
        );
        await fixture.close();
        repository = await repositoryFixture({
          kind,
          executable: repositoryExecutable,
          root: path.join(root, mode),
          databaseMode,
          databaseUrl,
          nodeScript: "scripts/server-rust/settings-node-fixture.mjs",
        });
        if (mode === "none")
          await repository.seed(
            `INSERT INTO users(id,kind,display_name,email,normalized_email) VALUES(${literal(other)},'account','Other','catalog-other@example.invalid','catalog-other@example.invalid')`,
          );
        for (const [id, family, url, who] of [
          [
            "catalog-zai",
            "openai-compatible",
            "https://api.z.ai/api/v1",
            owner,
          ],
          [
            "catalog-custom",
            "openai-compatible",
            "https://fixture.invalid",
            owner,
          ],
          ["catalog-ollama", "ollama", "http://127.0.0.1:11434", owner],
          ["catalog-cancel", "ollama", "http://127.0.0.1:11434", owner],
          ["catalog-bad-sync", "ollama", "http://127.0.0.1:11434", owner],
          ["catalog-chatgpt", "chatgpt", "https://chatgpt.com", owner],
          ["catalog-grok", "grok", "https://grok.com", owner],
          ["catalog-foreign", "ollama", "http://127.0.0.1:11434", other],
        ])
          await repository.seed(
            `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES(${literal(id)},${literal(who)},${literal(id)},${literal(family)},${literal(url)})`,
          );
        for (const [id, provider] of [
          ["11111111-1111-4111-8111-111111111111", "catalog-chatgpt"],
          ["22222222-2222-4222-8222-222222222222", "catalog-grok"],
        ])
          await repository.seed(
            `INSERT INTO model_provider_accounts(id,provider_id,protected_label,credential_home_key,credential_state) VALUES(${literal(id)},${literal(provider)},${literal(JSON.stringify(policyEnvelope))},${literal(id)},'signed-out')`,
          );
        await repository.seed(
          "ALTER TABLE provider_catalog_sync_states ADD CONSTRAINT fixture_catalog_refresh CHECK(provider_id<>'catalog-bad-sync' OR status<>'refreshing')",
        );
        for (const [id, who, unlinked] of [
          ["catalog-foreign-worker", other, false],
          ["catalog-unlinked-worker", owner, true],
        ]) {
          await repository.seed(
            `INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at,unlinked_at) VALUES(${literal(id)},${literal(who)},${literal(id)},'linux','x64','2026-10-25T00:00:00Z','2026-10-25T00:00:00Z',${unlinked ? "'2026-10-25T01:00:00Z'" : "NULL"})`,
          );
        }
        await repository.close();
        repository = undefined;
        await fixture.start();
        for (const provider of ["missing", "catalog-foreign"]) {
          await visit(
            "unavailable catalog " + provider,
            "GET",
            catalog(provider),
            { status: 404 },
          );
          await visit(
            "unavailable refresh " + provider,
            "POST",
            catalog(provider, "/refresh"),
            { status: 404, json: {} },
          );
        }
        const builtin = await visit(
          "built-in catalog",
          "GET",
          catalog("catalog-zai"),
        );
        assert.ok(builtin.models.length > 0);
        await visit("HEAD built-in catalog", "HEAD", catalog("catalog-zai"));
        await visit(
          "built-in refresh ignores body fields",
          "POST",
          catalog("catalog-zai", "/refresh"),
          { json: { ignored: true } },
        );
        await visit(
          "custom provider conflict",
          "GET",
          catalog("catalog-custom"),
          { status: 409 },
        );
        await visit(
          "custom provider refresh conflict",
          "POST",
          catalog("catalog-custom", "/refresh"),
          { status: 409, json: null },
        );
        if (mode === "accounts")
          await visit(
            "catalog refresh CSRF",
            "POST",
            catalog("catalog-zai", "/refresh"),
            { csrf: false, json: {}, status: 403 },
          );
        await visit(
          "catalog refresh malformed JSON",
          "POST",
          catalog("catalog-zai", "/refresh"),
          {
            raw: "{",
            headers: { "content-type": "application/json" },
            status: 400,
          },
        );
        for (const provider of [
          "catalog-ollama",
          "catalog-chatgpt",
          "catalog-grok",
        ]) {
          await visit(
            "no automatic runner " + provider,
            "GET",
            catalog(provider),
            { status: 503 },
          );
          await visit(
            "unknown explicit runner " + provider,
            "GET",
            catalog(provider, "?workerId=missing"),
            { status: 404 },
          );
          await visit(
            "offline owned runner " + provider,
            "GET",
            pendingCatalog(provider),
            { status: 503 },
          );
          for (const worker of [
            "catalog-foreign-worker",
            "catalog-unlinked-worker",
          ])
            await visit(
              "unavailable runner " + provider + " " + worker,
              "GET",
              catalog(provider, "?workerId=" + worker),
              { status: 404 },
            );
        }
        worker = new SocketProbe(fixture, {
          query: `workerId=${encodeURIComponent(workerId)}&connectionGeneration=${generation}`,
          credential: fixture.records.get("paired").credential,
          onRequest(frame, socket) {
            if (frame.command.type !== "model.ollama.catalog") return false;
            result.commands.push(frame.command);
            const reply = (name = "base-model") =>
              socket.send(
                JSON.stringify({
                  kind: "response",
                  requestId: frame.requestId,
                  ok: !controlledFailure,
                  ...(controlledFailure
                    ? {
                        error: {
                          code: "fixture-catalog",
                          message: "Controlled catalog offline.",
                        },
                      }
                    : { result: inventory(name) }),
                }),
              );
            if (hold && frame.command.provider.id === "catalog-cancel") {
              assert.equal(
                releaseHeld,
                undefined,
                "one admitted catalog refresh",
              );
              releaseHeld = () => reply("after-cancel");
              heldSeen();
            } else
              reply(
                completedCancel &&
                  frame.command.provider.id === "catalog-cancel"
                  ? "after-cancel"
                  : "base-model",
              );
            return true;
          },
        });
        await worker.open();
        assert.equal((await worker.message()).state, "pending");
        assert.equal((await worker.message()).state, "ready");
        await visit(
          "actual refresh SQL failure",
          "POST",
          refresh("catalog-bad-sync"),
          { status: 502, json: {} },
        );
        const online = await visit(
          "online Ollama catalog",
          "GET",
          pendingCatalog("catalog-ollama"),
        );
        assert.equal(online.models.length, 1);
        assert.equal(online.models[0].nativeModelId, "base-model");
        await visit(
          "online automatic worker selection",
          "GET",
          catalog("catalog-ollama"),
        );
        await visit(
          "manual Ollama refresh",
          "POST",
          refresh("catalog-ollama"),
          { json: { ignored: true } },
        );
        await visit(
          "repeated worker identity reads fresh cache",
          "GET",
          catalog("catalog-ollama", rawWorkerQuery),
        );
        const beforeRepeated = result.commands.length;
        const stale = await visit(
          "repeated worker identity cannot dispatch refresh",
          "POST",
          catalog("catalog-ollama", "/refresh" + rawWorkerQuery),
          { json: {} },
        );
        assert.equal(stale.servedStale, true);
        assert.equal(
          result.commands.length,
          beforeRepeated,
          "array database identity is not a connected bridge key",
        );
        await visit(
          "ordinary identity refreshes after stale read",
          "POST",
          refresh("catalog-ollama"),
          { json: {} },
        );
        for (const provider of ["catalog-chatgpt", "catalog-grok"]) {
          await visit(
            "signed-out account provider " + provider,
            "GET",
            pendingCatalog(provider),
            { status: 503 },
          );
          await visit(
            "repeated worker key remains offline " + provider,
            "GET",
            catalog(provider, rawWorkerQuery),
            { status: 503 },
          );
        }
        controlledFailure = true;
        const fallback = await visit(
          "upstream failure retains catalog",
          "POST",
          refresh("catalog-ollama"),
          { json: {} },
        );
        assert.equal(fallback.servedStale, true);
        assert.equal(fallback.models[0].nativeModelId, "base-model");
        controlledFailure = false;
        await visit(
          "catalog retry succeeds",
          "POST",
          refresh("catalog-ollama"),
          { json: {} },
        );
        await visit(
          "warm cancel catalog",
          "GET",
          pendingCatalog("catalog-cancel"),
        );
        hold = true;
        held = new Promise((resolve) => {
          heldSeen = resolve;
        });
        const client = fixture.client();
        const headers = {
          origin: "http://127.0.0.1:5173",
          cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
          ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
        };
        const caller = httpRequest(
          fixture.server.origin + refresh("catalog-cancel"),
          { method: "POST", headers: { ...headers, connection: "close" } },
        );
        const outcome = new Promise((resolve) => {
          caller.once("error", resolve);
          caller.once("response", (response) => {
            response.resume();
            resolve(new Error("caller unexpectedly received a response"));
          });
        });
        const closed = new Promise((resolve) => caller.once("close", resolve));
        caller.end();
        await Promise.race([
          held,
          new Promise((_, reject) => {
            const timer = setTimeout(
              () => reject(new Error("catalog refresh was not dispatched")),
              15000,
            );
            timer.unref();
          }),
        ]);
        const disconnected = new Error("controlled catalog caller disconnect");
        caller.destroy(disconnected);
        assert.equal(await outcome, disconnected);
        await closed;
        assert.equal(caller.socket.destroyed, true);
        releaseHeld();
        hold = false;
        const commandCount = result.commands.length,
          deadline = performance.now() + 15000;
        for (;;) {
          // A repeated-key array can read the same database worker but cannot
          // dispatch new work, even while its actual string key stays online.
          const response = await fetch(
            fixture.server.origin + catalog("catalog-cancel", rawWorkerQuery),
            { headers, signal: AbortSignal.timeout(15000) },
          );
          const body = await response.json();
          assert.equal(response.status, 200);
          assert.equal(
            result.commands.length,
            commandCount,
            "completion observer never dispatches another catalog request",
          );
          if (
            body.models.some((model) => model.nativeModelId === "after-cancel")
          ) {
            result.disconnectedCommitSnapshot = body;
            break;
          }
          if (performance.now() > deadline)
            throw new Error("disconnected catalog refresh did not persist");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        // Persistence was proven above without another worker request. The
        // offline-key observer can race the final sync-state write; establish a
        // deterministic current state only after that independent assertion.
        completedCancel = true;
        await visit(
          "refresh after observing disconnected commit",
          "POST",
          refresh("catalog-cancel"),
        );
        await visit(
          "disconnected refresh remains committed",
          "GET",
          catalog("catalog-cancel", rawWorkerQuery),
        );
        result.disconnectedRefreshCommitted = true;
        await worker.close();
        worker = undefined;
        await fixture.close();
        await fixture.start();
        const retained = await visit(
          "catalog survives restart without connected worker",
          "GET",
          pendingCatalog("catalog-cancel"),
        );
        assert.ok(
          retained.models.some(
            (model) => model.nativeModelId === "after-cancel",
          ),
        );
        await fixture.close();
        repository = await repositoryFixture({
          kind,
          executable: repositoryExecutable,
          root: path.join(root, mode),
          databaseMode,
          databaseUrl,
          nodeScript: "scripts/server-rust/settings-node-fixture.mjs",
        });
        const snapshot = await repository.request({
          op: "query-json",
          sql: "SELECT jsonb_build_object('failedSyncRows',(SELECT count(*) FROM provider_catalog_sync_states WHERE provider_id='catalog-bad-sync'),'failedModels',(SELECT count(*) FROM provider_models WHERE provider_id='catalog-bad-sync'),'cancelledModels',(SELECT count(*) FROM provider_models WHERE provider_id='catalog-cancel' AND native_model_id IN ('base-model','after-cancel'))) AS result",
        });
        assert.equal(snapshot.rejected, false, snapshot.diagnostic);
        assert.deepEqual(snapshot.value, {
          failedSyncRows: 0,
          failedModels: 0,
          cancelledModels: 2,
        });
        result.retainedSnapshot = snapshot.value;
        await repository.close();
        repository = undefined;
      } finally {
        for (const close of [
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
      mode + " provider catalog HTTP compatibility",
    );
    assert.equal(actual.disconnectedRefreshCommitted, true);
    assert.deepEqual(actual.retainedSnapshot, expected.retainedSnapshot);
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
