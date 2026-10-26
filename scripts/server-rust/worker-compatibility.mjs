import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { buildRustServer } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import {
  heartbeat,
  initialization,
  publicKey,
  password,
  workerWrapper,
} from "./security-fixtures.mjs";
import { workerSocketFlow } from "./worker-sockets.mjs";
import { workerAuthenticationFaults } from "./worker-authentication-faults.mjs";
import { workerHandshakes } from "./worker-handshakes.mjs";

const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(databaseMode));
const executable =
  process.env.CANTRIP_RUST_SERVER_BINARY ?? (await buildRustServer());
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-worker-compatibility-"),
);
const hash = await hashPassword(password),
  report = {
    schemaVersion: 1,
    suite: "worker-control-http",
    databaseMode,
    completeReplacement: false,
    profiles: [],
  };
let postgresOwner, failure;
const principal = "33333333-3333-4333-8333-333333333333",
  replacementPrincipal = "88888888-8888-4888-8888-888888888888";
const profiles = [
  { name: "development", mode: "none" },
  { name: "password", mode: "password" },
  { name: "accounts", mode: "accounts" },
  { name: "standalone", mode: "none", standalone: true },
  { name: "pairing-rate", mode: "none", rate: 2 },
].filter((p) => !option("--profile") || option("--profile") === p.name);
assert.ok(profiles.length);
try {
  if (databaseMode !== "pglite")
    postgresOwner = await postgresFixture(
      path.join(root, "reference-postgres"),
    );
  for (const profile of profiles) {
    const environment = { CANTRIP_AUTH_MODE: profile.mode };
    if (profile.mode === "password") environment.CANTRIP_PASSWORD_HASH = hash;
    if (profile.standalone) environment.CANTRIP_BOOTSTRAP_MODE = "standalone";
    if (profile.rate)
      environment.CANTRIP_PAIRING_RATE_LIMIT_PER_MINUTE = String(profile.rate);
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
    if (profile.standalone)
      for (const fixture of pair)
        delete fixture.environment.CANTRIP_WORKER_TOKEN;
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
    const credentials = (f) => f.records.get("paired").credential;
    const workerRequest = (f, credential = credentials(f)) => ({
      authorization: `Bearer ${credential}`,
    });
    try {
      for (const f of pair) await f.start();
      if (profile.rate) {
        await visit(
          "invalid exchange consumes pairing slot",
          "POST",
          "/api/internal/workers/enroll",
          { json: {}, status: 400 },
        );
        await visit(
          "invalid JSON consumes pairing slot",
          "POST",
          "/api/workers/enrollment-codes",
          {
            raw: "{",
            headers: { "content-type": "application/json" },
            status: 400,
          },
        );
        await visit(
          "shared pairing limit",
          "POST",
          "/api/workers/enrollment-codes",
          { json: {}, status: 429 },
        );
        result.passed = true;
        continue;
      }
      await visit("catalog before login", "GET", "/api/workers", {
        status: profile.mode === "none" ? 200 : 401,
      });
      if (profile.mode === "password")
        await visit("password login", "POST", "/api/auth/login", {
          json: { password },
        });
      if (profile.mode === "accounts")
        await visit("account registration", "POST", "/api/auth/register", {
          json: {
            email: "owner@example.invalid",
            displayName: "Fixture owner",
            password,
          },
          status: 201,
        });
      if (profile.mode !== "none")
        await visit("session", "GET", "/api/auth/session");
      await visit("empty catalog", "GET", "/api/workers");
      await visit(
        "connect without upgrade",
        "GET",
        "/api/internal/workers/connect?workerId=fixture-worker",
        { status: 404 },
      );
      await visit(
        "missing enrollment status",
        "GET",
        "/api/workers/enrollment-codes/missing",
        { status: 404 },
      );
      await visit(
        "missing credentials",
        "GET",
        "/api/workers/missing/credentials",
        { status: 404 },
      );
      await visit(
        "missing rotation",
        "POST",
        "/api/workers/missing/credentials/rotate",
        { ...mutate, json: {}, status: 404 },
      );
      await visit(
        "missing credential revoke",
        "DELETE",
        "/api/workers/missing/credentials/missing",
        { ...mutate, status: 404 },
      );
      for (const [i, json] of [
        [],
        42,
        { expiresInSeconds: 59 },
        { expiresInSeconds: 1801 },
        { label: "a".repeat(201) },
        { candidateWorkerIds: [""] },
      ].entries())
        await visit(
          `invalid pairing ${i}`,
          "POST",
          "/api/workers/enrollment-codes",
          { ...mutate, json, status: 400 },
        );
      await visit("code created", "POST", "/api/workers/enrollment-codes", {
        ...mutate,
        json: {
          label: "  🦀\ud800 code  ",
          candidateWorkerIds: ["fixture-worker", "fixture-worker"],
        },
        status: 201,
      });
      const statusUrl = (f) =>
        `/api/workers/enrollment-codes/${f.records.get("code created").id}`;
      await visit("pending status", "GET", statusUrl);
      await visit(
        "heartbeat unauthorized",
        "POST",
        "/api/internal/workers/heartbeat",
        { json: heartbeat, status: 401, client: "worker" },
      );
      await visit("invalid code", "POST", "/api/internal/workers/enroll", {
        json: { code: `ctwl_${"A".repeat(32)}`, heartbeat },
        status: 409,
        client: "worker",
      });
      await visit("paired", "POST", "/api/internal/workers/enroll", {
        json: (f) => ({ code: f.records.get("code created").code, heartbeat }),
        status: 201,
        client: "worker",
      });
      await visit("paired status", "GET", statusUrl);
      await visit("single use code", "POST", "/api/internal/workers/enroll", {
        json: (f) => ({ code: f.records.get("code created").code, heartbeat }),
        status: 409,
        client: "worker",
      });
      await visit(
        "credentials list",
        "GET",
        "/api/workers/fixture-worker/credentials",
      );
      await visit("catalog uses connection status", "GET", "/api/workers");
      await visit(
        "heartbeat valid",
        "POST",
        "/api/internal/workers/heartbeat",
        {
          json: heartbeat,
          headers: (f) => workerRequest(f),
          status: 202,
          client: "worker",
        },
      );
      // Header callbacks are resolved below so actual credentials never enter reports.
      for (const authorization of [
        "bearer ",
        "Basic ",
        "Bearer ",
        `Bearer ${"x".repeat(513)}`,
      ])
        await visit(
          `bad bearer ${authorization.slice(0, 7)} ${authorization.length}`,
          "POST",
          "/api/internal/workers/heartbeat",
          {
            json: heartbeat,
            headers: { authorization },
            status: 401,
            client: "worker",
          },
        );
      await visit(
        "credential requires matching worker",
        "POST",
        "/api/internal/workers/heartbeat",
        {
          json: { ...heartbeat, workerId: "different-worker" },
          headers: (f) => workerRequest(f),
          status: 401,
          client: "worker",
        },
      );
      await visit(
        "authenticated invalid heartbeat",
        "POST",
        "/api/internal/workers/heartbeat",
        {
          json: { workerId: heartbeat.workerId },
          headers: (f) => workerRequest(f),
          status: 400,
          client: "worker",
        },
      );
      await visit(
        "normalized heartbeat date",
        "POST",
        "/api/internal/workers/heartbeat",
        {
          json: {
            ...heartbeat,
            name: "  worker\ud800  ",
            startedAt: "2026-10-25T00:00Z",
          },
          headers: (f) => workerRequest(f),
          status: 202,
          client: "worker",
        },
      );
      await visit(
        "long fractional heartbeat date",
        "POST",
        "/api/internal/workers/heartbeat",
        {
          json: {
            ...heartbeat,
            startedAt: "2026-10-25T00:00:00.1234567890123Z",
          },
          headers: (f) => workerRequest(f),
          status: 202,
          client: "worker",
        },
      );
      await visit(
        "profile initialized",
        "POST",
        "/api/encryption/profile/initialize",
        { ...mutate, json: initialization(), status: 201 },
      );
      await visit(
        "bootstrap unauthorized",
        "POST",
        "/api/internal/workers/encryption/bootstrap",
        {
          json: { principalId: principal, publicKey },
          status: 401,
          client: "worker",
        },
      );
      const bootstrapHeaders = (f) => ({
        ...workerRequest(f),
        "x-cantrip-worker-id": heartbeat.workerId,
      });
      await visit(
        "pending encryption bootstrap",
        "POST",
        "/api/internal/workers/encryption/bootstrap",
        {
          json: { principalId: principal, publicKey },
          headers: bootstrapHeaders,
          client: "worker",
        },
      );
      await visit(
        "idempotent encryption bootstrap",
        "POST",
        "/api/internal/workers/encryption/bootstrap",
        {
          json: { principalId: principal, publicKey },
          headers: bootstrapHeaders,
          client: "worker",
        },
      );
      await visit(
        "approve worker principal",
        "POST",
        `/api/encryption/principals/${principal}/approve`,
        { ...mutate, json: { expectedRevision: 1 } },
      );
      await visit(
        "worker grant",
        "POST",
        `/api/encryption/principals/${principal}/grants`,
        {
          ...mutate,
          json: {
            component: "chat-content",
            keyRevision: 1,
            wrappedKey: workerWrapper(),
          },
          status: 201,
        },
      );
      await visit(
        "approved encryption bootstrap",
        "POST",
        "/api/internal/workers/encryption/bootstrap",
        {
          json: { principalId: principal, publicKey },
          headers: bootstrapHeaders,
          client: "worker",
        },
      );
      await visit(
        "rotate encryption identity",
        "POST",
        "/api/internal/workers/encryption/bootstrap",
        {
          json: { principalId: replacementPrincipal, publicKey },
          headers: bootstrapHeaders,
          client: "worker",
        },
      );
      await visit(
        "old identity remains revoked",
        "POST",
        "/api/internal/workers/encryption/bootstrap",
        {
          json: { principalId: principal, publicKey },
          headers: bootstrapHeaders,
          client: "worker",
        },
      );
      await visit(
        "revoked principal grants denied",
        "GET",
        `/api/encryption/principals/${principal}/grants`,
        { status: 409 },
      );
      await visit(
        "bootstrap public key conflict",
        "POST",
        "/api/internal/workers/encryption/bootstrap",
        {
          json: {
            principalId: replacementPrincipal,
            publicKey: {
              ...publicKey,
              value: Buffer.alloc(65, 1).toString("base64url"),
            },
          },
          headers: bootstrapHeaders,
          status: 409,
          client: "worker",
        },
      );
      await visit(
        "extra pairing code",
        "POST",
        "/api/workers/enrollment-codes",
        { ...mutate, json: null, status: 201 },
      );
      await visit(
        "already enrolled denies code",
        "POST",
        "/api/internal/workers/enroll",
        {
          json: (f) => ({
            code: f.records.get("extra pairing code").code,
            heartbeat,
          }),
          status: 409,
          client: "worker",
        },
      );
      await visit(
        "failed exchange retains code",
        "GET",
        (f) =>
          `/api/workers/enrollment-codes/${f.records.get("extra pairing code").id}`,
      );
      if (profile.mode === "accounts") {
        await visit("other account", "POST", "/api/auth/register", {
          json: {
            email: "other@example.invalid",
            displayName: "Other owner",
            password,
          },
          status: 201,
          client: "other",
        });
        await visit("other catalog isolated", "GET", "/api/workers", {
          client: "other",
        });
        await visit(
          "other cannot list credentials",
          "GET",
          "/api/workers/fixture-worker/credentials",
          { client: "other", status: 404 },
        );
        await visit(
          "other cannot rotate credentials",
          "POST",
          "/api/workers/fixture-worker/credentials/rotate",
          { client: "other", csrf: true, json: {}, status: 404 },
        );
        await visit("other cannot inspect code", "GET", statusUrl, {
          client: "other",
          status: 404,
        });
      }
      await visit(
        "rotated",
        "POST",
        "/api/workers/fixture-worker/credentials/rotate",
        { ...mutate, json: { label: "  rotated\ud800 fixture  " } },
      );
      await visit(
        "old credential unauthorized",
        "POST",
        "/api/internal/workers/heartbeat",
        {
          json: heartbeat,
          headers: (f) => workerRequest(f),
          status: 401,
          client: "worker",
        },
      );
      const rotated = (f) =>
        workerRequest(f, f.records.get("rotated").credential);
      await visit(
        "rotated credential valid",
        "POST",
        "/api/internal/workers/heartbeat",
        { json: heartbeat, headers: rotated, status: 202, client: "worker" },
      );
      await visit(
        "credentials show rotation",
        "GET",
        "/api/workers/fixture-worker/credentials",
      );
      for (const f of pair) {
        await f.close();
        await f.start();
      }
      await visit(
        "retained credential valid",
        "POST",
        "/api/internal/workers/heartbeat",
        { json: heartbeat, headers: rotated, status: 202, client: "worker" },
      );
      await visit(
        "revoke retained credential",
        "DELETE",
        (f) =>
          `/api/workers/fixture-worker/credentials/${f.records.get("rotated").credentialSummary.id}`,
        { ...mutate, status: 204 },
      );
      await visit(
        "revoked credential unauthorized",
        "POST",
        "/api/internal/workers/heartbeat",
        { json: heartbeat, headers: rotated, status: 401, client: "worker" },
      );
      await visit(
        "no active credential rotation",
        "POST",
        "/api/workers/fixture-worker/credentials/rotate",
        { ...mutate, json: {}, status: 409 },
      );
      await visit("re-enrolled", "POST", "/api/internal/workers/enroll", {
        json: (f) => ({
          code: f.records.get("extra pairing code").code,
          heartbeat,
        }),
        status: 201,
        client: "worker",
      });
      await visit(
        "re-enrollment credentials",
        "GET",
        "/api/workers/fixture-worker/credentials",
      );
      if (profile.mode === "none") {
        const developer = {
          authorization: `Bearer ${pair[0].environment.CANTRIP_WORKER_TOKEN}`,
        };
        await visit(
          "development bootstrap policy",
          "POST",
          "/api/internal/workers/heartbeat",
          {
            json: { ...heartbeat, workerId: "development-worker" },
            headers: developer,
            status: profile.standalone ? 401 : 202,
            client: "worker",
          },
        );
        if (!profile.standalone)
          await visit(
            "development worker has no credentials",
            "POST",
            "/api/workers/development-worker/credentials/rotate",
            { ...mutate, json: {}, status: 409 },
          );
      }
      {
        if (profile.name === "development") {
          const expected = await workerHandshakes(pair[0]),
            actual = await workerHandshakes(pair[1]);
          result.handshakes = { reference: expected, actual };
          assert.deepEqual(
            actual,
            expected,
            "Actual HTTP upgrade handshake compatibility",
          );
        }
        if (databaseMode === "postgres" && profile.name === "development") {
          const expected = await workerAuthenticationFaults(pair[0]),
            actual = await workerAuthenticationFaults(pair[1]);
          assert.deepEqual(
            actual,
            expected,
            "Worker authentication database-fault compatibility",
          );
          result.authenticationFaults = actual;
        }
        const expected = await workerSocketFlow(pair[0]),
          actual = await workerSocketFlow(pair[1]);
        assert.deepEqual(
          actual.cases,
          expected.cases,
          "Worker socket control compatibility",
        );
        result.sockets = {
          ...actual,
          referenceBackgroundResourceCommands:
            expected.backgroundResourceCommands,
        };
      }
      await visit("worker audit", "GET", "/api/account/audit-events?limit=200");
      result.passed = true;
    } finally {
      const results = await Promise.allSettled(pair.map((f) => f.close()));
      const errors = results
        .filter((r) => r.status === "rejected")
        .map((r) => r.reason);
      if (errors.length)
        throw new AggregateError(errors, "Worker fixture cleanup");
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
