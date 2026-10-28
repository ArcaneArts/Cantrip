import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { buildRustExample, buildRustServer } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { LiveProbe } from "./live-sockets.mjs";
import { SocketProbe } from "./worker-sockets.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { heartbeat } from "./security-fixtures.mjs";
import { policyEnvelope } from "./policy-wire-fixtures.mjs";
import { capturedCredentialFixture } from "./settings-provider-fixtures.mjs";

const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-account-http-"));
const report = {
  suite: "actual-provider-account-http-live",
  databaseMode,
  root,
  completeReplacement: false,
  profiles: [],
};
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const providerLookupQueries = [
  'select "id", "owner_id", "name", "kind", "base_url", "protected_api_key", "weekly_usage_reserve_percent", "created_at", "updated_at" from "model_providers" where ("model_providers"."id" = $1 and "model_providers"."owner_id" = $2) limit $3',
  'select "id", "kind" from "model_providers" where ("model_providers"."id" = $1 and "model_providers"."owner_id" = $2) limit $3',
  'select "model_provider_accounts"."id", "model_provider_accounts"."credential_home_key" from "model_provider_accounts" inner join "model_providers" on "model_providers"."id" = "model_provider_accounts"."provider_id" where ("model_provider_accounts"."provider_id" = $1 and "model_providers"."owner_id" = $2 and "model_providers"."kind" in ($3, $4) and "model_provider_accounts"."id" = $5) order by "model_provider_accounts"."position" asc limit $6',
];
const ids = {
  first: "11111111-1111-4111-8111-111111111111",
  portable: "22222222-2222-4222-8222-222222222222",
  legacy: "33333333-3333-4333-8333-333333333333",
  grok: "44444444-4444-4444-8444-444444444444",
  foreign: "55555555-5555-4555-8555-555555555555",
  created: "66666666-6666-4666-8666-666666666666",
  captured: "77777777-7777-4777-8777-777777777777",
  cancelled: "88888888-8888-4888-8888-888888888888",
  shutdown: "99999999-9999-4999-8999-999999999999",
  badClear: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  badBindingClear: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
};
const credential = capturedCredentialFixture(73);
const secondLabel = {
  ...policyEnvelope,
  keyRevision: 2,
  envelope: { ...policyEnvelope.envelope, keyRevision: 2 },
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
      const result = {
        kind,
        observations: [],
        authEvents: [],
        clearChecks: [],
        queryErrors: [],
      };
      profile.runtimes.push(result);
      let owner;
      const visit = async (label, method, url, options = {}) => {
        const started = Date.now();
        const observed = await fixture.observe(label, method, url, {
          csrf: !["GET", "HEAD"].includes(method),
          ...options,
        });
        if (observed.body?.error?.startsWith("Failed query: ")) {
          result.queryErrors.push({ label, raw: observed.body.error });
          observed.body.error = observed.body.error
            .replace(
              /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g,
              (id) => fixture.normalize(id),
            )
            .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, (stamp) => {
              assert.ok(
                Date.parse(stamp) >= started && Date.parse(stamp) <= Date.now(),
                "actual failure timestamp",
              );
              return "<query-timestamp>";
            });
          if (label.startsWith("raw provider selector ")) {
            // The source Promise.all races three failing lookups. Retain the
            // actual body above, and verify every byte of a permitted query and
            // its parameters before comparing this nondeterministic outcome.
            const input = JSON.parse(
              label.slice("raw provider selector ".length),
            );
            const permitted = providerLookupQueries.map(
              (query, index) =>
                `Failed query: ${query}\nparams: ${String(input)},${fixture.normalize(owner)},${index === 2 ? "chatgpt,grok,missing," : ""}1`,
            );
            assert.ok(
              permitted.includes(observed.body.error),
              observed.body.error,
            );
            observed.body.error = "<parallel provider lookup SQL failure>";
          }
        }
        result.observations.push({ label, ...observed });
        return fixture.records.get(label);
      };
      const accounts = (provider = "account-chatgpt", account) =>
        `/api/settings/providers/${provider}/accounts${account ? "/" + account : ""}`;
      const logout = (label, input, status = 204, options = {}) =>
        visit(label, "POST", "/api/codex/auth/logout", {
          json: input,
          status,
          ...options,
        });
      const openRepository = () =>
        repositoryFixture({
          kind,
          executable: repositoryExecutable,
          root: path.join(root, mode),
          databaseMode,
          databaseUrl,
          nodeScript: "scripts/server-rust/settings-node-fixture.mjs",
        });
      const workerHeaders = () => ({
        authorization: `Bearer ${fixture.records.get("paired").credential}`,
      });
      const credentialUrl = (account, provider = "account-chatgpt") =>
        `/api/internal/workers/providers/${provider}/accounts/${account}/credential?workerId=fixture-worker`;
      const upload = (label, account, provider = "account-chatgpt") =>
        visit(label, "PUT", credentialUrl(account, provider), {
          client: "worker",
          csrf: false,
          headers: workerHeaders(),
          json: {
            credential,
            expectedRevision: 0,
            metadata: { expiresAt: null },
          },
        });
      let repository, live, foreignLive, worker, heldAccount, releaseHeld, held;
      const background = new Set(),
        backgroundFailures = [];
      try {
        await fixture.start();
        if (mode === "accounts") {
          await visit("anonymous account read", "GET", accounts(), {
            client: "anonymous",
            status: 401,
          });
          await logout(
            "anonymous global logout",
            { providerId: "account-chatgpt" },
            401,
            { client: "anonymous", csrf: false },
          );
          for (const client of ["main", "other"])
            await fixture.observe(
              "register " + client,
              "POST",
              "/api/auth/register",
              {
                client,
                status: 201,
                json: {
                  displayName: "Account " + client,
                  email: `account-${client}@example.invalid`,
                  password: "isolated account fixture password",
                },
              },
            );
        }
        owner =
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
            `INSERT INTO users(id,kind,display_name,email,normalized_email) VALUES(${literal(other)},'account','Other','other-account@example.invalid','other-account@example.invalid')`,
          );
        for (const [provider, providerKind, who] of [
          ["account-chatgpt", "chatgpt", owner],
          ["account-grok", "grok", owner],
          ["account-foreign", "chatgpt", other],
          ["account-wrong-kind", "openai-compatible", owner],
        ])
          await repository.seed(
            `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES(${literal(provider)},${literal(who)},${literal(provider)},${literal(providerKind)},'https://fixture.invalid')`,
          );
        for (const [position, [account, provider, state]] of [
          [ids.first, "account-chatgpt", "signed-out"],
          [ids.portable, "account-chatgpt", "signed-out"],
          [ids.legacy, "account-chatgpt", "migration-needed"],
          [ids.badClear, "account-chatgpt", "signed-in"],
          [ids.badBindingClear, "account-chatgpt", "signed-in"],
          [ids.grok, "account-grok", "signed-out"],
          [ids.foreign, "account-foreign", "signed-out"],
        ].entries())
          await repository.seed(
            `INSERT INTO model_provider_accounts(id,provider_id,protected_label,credential_home_key,position,credential_state) VALUES(${literal(account)},${literal(provider)},${literal(JSON.stringify(policyEnvelope))},${literal(account)},${position},${literal(state)})`,
          );
        await repository.seed(
          `UPDATE model_provider_accounts SET protected_credential=${literal(JSON.stringify(credential.protectedCredential))},credential_subject_blind_index=${literal(credential.subjectBlindIndex)},credential_revision=1 WHERE id IN (${literal(ids.badClear)},${literal(ids.badBindingClear)})`,
        );
        await repository.seed(
          `ALTER TABLE model_provider_accounts ADD CONSTRAINT fixture_account_clear CHECK(id<>${literal(ids.badClear)} OR credential_state<>'signed-out')`,
        );
        await repository.seed(
          `INSERT INTO model_provider_account_workers(account_id,worker_id,auth_state,last_synced_at) VALUES(${literal(ids.badBindingClear)},'fixture-worker','signed-in','2026-10-25T00:00:00Z')`,
        );
        await repository.seed(
          `ALTER TABLE model_provider_account_workers ADD CONSTRAINT fixture_binding_clear CHECK(account_id<>${literal(ids.badBindingClear)} OR auth_state<>'signed-out')`,
        );
        await repository.close();
        repository = undefined;
        await fixture.start();
        for (const provider of [
          "missing",
          "account-wrong-kind",
          "account-foreign",
        ]) {
          await visit(
            "unavailable provider list " + provider,
            "GET",
            accounts(provider),
            { status: 404 },
          );
          await visit(
            "unavailable provider create " + provider,
            "POST",
            accounts(provider),
            {
              status: 404,
              json: { id: ids.created, protectedLabel: policyEnvelope },
            },
          );
        }
        if (mode === "accounts")
          await visit("account CSRF required", "POST", accounts(), {
            csrf: false,
            status: 403,
            json: { id: ids.created, protectedLabel: policyEnvelope },
          });
        for (const [label, input] of [
          ["missing label", { id: ids.created }],
          ["invalid ID", { id: "invalid", protectedLabel: policyEnvelope }],
          [
            "plaintext label",
            {
              id: ids.created,
              label: "must stay protected",
              protectedLabel: policyEnvelope,
            },
          ],
        ])
          await visit("create validation " + label, "POST", accounts(), {
            status: 400,
            json: input,
          });
        const initial = await visit("initial account list", "GET", accounts());
        assert.equal(initial.length, 5);
        await visit("HEAD account list", "HEAD", accounts());
        const created = await visit(
          "create protected account",
          "POST",
          accounts(),
          {
            status: 201,
            json: { id: ids.created, protectedLabel: policyEnvelope },
          },
        );
        assert.deepEqual(created.protectedLabel, policyEnvelope);
        assert.equal("label" in created, false);
        await visit("duplicate protected account", "POST", accounts(), {
          status: 500,
          json: { id: ids.created, protectedLabel: policyEnvelope },
        });
        for (const input of [
          {},
          { unknown: true },
          { enabled: "false" },
          { label: "plaintext" },
        ])
          await visit(
            "account update validation " + JSON.stringify(input),
            "PATCH",
            accounts(undefined, ids.created),
            { json: input, status: 400 },
          );
        const changed = await visit(
          "update protected account",
          "PATCH",
          accounts(undefined, ids.created),
          { json: { enabled: false, protectedLabel: secondLabel } },
        );
        assert.equal(changed.enabled, false);
        assert.deepEqual(changed.protectedLabel, secondLabel);
        await visit(
          "missing account update",
          "PATCH",
          accounts(undefined, "missing"),
          { json: { enabled: false }, status: 404 },
        );
        await visit(
          "foreign account update",
          "PATCH",
          accounts("account-foreign", ids.foreign),
          { json: { enabled: false }, status: 404 },
        );
        const order = [
          ids.created,
          ids.badClear,
          ids.badBindingClear,
          ids.legacy,
          ids.portable,
          ids.first,
        ];
        for (const input of [
          { ids: [] },
          { ids: ["missing"] },
          { ids: [...order.slice(1), ids.first] },
        ])
          await visit(
            "account order rejection " + JSON.stringify(input),
            "PATCH",
            accounts(undefined, "order"),
            { json: input, status: 400 },
          );
        await visit("reorder accounts", "PATCH", accounts(undefined, "order"), {
          json: { ids: order, stripUnknown: true },
          status: 204,
        });
        assert.deepEqual(
          (await visit("account order persisted", "GET", accounts())).map(
            (a) => a.id,
          ),
          order,
        );
        await visit(
          "delete missing account",
          "DELETE",
          accounts(undefined, "missing"),
          { status: 404 },
        );
        await visit(
          "delete requires original worker for migration",
          "DELETE",
          accounts(undefined, ids.legacy),
          { status: 409 },
        );
        await logout(
          "logout requires original worker for migration",
          {
            providerId: "account-chatgpt",
            accountId: ids.legacy,
            workerId: "fixture-worker",
          },
          409,
        );
        for (const input of [
          undefined,
          null,
          {},
          { providerId: "" },
          [],
          "plain",
        ])
          await logout(
            "missing logout provider " + JSON.stringify(input),
            input,
            400,
          );
        for (const input of [
          { providerId: "missing" },
          { providerId: "account-wrong-kind" },
          { providerId: "account-foreign" },
          { providerId: "account-chatgpt", accountId: "missing" },
        ])
          await logout(
            "unavailable logout target " + JSON.stringify(input),
            input,
            404,
          );
        const beforeMalformed = await visit(
          "account state before malformed selectors",
          "GET",
          accounts(),
        );
        for (const providerId of [
          true,
          17,
          {},
          [],
          [true],
          [[true]],
          ["missing"],
          { toString: null },
        ]) {
          const booleanParameter =
            providerId === true ||
            (Array.isArray(providerId) &&
              providerId.flat(Infinity)[0] === true);
          await logout(
            "raw provider selector " + JSON.stringify(providerId),
            { providerId, accountId: "missing" },
            providerId?.toString === null ||
              (booleanParameter && databaseMode !== "pglite")
              ? 502
              : 404,
          );
        }
        for (const accountId of [
          true,
          17,
          {},
          [],
          [[]],
          [null],
          [true],
          [[true]],
          ["missing"],
          { toString: null },
        ]) {
          const booleanParameter =
            accountId === true ||
            (Array.isArray(accountId) && accountId.flat(Infinity)[0] === true);
          await logout(
            "raw account selector " + JSON.stringify(accountId),
            { providerId: "account-chatgpt", accountId },
            accountId?.toString === null ||
              (booleanParameter && databaseMode !== "pglite")
              ? 502
              : 404,
          );
        }
        assert.deepEqual(
          await visit(
            "malformed selectors preserve every account",
            "GET",
            accounts(),
          ),
          beforeMalformed,
          "truthy empty arrays must not select or mutate the default account",
        );
        await logout(
          "credential clear actual SQL failure",
          { providerId: "account-chatgpt", accountId: ids.badClear },
          502,
        );
        await logout(
          "binding clear failure rolls back the credential removal",
          { providerId: "account-chatgpt", accountId: ids.badBindingClear },
          502,
        );
        await upload(
          "upload before invalid auth-status publication",
          ids.created,
        );
        await logout(
          "invalid worker status fails after credential removal",
          {
            providerId: "account-chatgpt",
            accountId: ids.created,
            workerId: "",
          },
          502,
        );
        assert.equal(
          (
            await visit(
              "account remains signed out after publication failure",
              "GET",
              accounts(),
            )
          ).find((account) => account.id === ids.created).credentialState,
          "signed-out",
        );
        await visit(
          "publication failure does not restore the credential",
          "GET",
          credentialUrl(ids.created),
          {
            client: "worker",
            csrf: false,
            headers: workerHeaders(),
            status: 404,
          },
        );

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
        const authEvent = async (account) => {
          const event = await live.message(
            (frame) =>
              frame.type === "event" &&
              frame.resource === "provider-auth" &&
              frame.entityId === account,
          );
          assert.equal(event.action, "status");
          assert.equal(event.payload.providerAccountId, account);
          assert.equal(event.revision, event.payload.revision);
          assert.ok(Number.isSafeInteger(event.revision) && event.revision > 0);
          const previous = result.authEvents.at(-1);
          if (previous) assert.ok(event.revision > previous.actualRevision);
          const normalized = fixture.normalize(event.payload);
          normalized.revision = "<monotonic>";
          result.authEvents.push({
            entityId: account,
            actualRevision: event.revision,
            payload: normalized,
          });
          assert.deepEqual(normalized.status, {
            state: "signed-out",
            authMode: null,
            email: null,
            planType: null,
            weeklyUsage: null,
            failureCode: null,
          });
          return event;
        };
        await visit(
          "enable first ordered account",
          "PATCH",
          accounts(undefined, ids.created),
          { json: { enabled: true } },
        );
        await logout("global sign-out uses the first enabled account", {
          providerId: "account-chatgpt",
        });
        await authEvent(ids.created);
        await logout("global sign-out without a worker", {
          providerId: "account-chatgpt",
          accountId: ids.first,
        });
        await authEvent(ids.first);
        await visit(
          "delete signed-out account",
          "DELETE",
          accounts(undefined, ids.created),
          { status: 204 },
        );
        let clearError = false;
        worker = new SocketProbe(fixture, {
          credential: fixture.records.get("paired").credential,
          onRequest(frame, socket) {
            const command = frame.command;
            if (command.type === "provider.auth.legacy.capture") {
              const capture = [ids.captured].includes(
                command.providerAccountId,
              );
              socket.send(
                JSON.stringify({
                  kind: "response",
                  requestId: frame.requestId,
                  ok: true,
                  result: capture
                    ? {
                        status: "available",
                        credential,
                        metadata: { expiresAt: null },
                        portableAuth: true,
                      }
                    : { status: "missing" },
                }),
              );
              return true;
            }
            if (command.type === "provider.auth.legacy.purge") {
              socket.send(
                JSON.stringify({
                  kind: "response",
                  requestId: frame.requestId,
                  ok: true,
                  result: {
                    purged: true,
                    serverCredentialRevision: command.serverCredentialRevision,
                    subjectBlindIndex: command.expectedSubjectBlindIndex,
                  },
                }),
              );
              return true;
            }
            if (command.type !== "provider.auth.account.clear") return false;
            const task = (async () => {
              const response = await fetch(
                fixture.server.origin +
                  credentialUrl(command.providerAccountId, command.providerId),
                {
                  headers: workerHeaders(),
                  signal: AbortSignal.timeout(15000),
                },
              );
              const body = await response.json();
              assert.equal(
                response.status,
                404,
                "credential clear committed before worker cleanup",
              );
              assert.deepEqual(body, {
                error: "Provider credential not found.",
              });
              result.clearChecks.push({
                accountId: command.providerAccountId,
                kind: command.providerKind,
                status: response.status,
              });
              const reply = () =>
                socket.send(
                  JSON.stringify({
                    kind: "response",
                    requestId: frame.requestId,
                    ok: !clearError,
                    ...(clearError
                      ? {
                          error: {
                            code: "fixture-clear",
                            message: "Controlled cleanup failed",
                          },
                        }
                      : { result: null }),
                  }),
                );
              if (command.providerAccountId === heldAccount) {
                releaseHeld = reply;
                held();
              } else reply();
            })();
            background.add(task);
            task.then(
              () => background.delete(task),
              (error) => {
                background.delete(task);
                backgroundFailures.push(error);
                result.workerObserverFailures = backgroundFailures.map(
                  (error) => error.stack ?? String(error),
                );
              },
            );
            return true;
          },
        });
        await worker.open();
        assert.equal((await worker.message()).state, "pending");
        assert.equal((await worker.message()).state, "ready");
        await upload("upload portable account", ids.portable);
        await logout("global portable sign-out", {
          providerId: "account-chatgpt",
          accountId: ids.portable,
          workerId: "fixture-worker",
        });
        await authEvent(ids.portable);
        await upload("upload Grok account", ids.grok, "account-grok");
        clearError = true;
        await logout("cleanup failure retains Grok global sign-out", {
          providerId: "account-grok",
          accountId: ids.grok,
        });
        await authEvent(ids.grok);
        clearError = false;
        await visit("create account for legacy capture", "POST", accounts(), {
          status: 201,
          json: { id: ids.captured, protectedLabel: policyEnvelope },
        });
        await logout("capture before clearing global account", {
          providerId: "account-chatgpt",
          accountId: ids.captured,
          workerId: "fixture-worker",
        });
        await authEvent(ids.captured);
        for (const account of [ids.cancelled, ids.shutdown]) {
          await visit("create owned operation " + account, "POST", accounts(), {
            status: 201,
            json: { id: account, protectedLabel: policyEnvelope },
          });
          await upload("upload owned operation " + account, account);
        }
        const abortSignOut = async (account) => {
          heldAccount = account;
          releaseHeld = undefined;
          const observed = new Promise((resolve) => {
            held = resolve;
          });
          const client = fixture.client();
          const pending = httpRequest(
            fixture.server.origin + "/api/codex/auth/logout",
            {
              method: "POST",
              headers: {
                origin: "http://127.0.0.1:5173",
                "content-type": "application/json",
                connection: "close",
                ...(client.cookies.size
                  ? {
                      cookie: [...client.cookies]
                        .map(([k, v]) => `${k}=${v}`)
                        .join("; "),
                    }
                  : {}),
                ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
              },
            },
          );
          const outcome = new Promise((resolve) => {
            pending.once("response", (response) => {
              response.resume();
              resolve({ status: response.statusCode });
            });
            pending.once("error", (error) => resolve({ error: error.message }));
          });
          const closed = new Promise((resolve) =>
            pending.once("close", resolve),
          );
          pending.end(
            JSON.stringify({
              providerId: "account-chatgpt",
              accountId: account,
            }),
          );
          let timer;
          try {
            await Promise.race([
              observed,
              new Promise((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error("owned cleanup was not admitted")),
                  15000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
          pending.destroy(new Error("fixture caller disconnected"));
          assert.deepEqual(await outcome, {
            error: "fixture caller disconnected",
          });
          await closed;
          assert.equal(pending.socket?.destroyed, true);
        };
        await abortSignOut(ids.cancelled);
        releaseHeld();
        heldAccount = undefined;
        await authEvent(ids.cancelled);
        result.cancelledOperationCompleted = true;
        if (foreignLive) {
          await foreignLive.ping();
          assert.deepEqual(
            foreignLive.history.filter(
              (frame) =>
                frame.type === "event" &&
                ["settings", "provider-auth"].includes(frame.resource),
            ),
            [],
            "provider auth publications stay within the owner",
          );
        }
        await live.ping();
        const mainEvents = live.history.filter(
          (frame) =>
            frame.type === "event" &&
            ["settings", "provider-auth"].includes(frame.resource),
        );
        assert.deepEqual(
          mainEvents.map((frame) => frame.resource),
          result.authEvents.flatMap(() => ["settings", "provider-auth"]),
          "settings invalidation precedes each safe auth status",
        );
        result.authEvents.forEach((event) => {
          delete event.actualRevision;
        });
        await abortSignOut(ids.shutdown);
        // Shutdown must finish the owned operation after closing its transport,
        // before the database and private database process are closed.
        await live.close();
        live = undefined;
        if (foreignLive) {
          await foreignLive.close();
          foreignLive = undefined;
        }
        await fixture.close();
        worker = undefined;
        heldAccount = undefined;
        await Promise.all(background);
        assert.deepEqual(
          backgroundFailures,
          [],
          "every worker cleanup observer completed",
        );
        repository = await openRepository();
        const snapshot = await repository.request({
          op: "query-json",
          sql: `SELECT jsonb_build_object('state',credential_state,'credentialAbsent',protected_credential IS NULL,'revision',credential_revision) AS result FROM model_provider_accounts WHERE id=${literal(ids.shutdown)}`,
        });
        assert.equal(snapshot.rejected, false, snapshot.diagnostic);
        assert.deepEqual(snapshot.value, {
          state: "signed-out",
          credentialAbsent: true,
          revision: 2,
        });
        result.shutdownState = snapshot.value;
        const failedClear = await repository.request({
          op: "credential-get",
          owner,
          provider: "account-chatgpt",
          account: ids.badClear,
        });
        assert.equal(failedClear.rejected, false, failedClear.diagnostic);
        assert.equal(failedClear.value.state, "signed-in");
        assert.deepEqual(failedClear.value.credential, credential);
        result.failedClearRetained = true;
        const failedBinding = await repository.request({
          op: "credential-get",
          owner,
          provider: "account-chatgpt",
          account: ids.badBindingClear,
        });
        assert.equal(failedBinding.rejected, false, failedBinding.diagnostic);
        assert.equal(failedBinding.value.state, "signed-in");
        assert.equal(failedBinding.value.revision, 1);
        assert.deepEqual(failedBinding.value.credential, credential);
        result.failedBindingClearRetained = true;
        await repository.close();
        repository = undefined;
        await fixture.start();
        const retained = await visit(
          "accounts survive restart",
          "GET",
          accounts(),
        );
        assert.equal(
          retained.find((a) => a.id === ids.shutdown).credentialState,
          "signed-out",
        );
      } finally {
        for (const close of [
          () => worker?.close(),
          () => live?.close(),
          () => foreignLive?.close(),
          () => fixture.close(),
          () => repository?.close(),
        ]) {
          try {
            await close();
          } catch (error) {
            (report.cleanupFailures ??= []).push(error.stack ?? String(error));
          }
        }
      }
    }
    const [expected, actual] = profile.runtimes;
    assert.deepEqual(
      actual.observations,
      expected.observations,
      mode + " account HTTP compatibility",
    );
    for (const field of [
      "authEvents",
      "clearChecks",
      "cancelledOperationCompleted",
      "shutdownState",
      "failedClearRetained",
      "failedBindingClearRetained",
    ])
      assert.deepEqual(actual[field], expected[field], mode + " " + field);
  }
} catch (error) {
  failure = error;
  report.failure = {
    message: error.message,
    stack: error.stack,
    actual: error.actual,
    expected: error.expected,
  };
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
