// Exercise production HTTP admission and real WebSocket command settlement.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustServer } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { heartbeat } from "./security-fixtures.mjs";
import { SocketProbe } from "./worker-sockets.mjs";

const option = (name) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const databaseMode = option("--database") ?? "pglite";
const reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-command-http-"));
const profiles = [
  {
    name: "account-concurrency",
    environment: { CANTRIP_ACCOUNT_COMMAND_CONCURRENCY: "1" },
    error: "Account worker-command concurrency limit reached.",
  },
  {
    name: "worker-concurrency",
    environment: { CANTRIP_WORKER_COMMAND_CONCURRENCY: "1" },
    error: "Worker command concurrency limit reached.",
  },
  {
    name: "account-response-bytes",
    environment: { CANTRIP_ACCOUNT_RELAY_BYTES_PER_MINUTE: "1048576" },
    error: "Relay bandwidth quota reached. Retry later.",
    oversized: true,
  },
  {
    name: "worker-response-bytes",
    environment: { CANTRIP_WORKER_RELAY_BYTES_PER_MINUTE: "1048576" },
    error: "Relay bandwidth quota reached. Retry later.",
    oversized: true,
  },
  {
    name: "deep-worker-response-bytes",
    environment: { CANTRIP_WORKER_RELAY_BYTES_PER_MINUTE: "1048576" },
    error: "Relay bandwidth quota reached. Retry later.",
    oversized: true,
    deep: true,
  },
];
const report = {
  suite: "actual-worker-command-http-admission",
  databaseMode,
  root,
  completeReplacement: false,
  runtimes: [],
};
let postgresOwner, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ?? (await buildRustServer());
  if (databaseMode !== "pglite")
    postgresOwner = await postgresFixture(path.join(root, "postgres"));
  for (const kind of ["node", "rust"]) {
    const result = { kind, profiles: [] };
    report.runtimes.push(result);
    for (const profile of profiles) {
      const databaseUrl =
        postgresOwner && (kind === "node" || databaseMode === "postgres")
          ? await postgresOwner.database()
          : undefined;
      const fixture = new HttpFixture({
        kind,
        executable,
        root,
        name: profile.name,
        databaseMode,
        environment: {
          CANTRIP_AUTH_MODE: "accounts",
          CANTRIP_REGISTRATION_ENABLED: "true",
          CANTRIP_SESSION_TTL_SECONDS: "3600",
          ...profile.environment,
          ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
          ...(kind === "rust" && databaseMode === "bundled-postgres"
            ? {
                CANTRIP_POSTGRES_BIN_DIR:
                  process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
              }
            : {}),
        },
      });
      const observations = [],
        requests = [];
      const profileResult = { name: profile.name, observations, requests };
      result.profiles.push(profileResult);
      const observe = async (label, method, url, options = {}) => {
        const observation = await fixture.observe(label, method, url, {
          csrf: !["GET", "HEAD"].includes(method),
          ...options,
        });
        observations.push({ label, ...observation });
        return observation;
      };
      const effects =
        "/api/settings/computer-use/workers/fixture-worker/effects";
      let worker, held, first;
      let replyMode = "success";
      let heldResolve;
      const heldRequest = new Promise((resolve) => {
        heldResolve = resolve;
      });
      const respond = (frame, socket, oversized = false) => {
        if (oversized && profile.deep) {
          // This is valid wire JSON below the websocket payload limit. Build
          // its bytes directly so the fixture's own V8 stack is irrelevant.
          const depth = 600000;
          const prefix = JSON.stringify({
            kind: "response",
            requestId: frame.requestId,
            ok: true,
          });
          socket.send(
            prefix.slice(0, -1) +
              ',"result":' +
              "[".repeat(depth) +
              "0" +
              "]".repeat(depth) +
              "}",
          );
          return;
        }
        socket.send(
          JSON.stringify({
            kind: "response",
            requestId: frame.requestId,
            ok: true,
            result: oversized
              ? "x".repeat(2 * 1024 * 1024)
              : {
                  ...frame.command.preferences,
                  state: "running",
                  error: null,
                  native: null,
                },
          }),
        );
      };
      try {
        await fixture.start();
        await observe("register", "POST", "/api/auth/register", {
          json: {
            email: "command-owner@example.test",
            password: "isolated command-budget fixture password",
            displayName: "Command owner",
          },
          csrf: false,
          status: 201,
        });
        await observe(
          "enrollment code",
          "POST",
          "/api/workers/enrollment-codes",
          { json: { label: "Command worker" }, status: 201 },
        );
        await observe("enroll", "POST", "/api/internal/workers/enroll", {
          json: {
            code: fixture.records.get("enrollment code").code,
            heartbeat,
          },
          client: "worker",
          csrf: false,
          status: 201,
        });
        worker = new SocketProbe(fixture, {
          credential: fixture.records.get("enroll").credential,
          onRequest(frame, socket) {
            if (frame.command.type !== "computer-use.effects.sync")
              return false;
            requests.push(frame.command);
            if (replyMode === "hold") {
              assert.equal(
                held,
                undefined,
                "A second command must not cross the active limit",
              );
              held = { frame, socket };
              heldResolve();
            } else respond(frame, socket, replyMode === "oversized");
            return true;
          },
        });
        await worker.open();
        assert.equal((await worker.message()).state, "pending");
        assert.equal((await worker.message()).state, "ready");
        if (profile.oversized) {
          replyMode = "oversized";
          const rejection = await observe(
            "oversized worker response",
            "GET",
            effects,
            { status: 429, ...(profile.deep ? { timeoutMs: 45000 } : {}) },
          );
          assert.deepEqual(rejection.body, { error: profile.error });
          assert.equal(
            requests.length,
            1,
            "The actual response must cross the wire before its byte rejection",
          );
        } else {
          replyMode = "hold";
          first = fixture.observe("held request", "GET", effects);
          // Correlate admission with the actual worker frame. An early HTTP
          // failure must fail this fixture, rather than masquerade as a barrier.
          let timer;
          try {
            await Promise.race([
              heldRequest,
              first.then(() => {
                throw new Error(
                  "Held command completed without its worker reply",
                );
              }),
              new Promise((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error("No held worker command")),
                  10000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
          const rejection = await observe(
            "concurrent request rejected",
            "GET",
            effects,
            { status: 429 },
          );
          assert.deepEqual(rejection.body, { error: profile.error });
          assert.equal(requests.length, 1);
          respond(held.frame, held.socket);
          held = undefined;
          const observation = await first;
          observations.push({
            label: "held request completes",
            ...observation,
          });
          first = undefined;
        }
        replyMode = "success";
        await observe("claim or rejected byte charge released", "GET", effects);
        assert.equal(requests.length, 2);
      } finally {
        if (held) respond(held.frame, held.socket);
        for (const close of [
          () => first,
          () => worker?.close(),
          () => fixture.close(),
        ])
          try {
            await close();
          } catch (error) {
            (report.cleanupErrors ??= []).push(error.stack ?? String(error));
          }
      }
    }
  }
  assert.deepEqual(
    report.runtimes[1].profiles,
    report.runtimes[0].profiles,
    "Actual command HTTP and worker-wire compatibility",
  );
} catch (error) {
  failure = error;
  report.failure = error.stack ?? String(error);
} finally {
  try {
    await postgresOwner?.close();
  } catch (error) {
    (report.cleanupErrors ??= []).push(error.stack ?? String(error));
  }
}
if (reportPath) {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
}
console.log(
  JSON.stringify({
    databaseMode,
    profiles: report.runtimes.map((r) => ({
      kind: r.kind,
      count: r.profiles.length,
      observations: r.profiles.reduce((n, p) => n + p.observations.length, 0),
    })),
    failure: report.failure,
    cleanupErrors: report.cleanupErrors,
  }),
);
if (failure) throw failure;
if (report.cleanupErrors?.length)
  throw new Error("Command HTTP fixture cleanup failed.");
