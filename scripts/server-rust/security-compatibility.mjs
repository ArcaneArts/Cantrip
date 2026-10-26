// Exercise the actual Node service and native Rust executable over HTTP.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { buildRustServer } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { securityCryptoFlow } from "./security-crypto-flow.mjs";
import {
  initialization,
  clientId,
  clientWrapper,
  publicKey,
  password,
  passwordWrapper,
  kdf,
} from "./security-fixtures.mjs";

const option = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(databaseMode));
const executable =
  process.env.CANTRIP_RUST_SERVER_BINARY ?? (await buildRustServer());
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-security-compatibility-"),
);
const passwordHash = await hashPassword(password);
const report = {
  schemaVersion: 1,
  suite: "account-security-http",
  databaseMode,
  completeReplacement: false,
  profiles: [],
};
const secondId = "55555555-5555-4555-8555-555555555555",
  missingId = "66666666-6666-4666-8666-666666666666";
let postgresOwner, failure;
const profiles = [
  { name: "none", mode: "none" },
  { name: "password", mode: "password" },
  { name: "accounts", mode: "accounts" },
  { name: "administrator", mode: "accounts", admin: true },
].filter((p) => !option("--profile") || p.name === option("--profile"));
assert.ok(profiles.length, "Unknown security profile");
try {
  if (databaseMode !== "pglite")
    postgresOwner = await postgresFixture(
      path.join(root, "reference-postgres"),
    );
  for (const profile of profiles) {
    const environment = { CANTRIP_AUTH_MODE: profile.mode };
    if (profile.mode === "password")
      environment.CANTRIP_PASSWORD_HASH = passwordHash;
    if (profile.admin)
      Object.assign(environment, {
        CANTRIP_ADMIN_EMAIL: "admin@example.invalid",
        CANTRIP_ADMIN_PASSWORD: password,
      });
    const pair = ["node", "rust"].map(
      (kind) =>
        new HttpFixture({
          kind,
          executable,
          root,
          name: profile.name,
          databaseMode,
          environment,
        }),
    );
    if (postgresOwner) {
      pair[0].environment.DATABASE_URL = await postgresOwner.database();
      if (databaseMode === "postgres")
        pair[1].environment.DATABASE_URL = await postgresOwner.database();
      else
        pair[1].environment.CANTRIP_POSTGRES_BIN_DIR =
          process.env.CANTRIP_TEST_POSTGRES_BIN_DIR;
    }
    const result = { name: profile.name, cases: [] };
    report.profiles.push(result);
    async function visit(label, method, url, options = {}) {
      const expected = await pair[0].observe(label, method, url, options),
        actual = await pair[1].observe(label, method, url, options);
      assert.deepEqual(actual, expected, `${profile.name}/${label}`);
      result.cases.push({ label, ...actual });
      return actual;
    }
    const mutate = { csrf: true };
    try {
      for (const fixture of pair) await fixture.start();
      await visit("profile before sign-in", "GET", "/api/encryption/profile", {
        status: profile.mode === "none" ? 200 : 401,
      });
      if (profile.mode === "password")
        await visit("password sign-in", "POST", "/api/auth/login", {
          json: { password },
        });
      if (profile.mode === "accounts")
        await visit(
          "account sign-in",
          "POST",
          profile.admin ? "/api/auth/login" : "/api/auth/register",
          {
            json: profile.admin
              ? { email: "admin@example.invalid", password }
              : {
                  email: "owner@example.invalid",
                  displayName: "Fixture owner",
                  password,
                },
            status: profile.admin ? 200 : 201,
          },
        );
      if (profile.mode !== "none")
        await visit("current session", "GET", "/api/auth/session");
      await visit("empty profile", "GET", "/api/encryption/profile");
      await visit("empty principal list", "GET", "/api/encryption/principals");
      await visit("profile HEAD", "HEAD", "/api/encryption/profile");
      await visit("principals HEAD", "HEAD", "/api/encryption/principals");
      await visit(
        "missing grant principal",
        "GET",
        `/api/encryption/principals/${missingId}/grants`,
        { status: 404 },
      );
      await visit(
        "migration requires profile",
        "PATCH",
        "/api/encryption/profile/migration",
        {
          ...mutate,
          json: { expectedRevision: 1, payloadMigrationStatus: "complete" },
          status: 409,
        },
      );
      if (profile.mode !== "none")
        await visit(
          "password wrapper required",
          "POST",
          "/api/encryption/profile/initialize",
          { ...mutate, json: initialization(clientId, false), status: 400 },
        );
      const protectedProfile = profile.mode !== "none";
      await visit("initialized", "POST", "/api/encryption/profile/initialize", {
        ...mutate,
        json: initialization(clientId, protectedProfile),
        status: 201,
      });
      await visit(
        "initialize conflict",
        "POST",
        "/api/encryption/profile/initialize",
        {
          ...mutate,
          json: initialization(clientId, protectedProfile),
          status: 409,
        },
      );
      const state = await visit(
        "initialized state",
        "GET",
        "/api/encryption/profile",
      );
      assert.equal(state.body.profile.revision, 1);
      await visit(
        "grants HEAD",
        "HEAD",
        `/api/encryption/principals/${clientId}/grants`,
      );
      for (const fixture of pair) {
        const profile = fixture.records.get("initialized").profile;
        assert.deepEqual(
          profile.passwordWrappedMasterKey,
          protectedProfile ? passwordWrapper : null,
        );
        assert.deepEqual(
          fixture.records.get("initialized").grant.wrappedKey,
          clientWrapper(),
        );
      }
      const badRoutes = [
        ["POST", "/api/encryption/profile/initialize"],
        ["PATCH", "/api/encryption/profile/migration"],
        ["POST", "/api/encryption/principals"],
        ["POST", `/api/encryption/principals/${clientId}/approve`],
        ["POST", `/api/encryption/principals/${clientId}/revoke`],
        ["POST", `/api/encryption/principals/${clientId}/grants`],
        ["POST", `/api/encryption/grants/${missingId}/revoke`],
        ...(profile.mode === "accounts"
          ? [["POST", "/api/account/password"]]
          : []),
      ];
      for (const [method, url] of badRoutes)
        for (const [i, json] of [null, [], {}, 42].entries()) {
          await visit(`invalid ${url} ${i}`, method, url, {
            ...mutate,
            json,
            status: 400,
          });
        }
      await visit(
        "invalid nested wrapper",
        "POST",
        "/api/encryption/profile/initialize",
        {
          ...mutate,
          json: {
            ...initialization(),
            profile: { ...initialization().profile, "bad\ud800": true },
          },
          status: 400,
        },
      );
      await visit(
        "opaque payload poison key",
        "POST",
        "/api/encryption/profile/initialize",
        {
          ...mutate,
          raw: '{"__proto__":{"fixture":true}}',
          headers: { "content-type": "application/json" },
          status: 400,
        },
      );
      await visit(
        "migration stale revision",
        "PATCH",
        "/api/encryption/profile/migration",
        {
          ...mutate,
          json: { expectedRevision: 5, payloadMigrationStatus: "complete" },
          status: 409,
        },
      );
      await visit(
        "migration update",
        "PATCH",
        "/api/encryption/profile/migration",
        {
          ...mutate,
          json: { expectedRevision: 1, payloadMigrationStatus: "in-progress" },
        },
      );
      await visit(
        "migration update stale",
        "PATCH",
        "/api/encryption/profile/migration",
        {
          ...mutate,
          json: { expectedRevision: 1, payloadMigrationStatus: "complete" },
          status: 409,
        },
      );
      await visit("new client", "POST", "/api/encryption/principals", {
        ...mutate,
        json: {
          id: secondId,
          kind: "client",
          label: "  🦀\ud800 client  ",
          publicKey,
        },
        status: 201,
      });
      await visit("client ID duplicate", "POST", "/api/encryption/principals", {
        ...mutate,
        json: { id: secondId, kind: "client", publicKey },
        status: 409,
      });
      await visit(
        "pending grants",
        "GET",
        `/api/encryption/principals/${secondId}/grants`,
        { status: 409 },
      );
      await visit(
        "grant unavailable",
        "POST",
        `/api/encryption/principals/${secondId}/grants`,
        {
          ...mutate,
          json: {
            component: "account-master-key",
            keyRevision: 1,
            wrappedKey: clientWrapper(secondId),
          },
          status: 409,
        },
      );
      await visit(
        "approval stale revision",
        "POST",
        `/api/encryption/principals/${secondId}/approve`,
        { ...mutate, json: { expectedRevision: 9 }, status: 409 },
      );
      await visit(
        "approved client",
        "POST",
        `/api/encryption/principals/${secondId}/approve`,
        { ...mutate, json: { expectedRevision: 1 } },
      );
      await visit(
        "repeat approval",
        "POST",
        `/api/encryption/principals/${secondId}/approve`,
        { ...mutate, json: { expectedRevision: 2 }, status: 409 },
      );
      await visit(
        "approved no grants",
        "GET",
        `/api/encryption/principals/${secondId}/grants`,
      );
      await visit(
        "wrong target wrapper",
        "POST",
        `/api/encryption/principals/${secondId}/grants`,
        {
          ...mutate,
          json: {
            component: "account-master-key",
            keyRevision: 1,
            wrappedKey: clientWrapper(),
          },
          status: 400,
        },
      );
      const grant = {
        component: "account-master-key",
        keyRevision: 1,
        wrappedKey: clientWrapper(secondId),
      };
      await visit(
        "new grant",
        "POST",
        `/api/encryption/principals/${secondId}/grants`,
        { ...mutate, json: grant, status: 201 },
      );
      for (const fixture of pair)
        assert.deepEqual(
          fixture.records.get("new grant").wrappedKey,
          grant.wrappedKey,
        );
      await visit(
        "grant duplicate",
        "POST",
        `/api/encryption/principals/${secondId}/grants`,
        { ...mutate, json: grant, status: 409 },
      );
      await visit(
        "active grants",
        "GET",
        `/api/encryption/principals/${secondId}/grants`,
      );
      const grantUrl = (f) =>
        `/api/encryption/grants/${f.records.get("new grant").id}/revoke`;
      await visit("revoke stale grant", "POST", grantUrl, {
        ...mutate,
        json: { expectedRevision: 5, reason: "fixture revoke" },
        status: 409,
      });
      await visit("revoke grant", "POST", grantUrl, {
        ...mutate,
        json: { expectedRevision: 1, reason: "  fixture\ud800 reason  " },
      });
      await visit("revoke grant again", "POST", grantUrl, {
        ...mutate,
        json: { expectedRevision: 2, reason: "fixture revoke" },
        status: 409,
      });
      await visit(
        "revoked grant absent",
        "GET",
        `/api/encryption/principals/${secondId}/grants`,
      );
      await visit(
        "revoked grant blocks duplicate",
        "POST",
        `/api/encryption/principals/${secondId}/grants`,
        { ...mutate, json: grant, status: 409 },
      );
      await visit(
        "worker without enrollment",
        "POST",
        "/api/encryption/principals",
        {
          ...mutate,
          json: {
            id: missingId,
            kind: "worker",
            workerId: "unregistered-worker",
            publicKey,
          },
          status: 409,
        },
      );
      await visit(
        "revoke initial principal",
        "POST",
        `/api/encryption/principals/${clientId}/revoke`,
        { ...mutate, json: { expectedRevision: 1, reason: "fixture revoke" } },
      );
      await visit(
        "revoked principal denies grants",
        "GET",
        `/api/encryption/principals/${clientId}/grants`,
        { status: 409 },
      );
      await visit(
        "revoked principal reapproval denied",
        "POST",
        `/api/encryption/principals/${clientId}/approve`,
        { ...mutate, json: { expectedRevision: 2 }, status: 409 },
      );
      const change = {
        currentPassword: password,
        newPassword: "changed fixture password",
        expectedProfileRevision: 2,
        passwordKdf: kdf,
        passwordWrappedMasterKey: passwordWrapper,
      };
      if (profile.mode !== "accounts")
        await visit(
          "unavailable account password",
          "POST",
          "/api/account/password",
          { ...mutate, json: change, status: 404 },
        );
      else if (profile.admin)
        await visit(
          "configured administrator password",
          "POST",
          "/api/account/password",
          { ...mutate, json: change, status: 409 },
        );
      else {
        await visit("wrong current password", "POST", "/api/account/password", {
          ...mutate,
          json: { ...change, currentPassword: "incorrect" },
          status: 403,
        });
        await visit(
          "stale password wrapper revision",
          "POST",
          "/api/account/password",
          {
            ...mutate,
            json: { ...change, expectedProfileRevision: 1 },
            status: 409,
          },
        );
        await visit(
          "stale change preserves password",
          "POST",
          "/api/auth/reauthenticate",
          { ...mutate, json: { password } },
        );
        await visit("changed password", "POST", "/api/account/password", {
          ...mutate,
          json: change,
        });
        await visit("old password refused", "POST", "/api/auth/login", {
          json: { email: "owner@example.invalid", password },
          status: 401,
          client: "old-password",
        });
        await visit("new password accepted", "POST", "/api/auth/login", {
          json: {
            email: "owner@example.invalid",
            password: change.newPassword,
          },
          client: "new-password",
        });
        await visit("other tenant", "POST", "/api/auth/register", {
          json: {
            email: "other@example.invalid",
            displayName: "Other owner",
            password,
          },
          status: 201,
          client: "other",
        });
        await visit("tenant empty profile", "GET", "/api/encryption/profile", {
          client: "other",
        });
        await visit(
          "tenant empty principals",
          "GET",
          "/api/encryption/principals",
          { client: "other" },
        );
        await visit(
          "tenant cannot see grant",
          "GET",
          `/api/encryption/principals/${secondId}/grants`,
          { status: 404, client: "other" },
        );
        await visit(
          "tenant cannot revoke principal",
          "POST",
          `/api/encryption/principals/${secondId}/revoke`,
          {
            ...mutate,
            json: { expectedRevision: 2, reason: "fixture revoke" },
            status: 409,
            client: "other",
          },
        );
      }
      if (profile.name === "accounts") {
        result.clientCrypto = {};
        for (const fixture of pair)
          result.clientCrypto[fixture.kind] = await securityCryptoFlow(fixture);
      }
      await visit("list sessions", "GET", "/api/account/sessions");
      await visit("list audit", "GET", "/api/account/audit-events");
      for (const query of [
        "limit=1",
        "limit=2",
        "before=99999&limit=3",
        "limit=0",
        "limit=201",
        "before=0",
        "limit=1&limit=2",
        "limit=0x10",
        "before=1e3&limit=2",
        "limit=",
      ]) {
        const invalid = [
          "limit=0",
          "limit=201",
          "before=0",
          "limit=1&limit=2",
          "limit=",
        ].includes(query);
        await visit(
          `audit query ${query}`,
          "GET",
          `/api/account/audit-events?${query}`,
          { status: invalid ? 400 : 200 },
        );
      }
      {
        await visit("administrator summary", "GET", "/api/admin/accounts");
        await visit(
          "administrator audit",
          "GET",
          "/api/admin/audit-events?limit=3",
        );
        await visit(
          "whitelist invalid",
          "POST",
          "/api/admin/license-whitelist",
          { ...mutate, json: { email: "invalid" }, status: 400 },
        );
        if (profile.admin)
          await visit(
            "administrator automatically licensed",
            "POST",
            "/api/admin/license-whitelist",
            {
              ...mutate,
              json: { email: "ADMIN@example.invalid" },
              status: 409,
            },
          );
        await visit(
          "whitelist created",
          "POST",
          "/api/admin/license-whitelist",
          {
            ...mutate,
            json: { email: "Licensed@Example.invalid" },
            status: 201,
          },
        );
        await visit(
          "whitelist duplicate normalized",
          "POST",
          "/api/admin/license-whitelist",
          {
            ...mutate,
            json: { email: "licensed@example.invalid" },
            status: 409,
          },
        );
        await visit("whitelist summary", "GET", "/api/admin/accounts");
        const whitelistUrl = (f) =>
          `/api/admin/license-whitelist/${f.records.get("whitelist created").id}`;
        await visit("whitelist deleted", "DELETE", whitelistUrl, {
          ...mutate,
          status: 204,
        });
        await visit("whitelist missing", "DELETE", whitelistUrl, {
          ...mutate,
          status: 404,
        });
      }
      if (profile.name === "accounts") {
        await visit(
          "member administrator denied",
          "GET",
          "/api/admin/accounts",
          { client: "other", status: 403 },
        );
        await visit(
          "member audit denied",
          "GET",
          "/api/admin/audit-events?limit=invalid",
          { client: "other", status: 403 },
        );
        await visit(
          "member whitelist denied",
          "POST",
          "/api/admin/license-whitelist",
          {
            client: "other",
            csrf: true,
            json: { email: "member@example.invalid" },
            status: 403,
          },
        );
      }
      const snapshots = [];
      for (const f of pair) {
        await f.observe(
          "before restart profile",
          "GET",
          "/api/encryption/profile",
        );
        await f.observe(
          "before restart principals",
          "GET",
          "/api/encryption/principals",
        );
        snapshots.push([
          f.records.get("before restart profile"),
          f.records.get("before restart principals"),
        ]);
        await f.close();
        await f.start();
      }
      await visit("retained profile", "GET", "/api/encryption/profile");
      await visit("retained principals", "GET", "/api/encryption/principals");
      pair.forEach((f, i) => {
        assert.deepEqual(f.records.get("retained profile"), snapshots[i][0]);
        assert.deepEqual(f.records.get("retained principals"), snapshots[i][1]);
      });
      await visit(
        "retained audit",
        "GET",
        "/api/account/audit-events?limit=200",
      );
      result.passed = true;
    } finally {
      const closed = await Promise.allSettled(pair.map((f) => f.close()));
      const errors = closed
        .filter((r) => r.status === "rejected")
        .map((r) => r.reason);
      if (errors.length)
        throw new AggregateError(errors, "Security fixture cleanup failed");
    }
  }
  if (databaseMode === "postgres" && !option("--profile")) {
    const fixture = new HttpFixture({
      kind: "node",
      executable,
      root,
      name: "cross-runtime",
      databaseMode,
      environment: {
        CANTRIP_AUTH_MODE: "accounts",
        DATABASE_URL: await postgresOwner.database(),
      },
    });
    const runtimes = ["node"];
    try {
      await fixture.start();
      report.crossRuntimeEncryption = await securityCryptoFlow(
        fixture,
        async (phase, fixture) => {
          await fixture.close();
          fixture.kind = phase === "after-initialize" ? "rust" : "node";
          runtimes.push(fixture.kind);
          await fixture.start();
        },
      );
      report.crossRuntimeEncryption.runtimes = runtimes;
      assert.deepEqual(runtimes, ["node", "rust", "node"]);
    } finally {
      await fixture.close();
    }
  }
} catch (error) {
  failure = error;
  report.failure = {
    message: error.message,
    actual: error.actual,
    expected: error.expected,
  };
} finally {
  await postgresOwner?.close();
  await rm(root, { recursive: true, force: true });
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(
    JSON.stringify(
      {
        suite: report.suite,
        databaseMode,
        profiles: report.profiles.map((p) => ({
          name: p.name,
          cases: p.cases.length,
          passed: p.passed,
        })),
        failure: report.failure,
      },
      null,
      2,
    ),
  );
}
if (failure) throw failure;
