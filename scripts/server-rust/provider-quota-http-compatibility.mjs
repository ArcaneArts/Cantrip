// Real HTTP, worker and Live sockets against isolated Node/Rust databases.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample, buildRustServer } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { LiveProbe } from "./live-sockets.mjs";
import { SocketProbe } from "./worker-sockets.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { heartbeat } from "./security-fixtures.mjs";
import { policyEnvelope } from "./policy-wire-fixtures.mjs";
import {
  capturedCredentialFixture,
  quotaSnapshot,
} from "./settings-provider-fixtures.mjs";
const option = (key) => {
  const index = process.argv.indexOf(key);
  return index < 0 ? undefined : process.argv[index + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-quota-http-"));
const report = {
  suite: "actual-provider-quota-http-live",
  databaseMode,
  root,
  completeReplacement: false,
  profiles: [],
};
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const workerId = "fixture-worker,\uFFFD";
const ids = Object.fromEntries(
  [
    "signedIn",
    "legacy",
    "signedOut",
    "reauth",
    "conflict",
    "disabled",
    "grok",
    "foreign",
    "expiredRead",
    "expiredConsume",
    "cancelled",
    "shutdown",
    "badRead",
    "badConsume",
    "badCredits",
    "badProjection",
    "badBinding",
    "badReauth",
  ].map((key, i) => [
    key,
    `11111111-1111-4111-8111-${String(i + 1).padStart(12, "0")}`,
  ]),
);
const credential = capturedCredentialFixture(98);
const reauth =
  "ChatGPT authentication expired. Sign in again to reconnect this provider account.";
const idempotencyKey = "77777777-7777-4777-8777-777777777777";
const snapshot = (id) => ({
  ...structuredClone(quotaSnapshot),
  snapshotId: id,
  rateLimitResetCredits: {
    availableCount: 1,
    credits: [
      {
        id: "credit-one",
        resetType: "codexRateLimits",
        status: "available",
        grantedAt: 1793059200,
        expiresAt: null,
        title: null,
        description: null,
      },
    ],
  },
});
const deadline = async (promise, label) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
let postgresOwner, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ?? (await buildRustServer());
  const repositoryExecutable = await buildRustExample(
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
      const normalize = fixture.normalize.bind(fixture);
      fixture.normalize = (value, key = "") => {
        // This client/worker-supplied reset is deliberately in the future. It
        // is fixed input and must be compared exactly, not treated as a server
        // generated timestamp by the shared fixture's clock assertion.
        if (
          (key === "weeklyUsageResetsAt" || key === "resetsAt") &&
          value === "2026-11-02T00:00:00.000Z"
        )
          return value;
        return normalize(value, key);
      };
      const runtimeStartedAt = Date.now();
      const result = {
        kind,
        observations: [],
        commands: [],
        invalidations: [],
        queryErrors: [],
      };
      profile.runtimes.push(result);
      const openRepository = () =>
        repositoryFixture({
          kind,
          executable: repositoryExecutable,
          root: path.join(root, mode),
          databaseMode,
          databaseUrl,
          nodeScript: "scripts/server-rust/settings-node-fixture.mjs",
        });
      const url = (account = ids.signedIn, provider = "quota-chatgpt") =>
        `/api/settings/providers/${provider}/accounts/${account}/rate-limit-resets`;
      const readUrl = (account, provider) =>
        url(account, provider) + "?" + new URLSearchParams({ workerId });
      const visit = async (label, method, target, options = {}) => {
        const startedAt = Date.now();
        const response = await fixture.observe(label, method, target, {
          csrf: !["GET", "HEAD"].includes(method),
          ...options,
        });
        if (response.body?.error?.startsWith("Failed query: ")) {
          result.queryErrors.push({ label, raw: response.body.error });
          response.body.error = response.body.error
            .replaceAll(owner, "<owner>")
            .replace(
              /(?<=\nparams: )[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g,
              (id) => {
                assert.ok(
                  response.body.error.startsWith(
                    'Failed query: insert into "provider_quota_observations"',
                  ),
                );
                assert.ok(!Object.values(ids).includes(id));
                return "<failed-observation-id>";
              },
            )
            .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, (stamp) => {
              if (
                [
                  quotaSnapshot.observedAt,
                  ...quotaSnapshot.windows
                    .filter((window) => window.resetsAt !== null)
                    .map((window) =>
                      new Date(window.resetsAt * 1000).toISOString(),
                    ),
                ].includes(stamp)
              )
                return stamp;
              assert.ok(
                Date.parse(stamp) >= startedAt &&
                  Date.parse(stamp) <= Date.now(),
                "actual failed query timestamp",
              );
              return "<query-timestamp>";
            });
        }
        result.observations.push({ label, ...response });
        return fixture.records.get(label);
      };
      const read = (label, account = ids.signedIn, options = {}) =>
        visit(label, "GET", readUrl(account), options);
      const consume = (
        label,
        account = ids.signedIn,
        input = {},
        options = {},
      ) =>
        visit(label, "POST", url(account) + "/consume", {
          json: { workerId, idempotencyKey, ...input },
          ...options,
        });
      let repository,
        worker,
        live,
        foreignLive,
        owner,
        other,
        response,
        heldResolve,
        releaseHeld;
      const invalidation = async (label) => {
        const event = await live.message(
          (frame) => frame.type === "event" && frame.resource === "settings",
        );
        assert.equal(event.action, "invalidated");
        result.invalidations.push({
          label,
          resource: event.resource,
          action: event.action,
          entityId: event.entityId,
          scope: event.scope,
          payload: event.payload,
        });
      };
      try {
        await fixture.start();
        if (mode === "accounts") {
          await read("anonymous quota", ids.signedIn, {
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
                  displayName: "Quota " + client,
                  email: `quota-${client}@example.invalid`,
                  password: "isolated quota fixture password",
                },
              },
            );
        }
        await fixture.observe("session", "GET", "/api/auth/session");
        owner =
          mode === "accounts"
            ? fixture.records.get("session").currentUser.id
            : "00000000-0000-0000-0000-000000000001";
        other =
          mode === "accounts"
            ? (await fixture.observe(
                "other session",
                "GET",
                "/api/auth/session",
                { client: "other" },
              ),
              fixture.records.get("other session").currentUser.id)
            : "22222222-2222-4222-8222-222222222222";
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
        repository = await openRepository();
        if (mode === "none")
          await repository.seed(
            `INSERT INTO users(id,kind,display_name,email,normalized_email) VALUES(${literal(other)},'account','Other','quota-other@example.invalid','quota-other@example.invalid')`,
          );
        for (const [id, family, who] of [
          ["quota-chatgpt", "chatgpt", owner],
          ["quota-grok", "grok", owner],
          ["quota-wrong", "openai-compatible", owner],
          ["quota-foreign", "chatgpt", other],
        ])
          await repository.seed(
            `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES(${literal(id)},${literal(who)},${literal(id)},${literal(family)},'https://chatgpt.com')`,
          );
        for (const [position, [name, id]] of Object.entries(ids).entries()) {
          const provider =
            name === "grok"
              ? "quota-grok"
              : name === "foreign"
                ? "quota-foreign"
                : "quota-chatgpt";
          const state =
            {
              legacy: "migration-needed",
              signedOut: "signed-out",
              reauth: "reauth-required",
              conflict: "conflict",
            }[name] ?? "signed-in";
          await repository.seed(
            `INSERT INTO model_provider_accounts(id,provider_id,protected_label,credential_home_key,position,enabled,credential_state,plan_type,protected_credential,credential_revision,credential_subject_blind_index) VALUES(${literal(id)},${literal(provider)},${literal(JSON.stringify(policyEnvelope))},${literal(id)},${position},${name === "disabled" ? "false" : "true"},${literal(state)},'pro',${state === "signed-in" ? literal(JSON.stringify(credential.protectedCredential)) : "NULL"},1,${state === "signed-in" ? literal(credential.subjectBlindIndex) : "NULL"})`,
          );
          await repository.seed(
            `INSERT INTO model_provider_account_workers(account_id,worker_id,auth_state) VALUES(${literal(id)},${literal(workerId)},'signed-in')`,
          );
        }
        await repository.seed(
          `ALTER TABLE provider_quota_observations ADD CONSTRAINT quota_read_failure CHECK(provider_account_id NOT IN (${literal(ids.badRead)},${literal(ids.badConsume)}))`,
        );
        await repository.seed(
          `ALTER TABLE model_provider_accounts ADD CONSTRAINT quota_credits_failure CHECK(id <> ${literal(ids.badCredits)} OR credits IS NULL)`,
        );
        await repository.seed(
          `ALTER TABLE model_provider_accounts ADD CONSTRAINT quota_projection_failure CHECK(id <> ${literal(ids.badProjection)} OR weekly_usage_used_basis_points IS NULL)`,
        );
        await repository.seed(
          `ALTER TABLE model_provider_account_workers ADD CONSTRAINT quota_binding_failure CHECK(account_id <> ${literal(ids.badBinding)} OR weekly_usage_used_basis_points IS NULL)`,
        );
        await repository.seed(
          `ALTER TABLE model_provider_accounts ADD CONSTRAINT quota_reauth_failure CHECK(id <> ${literal(ids.badReauth)} OR credential_state <> 'reauth-required')`,
        );
        await repository.close();
        repository = undefined;
        await fixture.start();
        await visit("missing worker selector", "GET", url(), { status: 400 });
        await visit("empty worker selector", "GET", url() + "?workerId=", {
          status: 400,
        });
        for (const [provider, account, status] of [
          ["missing", ids.signedIn, 404],
          ["quota-foreign", ids.foreign, 404],
          ["quota-wrong", ids.signedIn, 404],
          ["quota-grok", ids.grok, 409],
          ["quota-chatgpt", "missing", 404],
        ])
          await visit(
            "unavailable " + provider + "/" + account,
            "GET",
            readUrl(account, provider),
            { status },
          );
        await visit("unowned worker", "GET", url() + "?workerId=missing", {
          status: 404,
        });
        await read("offline owned worker", ids.signedIn, { status: 502 });
        const valid = { workerId, idempotencyKey };
        for (const [label, json] of [
          ["null", null],
          ["missing", {}],
          ["extra", { ...valid, unknown: true }],
          ["bad uuid", { ...valid, idempotencyKey: "bad" }],
          ["empty worker", { ...valid, workerId: "" }],
          ["empty credit", { ...valid, creditId: " " }],
          ["numeric credit", { ...valid, creditId: 1 }],
          ["array", []],
        ])
          await visit("invalid consume " + label, "POST", url() + "/consume", {
            json,
            status: 400,
          });
        await consume(
          "consume CSRF",
          ids.signedIn,
          {},
          { csrf: false, status: mode === "accounts" ? 403 : 502 },
        );
        worker = new SocketProbe(fixture, {
          credential: fixture.records.get("paired").credential,
          query: new URLSearchParams({
            workerId,
            connectionGeneration: "99999999-9999-4999-8999-999999999999",
          }).toString(),
          onRequest(frame, socket) {
            if (
              ![
                "provider.quota.read",
                "provider.rate-limit-reset.consume",
              ].includes(frame.command.type)
            )
              return false;
            result.commands.push(frame.command);
            const reply = () =>
              socket.send(
                JSON.stringify({
                  kind: "response",
                  requestId: frame.requestId,
                  ok: !response?.error,
                  ...(response?.error
                    ? {
                        error: {
                          code: "fixture-quota",
                          message: response.error,
                        },
                      }
                    : { result: response?.value }),
                }),
              );
            if (response?.hold) {
              releaseHeld = reply;
              heldResolve();
            } else reply();
            return true;
          },
        });
        await worker.open();
        assert.equal((await worker.message()).state, "pending");
        assert.equal((await worker.message()).state, "ready");
        live = new LiveProbe(fixture);
        await live.open();
        await live.initialized();
        await live.subscribed();
        if (mode === "accounts") {
          foreignLive = new LiveProbe(fixture, { client: "other" });
          await foreignLive.open();
          await foreignLive.initialized();
          await foreignLive.subscribed();
        }
        for (const name of ["signedOut", "reauth", "conflict"])
          await read("not signed in " + name, ids[name], { status: 409 });
        await visit(
          "query array retains offline Map identity",
          "GET",
          url() + "?workerId=fixture-worker&workerId=%EF%BF%BD",
          { status: 502 },
        );
        await consume(
          "unpaired UTF16 worker retains offline identity",
          ids.signedIn,
          { workerId: "fixture-worker,\uD800" },
          { status: 502 },
        );
        await visit(
          "NUL worker fails actual SQL",
          "GET",
          url() + "?workerId=fixture%00worker",
          { status: 502 },
        );
        response = { value: snapshot("initial-read") };
        assert.deepEqual(await read("read signed in"), response.value);
        await invalidation("read signed in");
        await read("deduplicated read");
        await invalidation("deduplicated read");
        await read("disabled explicit account", ids.disabled);
        await invalidation("disabled explicit account");
        await read("legacy signed-in binding", ids.legacy);
        await invalidation("legacy signed-in binding");
        await visit("HEAD quota retains operation", "HEAD", readUrl(), {
          status: 200,
        });
        await invalidation("HEAD quota");
        for (const outcome of [
          "reset",
          "nothingToReset",
          "noCredit",
          "alreadyRedeemed",
        ]) {
          response = {
            value: { outcome, quotaSnapshot: null, unknown: "stripped" },
          };
          assert.deepEqual(
            await consume(
              "consume " + outcome,
              ids.signedIn,
              outcome === "reset"
                ? { creditId: "  credit-one  " }
                : { creditId: null },
            ),
            { outcome, quotaSnapshot: null },
          );
          await invalidation(outcome);
        }
        response = {
          value: { outcome: "reset", quotaSnapshot: snapshot("consumed-read") },
        };
        await consume("consume with snapshot");
        await invalidation("consume with snapshot");
        const boundary = snapshot("rounding-boundaries");
        boundary.windows[0].usedPercent = 0.0000004999999999999999;
        boundary.windows[1].usedPercent = 0.004999999999999999;
        response = { value: boundary };
        await read("quota percentages immediately below rounding halves");
        await invalidation("rounding boundaries");
        response = {
          value: {
            outcome: "reset",
            quotaSnapshot: snapshot("best-effort-failed"),
          },
        };
        await consume(
          "consume retains success after persistence failure",
          ids.badConsume,
        );
        await invalidation("best effort failure");
        for (const name of [
          "badRead",
          "badCredits",
          "badProjection",
          "badBinding",
        ]) {
          response = { value: snapshot(name + "-failure") };
          await read("actual SQL failure " + name, ids[name], { status: 502 });
        }
        response = { error: "Controlled quota failure." };
        for (const balance of ["\uD800", "\u0000"]) {
          const value = snapshot("invalid-credit-text");
          value.credits.balance = balance;
          response = { value };
          await read(
            "credit JSONB rejects " + JSON.stringify(balance),
            ids.signedIn,
            { status: 502 },
          );
        }
        response = { error: "Controlled quota failure." };
        await read("read worker failure", ids.signedIn, { status: 502 });
        await consume(
          "consume worker failure",
          ids.signedIn,
          {},
          { status: 502 },
        );
        response = { value: {} };
        await read("invalid quota result", ids.signedIn, { status: 502 });
        await consume(
          "invalid consume result",
          ids.signedIn,
          {},
          { status: 502 },
        );
        response = { error: "Remote not found." };
        await read("worker not found mapping", ids.signedIn, { status: 404 });
        response = { error: reauth };
        await read("failed reauth state write", ids.badReauth, { status: 500 });
        for (const [name, operation] of [
          ["expiredRead", read],
          ["expiredConsume", consume],
        ]) {
          assert.deepEqual(
            await operation(
              "reauth " + name,
              ids[name],
              ...(operation === read
                ? [{ status: 409 }]
                : [{}, { status: 409 }]),
            ),
            { code: "provider-reauth-required", error: reauth },
          );
          await invalidation(name);
        }
        // The admitted reset finishes after its real HTTP caller destroys the socket.
        response = {
          hold: true,
          value: {
            outcome: "reset",
            quotaSnapshot: snapshot("cancelled-read"),
          },
        };
        const held = new Promise((resolve) => {
          heldResolve = resolve;
        });
        const client = fixture.client(),
          payload = JSON.stringify(valid);
        const caller = httpRequest(
          fixture.server.origin + url(ids.cancelled) + "/consume",
          {
            method: "POST",
            headers: {
              origin: "http://127.0.0.1:5173",
              cookie: [...client.cookies]
                .map(([k, v]) => `${k}=${v}`)
                .join("; "),
              "x-cantrip-csrf": client.csrf ?? "",
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
              connection: "close",
            },
          },
        );
        const outcome = new Promise((resolve) => {
          caller.once("error", resolve);
          caller.once("response", (response) => {
            response.resume();
            resolve(new Error("Caller unexpectedly received a response"));
          });
        });
        const closed = new Promise((resolve) => caller.once("close", resolve));
        caller.end(payload);
        await deadline(held, "quota request was not dispatched");
        const disconnected = new Error("intentional quota fixture disconnect");
        caller.destroy(disconnected);
        assert.equal(
          await deadline(outcome, "quota caller did not disconnect"),
          disconnected,
        );
        await deadline(closed, "quota client did not close");
        releaseHeld();
        await invalidation("caller disconnected");
        result.callerDisconnected = true;
        await live.ping();
        assert.equal(
          live.history.filter(
            (frame) => frame.type === "event" && frame.resource === "settings",
          ).length,
          result.invalidations.length,
          "exact settings invalidation count",
        );
        if (foreignLive) {
          await foreignLive.ping();
          assert.equal(
            foreignLive.history.filter(
              (frame) =>
                frame.type === "event" && frame.resource === "settings",
            ).length,
            0,
            "foreign owner isolation",
          );
          await foreignLive.close();
          foreignLive = undefined;
        }
        await live.close();
        live = undefined;
        response = { hold: true, value: snapshot("shutdown-reading") };
        const shutdownDispatched = new Promise((resolve) => {
          heldResolve = resolve;
        });
        const shutdownRead = read(
          "shutdown rejects held worker command after disconnect grace",
          ids.shutdown,
          { status: 503, timeoutMs: 30_000, headers: { connection: "close" } },
        );
        await deadline(shutdownDispatched, "shutdown read was not dispatched");
        const shutdownChild = fixture.server.child;
        const shuttingDown = new Promise((resolve) => {
          let buffered = "";
          const observe = (chunk) => {
            buffered += chunk;
            const lines = buffered.split("\n");
            buffered = lines.pop();
            for (const line of lines) {
              let event;
              try {
                event = JSON.parse(line).event;
              } catch {
                continue;
              }
              if (
                event ===
                (kind === "node"
                  ? "fixture.pre-close"
                  : "server.shutdown.started")
              ) {
                shutdownChild.stderr.removeListener("data", observe);
                resolve();
              }
            }
          };
          shutdownChild.stderr.on("data", observe);
        });
        // The reference bridge retains disconnected commands for its real
        // fifteen-second grace. The general fixture's fifteen-second kill timer
        // cannot be used to observe that same production deadline.
        const closing = fixture.close({ shutdownTimeoutMs: 30_000 });
        const stopped = Promise.all([shutdownRead, closing]);
        stopped.catch(() => {});
        await deadline(shuttingDown, "actual server shutdown was not observed");
        await stopped;
        await worker.waitClosed();
        worker = undefined;
        repository = await openRepository();
        const state = await repository.request({
          op: "query-json",
          sql: `SELECT jsonb_build_object('accounts',(SELECT jsonb_agg(jsonb_build_object('id',id,'state',credential_state,'revision',credential_revision,'protectedCredential',protected_credential,'credits',credits,'creditsObservedAt',credits_observed_at,'weekly',weekly_usage_used_basis_points,'weeklyAt',weekly_usage_observed_at) ORDER BY id) FROM model_provider_accounts WHERE provider_id='quota-chatgpt'),'readings',(SELECT jsonb_agg(to_jsonb(q)-'id'-'owner_id' ORDER BY event_key) FROM provider_quota_observations q)) AS result`,
        });
        assert.equal(state.rejected, false, state.diagnostic);
        result.state = state.value;
        const roundedReadings = state.value.readings.filter(
          (reading) => reading.observation_batch_key === "rounding-boundaries",
        );
        assert.equal(roundedReadings.length, 2);
        for (const reading of roundedReadings) {
          const window = boundary.windows.find(
            (window) => window.windowKind === reading.window_kind,
          );
          assert.equal(
            reading.used_percent_micros,
            Math.round(window.usedPercent * 1_000_000),
          );
        }
        assert.equal(
          state.value.accounts.find((account) => account.id === ids.signedIn)
            .weekly,
          Math.round(boundary.windows[1].usedPercent * 100),
        );
        assert.ok(
          !state.value.readings.some(
            (reading) => reading.provider_account_id === ids.shutdown,
          ),
          "interrupted worker command cannot commit a quota snapshot",
        );
        result.receivedAt = state.value.readings.map((reading) => {
          const stamp = reading.received_at;
          assert.ok(
            Date.parse(stamp) >= runtimeStartedAt &&
              Date.parse(stamp) <= Date.now(),
            "actual receipt timestamp",
          );
          reading.received_at = "<generated-receipt-time>";
          return stamp;
        });
        for (const name of ["expiredRead", "expiredConsume"]) {
          const account = state.value.accounts.find((a) => a.id === ids[name]);
          assert.equal(account.state, "reauth-required");
          assert.equal(account.revision, 1);
          assert.deepEqual(
            account.protectedCredential,
            credential.protectedCredential,
          );
        }
        assert.ok(
          state.value.readings.some(
            (q) =>
              q.provider_account_id === ids.cancelled &&
              q.observation_trigger === "reset-credit-consumed",
          ),
        );
        assert.equal(
          state.value.readings.filter(
            (q) =>
              q.observation_batch_key === "initial-read" &&
              q.provider_account_id === ids.signedIn,
          ).length,
          2,
          "immutable snapshot deduplication",
        );
        assert.ok(
          !state.value.readings.some(
            (q) => q.provider_account_id === ids.badConsume,
          ),
          "failed reading transaction rolled back",
        );
        assert.deepEqual(
          state.value.accounts.find((a) => a.id === ids.badConsume).credits,
          quotaSnapshot.credits,
          "credits committed before failed observation",
        );
        assert.deepEqual(
          state.value.accounts.find((a) => a.id === ids.badRead).credits,
          quotaSnapshot.credits,
          "failed GET keeps the earlier credit commit",
        );
        assert.equal(
          state.value.accounts.find((a) => a.id === ids.badCredits).credits,
          null,
          "failed credit update leaves old state",
        );
        for (const name of ["badProjection", "badBinding"]) {
          assert.equal(
            state.value.accounts.find((a) => a.id === ids[name]).weekly,
            null,
            "failed weekly transaction rolls back account projection",
          );
          const readings = state.value.readings.filter(
            (q) => q.provider_account_id === ids[name],
          );
          assert.equal(
            readings.length,
            1,
            "earlier primary window remains committed",
          );
          assert.equal(readings[0].window_kind, "primary");
        }
        assert.equal(
          state.value.accounts.find((a) => a.id === ids.badReauth).state,
          "signed-in",
          "reauth persistence failure keeps the credential usable",
        );
        await repository.close();
        repository = undefined;
        await fixture.start();
        await visit(
          "retained accounts after restart",
          "GET",
          "/api/settings/providers/quota-chatgpt/accounts",
        );
        await fixture.close();
      } finally {
        for (const close of [
          () => foreignLive?.close(),
          () => live?.close(),
          () => worker?.close(),
          () => fixture.server && fixture.close(),
          () => repository?.close(),
        ]) {
          try {
            await close();
          } catch (error) {
            if (!failure) failure = error;
            else report.cleanupError = String(error);
          }
        }
      }
      if (failure) throw failure;
    }
    const [node, rust] = profile.runtimes;
    for (const field of [
      "observations",
      "commands",
      "invalidations",
      "state",
      "callerDisconnected",
    ])
      assert.deepEqual(rust[field], node[field], mode + ": " + field);
  }
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  try {
    await postgresOwner?.close();
  } catch (error) {
    if (!failure) failure = error;
    report.cleanupError = String(error);
  }
  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    profiles: report.profiles.length,
    pairedHttp: report.profiles.reduce(
      (count, profile) => count + profile.runtimes[0].observations.length,
      0,
    ),
    settingsEvents: report.profiles.reduce(
      (count, profile) => count + profile.runtimes[0].invalidations.length,
      0,
    ),
  }),
);
