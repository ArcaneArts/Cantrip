// Exercise the actual authenticated Node and native credential routes over HTTP.
// Database fixtures only seed legacy rows and inspect durable state while the
// servers are stopped, so native PGlite never has two owners of one directory.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample, buildRustServer } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { heartbeat } from "./security-fixtures.mjs";
import { policyEnvelope } from "./policy-wire-fixtures.mjs";
import { capturedCredentialFixture } from "./settings-provider-fixtures.mjs";

const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
const reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-credential-http-"));
const report = {
  suite: "actual-provider-credential-http",
  databaseMode,
  completeReplacement: false,
  root,
  profiles: [],
};
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const credential = capturedCredentialFixture(65);
const changedCredential = {
  ...capturedCredentialFixture(66),
  subjectBlindIndex: credential.subjectBlindIndex,
};
const upload = (expectedRevision = 0, extra = {}) => ({
  credential,
  expectedRevision,
  metadata: { expiresAt: null },
  ...extra,
});
const encryption = {
  supported: true,
  state: "ready",
  principalId: "33333333-3333-4333-8333-333333333333",
  grants: [{ component: "provider-credential", keyRevision: 1 }],
  lastSyncedAt: null,
  error: null,
};
const limitedSecret = "ctwk_" + Buffer.alloc(32, 42).toString("base64url");
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
      const result = { kind, observations: [] };
      profile.runtimes.push(result);
      const visit = async (label, method, url, options = {}) => {
        result.observations.push({
          label,
          ...(await fixture.observe(label, method, url, options)),
        });
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
      const endpoint = (
        account = "empty",
        provider = "credential-chatgpt",
        query = "workerId=fixture-worker",
      ) =>
        `/api/internal/workers/providers/${provider}/accounts/${account}/credential${query === null ? "" : "?" + query}`;
      const workerOptions = (extra = {}) => ({
        client: "worker",
        headers: {
          authorization: `Bearer ${fixture.records.get("paired").credential}`,
        },
        ...extra,
      });
      const read = (label, account, status = 200, options = {}) =>
        visit(
          label,
          "GET",
          endpoint(account),
          workerOptions({ status, ...options }),
        );
      const put = (label, account, json, status = 200, options = {}) =>
        visit(
          label,
          "PUT",
          endpoint(account),
          workerOptions({ json, status, ...options }),
        );
      let repository;
      try {
        await fixture.start();
        let owner, other;
        if (mode === "accounts") {
          for (const client of ["main", "other"])
            await fixture.observe(
              "register " + client,
              "POST",
              "/api/auth/register",
              {
                client,
                status: 201,
                json: {
                  displayName: "Credential " + client,
                  email: `credential-${client}@example.invalid`,
                  password: "isolated credential fixture password",
                },
              },
            );
          owner = fixture.records.get("register main").currentUser.id;
          other = fixture.records.get("register other").currentUser.id;
        } else {
          owner = "00000000-0000-0000-0000-000000000001";
        }
        for (const client of mode === "accounts"
          ? ["main", "other"]
          : ["main"]) {
          const label = client === "main" ? "paired" : "other paired";
          await fixture.observe(
            label + " code",
            "POST",
            "/api/workers/enrollment-codes",
            { client, csrf: true, json: {}, status: 201 },
          );
          await fixture.observe(label, "POST", "/api/internal/workers/enroll", {
            client: "worker",
            status: 201,
            json: {
              code: fixture.records.get(label + " code").code,
              heartbeat: {
                ...heartbeat,
                workerId:
                  client === "main" ? heartbeat.workerId : "other-worker",
              },
            },
          });
        }
        await fixture.observe(
          "query worker code",
          "POST",
          "/api/workers/enrollment-codes",
          {
            csrf: true,
            json: {},
            status: 201,
          },
        );
        await fixture.observe(
          "query worker paired",
          "POST",
          "/api/internal/workers/enroll",
          {
            client: "worker",
            status: 201,
            json: {
              code: fixture.records.get("query worker code").code,
              heartbeat: {
                ...heartbeat,
                workerId: "query-worker,parts",
                encryption,
              },
            },
          },
        );
        await fixture.close();
        repository = await openRepository();
        if (!other) {
          other = "99999999-9999-4999-8999-999999999999";
          await repository.seed(
            `INSERT INTO users(id,kind,email,normalized_email,display_name) VALUES(${literal(other)},'account','credential-other@example.invalid','credential-other@example.invalid','Other')`,
          );
        }
        for (const [id, providerKind, principal] of [
          ["credential-chatgpt", "chatgpt", owner],
          ["credential-grok", "grok", owner],
          ["credential-other-kind", "openai-compatible", owner],
          ["credential-foreign", "chatgpt", other],
        ])
          await repository.seed(
            `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES(${literal(id)},${literal(principal)},${literal(id)},${literal(providerKind)},'https://fixture.invalid')`,
          );
        const accounts = [
          ["empty", "credential-chatgpt", "signed-out", false],
          ["stored", "credential-chatgpt", "signed-in", true],
          ["reauth", "credential-chatgpt", "reauth-required", true],
          ["conflict", "credential-chatgpt", "conflict", true],
          ["signed-out-with-payload", "credential-chatgpt", "signed-out", true],
          ["migration", "credential-chatgpt", "migration-needed", false],
          ["bad-record", "credential-chatgpt", "signed-in", true],
          ["grok", "credential-grok", "signed-out", false],
          ["foreign", "credential-foreign", "signed-out", false],
        ];
        for (const [
          position,
          [id, provider, state, stored],
        ] of accounts.entries()) {
          const protectedCredential =
            id === "bad-record"
              ? {
                  ...credential.protectedCredential,
                  envelope: {
                    ...credential.protectedCredential.envelope,
                    ciphertext: "?",
                  },
                }
              : credential.protectedCredential;
          await repository.seed(
            `INSERT INTO model_provider_accounts(id,provider_id,protected_label,credential_home_key,position,credential_state,credential_revision,credential_subject_blind_index,protected_credential) VALUES(${literal(id)},${literal(provider)},${literal(JSON.stringify(policyEnvelope))},${literal(id)},${position},${literal(state)},${stored ? 4 : 0},${stored ? literal(credential.subjectBlindIndex) : "NULL"},${stored ? literal(JSON.stringify(protectedCredential)) : "NULL"})`,
          );
        }
        await repository.seed(
          `INSERT INTO worker_credentials(id,owner_id,worker_id,secret_hash,scopes) VALUES('55555555-5555-4555-8555-555555555555',${literal(owner)},'fixture-worker',${literal(createHash("sha256").update(limitedSecret).digest("hex"))},'["worker:heartbeat"]')`,
        );
        await repository.close();
        repository = undefined;
        await fixture.start();
        await visit(
          "missing worker query",
          "GET",
          endpoint("empty", undefined, null),
          { client: "worker", status: 400 },
        );
        await visit(
          "empty worker query",
          "GET",
          endpoint("empty", undefined, "workerId="),
          { client: "worker", status: 400 },
        );
        await read("missing authorization", "empty", 401, { headers: {} });
        await read("invalid authorization", "empty", 401, {
          headers: { authorization: "Bearer invalid" },
        });
        await read("scope is required", "empty", 401, {
          headers: { authorization: `Bearer ${limitedSecret}` },
        });
        await visit(
          "worker credential bound to identity",
          "GET",
          endpoint("empty", undefined, "workerId=missing"),
          workerOptions({ status: 401 }),
        );
        await visit(
          "repeated worker query",
          "GET",
          endpoint(
            "empty",
            undefined,
            "workerId=fixture-worker&workerId=fixture-worker",
          ),
          workerOptions({ status: 401 }),
        );
        await put("JSON parser before authorization", "empty", undefined, 400, {
          raw: "{",
          headers: { "content-type": "application/json" },
        });
        await put("valid JSON unauthorized", "empty", {}, 401, { headers: {} });
        await read("provider grant required for reads", "empty", 403);
        await put("provider grant before upload schema", "empty", {}, 403);
        await visit(
          "worker reports provider grant",
          "POST",
          "/api/internal/workers/heartbeat",
          workerOptions({ json: { ...heartbeat, encryption }, status: 202 }),
        );
        await visit(
          "repeated query uses actual text binding",
          "GET",
          endpoint("stored", undefined, "workerId=query-worker&workerId=parts"),
          {
            client: "worker",
            headers: {
              authorization: `Bearer ${fixture.records.get("query worker paired").credential}`,
            },
          },
        );
        if (mode === "accounts") {
          await visit(
            "foreign worker reports grant",
            "POST",
            "/api/internal/workers/heartbeat",
            {
              client: "worker",
              headers: {
                authorization: `Bearer ${fixture.records.get("other paired").credential}`,
              },
              json: { ...heartbeat, workerId: "other-worker", encryption },
              status: 202,
            },
          );
          for (const method of ["GET", "PUT"])
            await visit(
              "foreign worker cannot access account " + method,
              method,
              endpoint("stored", undefined, "workerId=other-worker"),
              {
                client: "worker",
                headers: {
                  authorization: `Bearer ${fixture.records.get("other paired").credential}`,
                },
                ...(method === "PUT" ? { json: upload(4) } : {}),
                status: 404,
              },
            );
          await read(
            "worker owner overrides foreign browser session",
            "stored",
            200,
            { client: "other" },
          );
        } else {
          for (const method of ["GET", "PUT"])
            await visit(
              "development missing worker " + method,
              method,
              endpoint("stored", undefined, "workerId=missing"),
              {
                client: "worker",
                headers: {
                  authorization: `Bearer ${fixture.environment.CANTRIP_WORKER_TOKEN}`,
                },
                ...(method === "PUT" ? { json: upload(4) } : {}),
                status: method === "GET" ? 404 : 403,
              },
            );
          await read(
            "development credential reads owned record",
            "stored",
            200,
            {
              headers: {
                authorization: `Bearer ${fixture.environment.CANTRIP_WORKER_TOKEN}`,
              },
            },
          );
        }
        for (const [account, status] of [
          ["empty", 404],
          ["stored", 200],
          ["reauth", 409],
          ["conflict", 409],
          ["signed-out-with-payload", 200],
          ["migration", 404],
          ["bad-record", 500],
          ["missing", 404],
        ])
          await read("read state " + account, account, status);
        await visit(
          "HEAD stored credential",
          "HEAD",
          endpoint("stored"),
          workerOptions(),
        );
        await visit(
          "HEAD conflict",
          "HEAD",
          endpoint("conflict"),
          workerOptions({ status: 409 }),
        );
        for (const method of ["GET", "PUT"])
          for (const provider of [
            "missing",
            "credential-other-kind",
            "credential-foreign",
            "credential-grok",
          ]) {
            await visit(
              "provider scope " + provider + " " + method,
              method,
              endpoint("stored", provider),
              workerOptions({
                status: 404,
                ...(method === "PUT" ? { json: upload(4) } : {}),
              }),
            );
          }
        await put("missing upload body", "empty", undefined, 400);
        await put("empty JSON upload body", "empty", undefined, 400, {
          raw: "",
          headers: {
            ...workerOptions().headers,
            "content-type": "application/json",
          },
        });
        await put("text upload body", "empty", undefined, 400, {
          raw: "hello",
          headers: { ...workerOptions().headers, "content-type": "text/plain" },
        });
        for (const [label, input] of [
          ["missing fields", {}],
          ["null body", null],
          ["negative revision", upload(-1)],
          ["fractional revision", upload(0.5)],
          ["extra upload field", { ...upload(), opaque: true }],
          [
            "extra metadata field",
            upload(0, { metadata: { expiresAt: null, opaque: true } }),
          ],
          [
            "noncanonical subject",
            upload(0, {
              credential: { ...credential, subjectBlindIndex: "B".repeat(43) },
            }),
          ],
          [
            "invalid expiry",
            upload(0, { metadata: { expiresAt: "tomorrow" } }),
          ],
        ])
          await put("upload validation " + label, "empty", input, 400);
        const stored = await put("first opaque upload", "empty", upload());
        assert.deepEqual(stored.credential, credential);
        assert.equal(stored.credentialRevision, 1);
        assert.deepEqual(await read("read uploaded envelope", "empty"), stored);
        await put("stale revision", "empty", upload(), 409);
        await put(
          "identity mismatch is sanitized",
          "empty",
          upload(1, { credential: capturedCredentialFixture(67) }),
          500,
        );
        assert.deepEqual(
          await read("failed writes preserve credential", "empty"),
          stored,
        );
        const replaced = await put(
          "same identity refresh",
          "empty",
          upload(1, {
            credential: changedCredential,
            metadata: { expiresAt: "2030-01-01T00:00:00.123456789Z" },
          }),
        );
        assert.deepEqual(replaced.credential, changedCredential);
        assert.equal(replaced.credentialRevision, 2);
        await put(
          "actual SQL expiry rejection",
          "empty",
          upload(2, { metadata: { expiresAt: "0000-01-01T00:00:00.000Z" } }),
          500,
        );
        assert.deepEqual(
          await read("failed expiry preserves refreshed envelope", "empty"),
          replaced,
        );
        await put("reauth account can refresh", "reauth", upload(4));
        await read("reauth refresh state cleared", "reauth");
        await put(
          "conflict account same subject can refresh",
          "conflict",
          upload(4),
        );
        await read("conflict refresh state cleared", "conflict");
        const grok = await visit(
          "Grok opaque upload",
          "PUT",
          endpoint("grok", "credential-grok"),
          workerOptions({ json: upload() }),
        );
        assert.equal(grok.providerKind, "grok");
        await fixture.close();
        repository = await openRepository();
        const persisted = await repository.request({
          op: "credential-get",
          owner,
          provider: "credential-chatgpt",
          account: "empty",
        });
        assert.equal(persisted.rejected, false, persisted.diagnostic);
        assert.deepEqual(persisted.value.credential, changedCredential);
        assert.equal(persisted.value.revision, 2);
        assert.equal(persisted.value.state, "signed-in");
        assert.equal(
          persisted.value.metadata.expiresAt,
          "2030-01-01T00:00:00.123Z",
        );
        // Expiry is client metadata, already asserted exactly above. Only
        // server-generated identities and timestamps use fixture aliases.
        const { metadata, ...persistedRecord } = persisted.value;
        result.persisted = { ...fixture.normalize(persistedRecord), metadata };
        await repository.close();
        repository = undefined;
        await fixture.start();
        assert.deepEqual(
          await read("restart retains committed credential", "empty"),
          replaced,
        );
        await visit(
          "revoke worker credential",
          "DELETE",
          `/api/workers/fixture-worker/credentials/${fixture.records.get("paired").credentialSummary.id}`,
          { csrf: true, status: 204 },
        );
        await read("revoked worker cannot read", "empty", 401);
        await put("revoked worker cannot write", "empty", upload(2), 401);
      } finally {
        for (const close of [
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
    assert.deepEqual(
      profile.runtimes[1].observations,
      profile.runtimes[0].observations,
      mode + " actual credential HTTP compatibility",
    );
    assert.deepEqual(
      profile.runtimes[1].persisted,
      profile.runtimes[0].persisted,
      mode + " retained credential state",
    );
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
    failure: report.failure,
    cleanupFailures: report.cleanupFailures,
  }),
);
if (failure) throw failure;
assert.deepEqual(report.cleanupFailures ?? [], []);
