// Exercise the actual parsers, validators, responses and process lifetimes.
// Unknown nested fields are intentionally within existing transport byte caps.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { buildRustServer } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { LiveProbe } from "./live-sockets.mjs";
import { array, object, http, websocket } from "./json-cases.mjs";
import { LiveCursorObserver } from "./live-cursor-observer.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";

const option = (name) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const databaseMode = option("--database") ?? "pglite";
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(databaseMode));
const executable = await buildRustServer();
const root = await mkdtemp(path.join(tmpdir(), "cantrip-json-http-"));
const report = {
  suite: "json-http-websocket",
  databaseMode,
  completeReplacement: false,
  cursorScope:
    "Ready and pong cursors are verified against actual retained usage publications per process. Raw cursors and events remain in the report. Usage accounting itself remains an unfinished server domain.",
  profiles: [],
};

let postgresOwner, failure;
try {
  if (databaseMode !== "pglite")
    postgresOwner = await postgresFixture(path.join(root, "postgres"));
  const password = "JSON fixture \ud800 password";
  const passwordHash = await hashPassword(password);
  for (const name of ["anonymous", "password"]) {
    const pair = ["node", "rust"].map(
      (kind) =>
        new HttpFixture({
          kind,
          executable,
          root,
          name,
          databaseMode,
          environment: {
            CANTRIP_AUTH_MODE: name === "anonymous" ? "none" : "password",
            ...(name === "anonymous"
              ? { CANTRIP_BANDWIDTH_USAGE_FLUSH_THRESHOLD_BYTES: "1024" }
              : {}),
            ...(name === "password"
              ? { CANTRIP_PASSWORD_HASH: passwordHash }
              : {}),
          },
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
    const profile = { name, http: [], websocket: [], cursorObservers: {} };
    report.profiles.push(profile);
    let profileFailure;
    const observers = new Map();
    try {
      for (const fixture of pair) await fixture.start();
      if (name === "anonymous")
        for (const fixture of pair) {
          const observer = new LiveCursorObserver(fixture);
          observers.set(fixture.kind, observer);
          await observer.open();
        }
      // Run Live before enrollment mutations: their resource publishers are
      // a separate unfinished domain, and must not contaminate parser cursors.
      if (name === "anonymous")
        for (const test of websocket) {
          const results = [];
          const cursorEvidence = {};
          for (const fixture of pair) {
            const observer = observers.get(fixture.kind);
            const evidence = (cursorEvidence[fixture.kind] = []);
            const probe = await new LiveProbe(fixture).open();
            try {
              if (test.initialized)
                evidence.push(await observer.initialized(probe));
              const minimum = observer.beforeSend();
              probe.socket.send(test.raw);
              const frame = await probe.message();
              let comparable = frame;
              assert.equal(
                frame.type,
                test.code ? "error" : test.initialized ? "pong" : "ready",
                test.name,
              );
              if (test.code) {
                assert.equal(frame.code, test.code, test.name);
                evidence.push(await observer.initialized(probe));
              }
              if (frame.type === "ready" || frame.type === "pong") {
                const accounting = await observer.verifyFrame(frame, minimum);
                evidence.push(accounting);
                comparable = {
                  ...frame,
                  [frame.type === "ready" ? "currentCursor" : "cursor"]:
                    accounting.parserPublications,
                };
              }
              const beforePing = observer.beforeSend();
              evidence.push(
                await observer.verifyFrame(
                  await probe.ping("after-json"),
                  beforePing,
                ),
              );
              results.push(fixture.normalize(comparable));
            } finally {
              await probe.close();
            }
            await fixture.observe(test.name + " WS health", "GET", "/healthz");
          }
          assert.deepEqual(results[1], results[0], test.name);
          profile.websocket.push({
            name: test.name,
            bytes: Buffer.byteLength(test.raw),
            response: results[0],
            cursorEvidence,
          });
          if (test.name === "unknown array 2048") {
            // Exercise the original failure deterministically using a real
            // flush and coalesced publication. No clock/publisher is mocked.
            profile.referenceUsagePublication = await observers
              .get("node")
              .waitForPublication();
          }
        }
      for (const [kind, observer] of observers)
        profile.cursorObservers[kind] = await observer.close();
      const cases =
        name === "anonymous"
          ? http
          : [
              {
                name: "UTF16 password",
                raw: JSON.stringify({ password }),
                status: 200,
              },
              {
                name: "unknown deep field",
                raw:
                  '{"password":' +
                  JSON.stringify(password) +
                  ',"extra":' +
                  array(20000) +
                  "}",
                status: 200,
              },
              {
                name: "wrong deep password",
                raw: '{"password":' + array(20000) + "}",
                status: 400,
              },
              {
                name: "deep object password",
                raw: '{"password":' + object(20000) + "}",
                status: 400,
              },
              { name: "root deep array", raw: array(20000), status: 400 },
              { name: "invalid JSON", raw: '{"password":', status: 400 },
              {
                name: "strict unknown surrogate key",
                raw:
                  '{"password":' +
                  JSON.stringify(password) +
                  ',"\\ud800":true}',
                status: 400,
                reauth: true,
              },
              {
                name: "strict deep unknown",
                raw:
                  '{"password":' +
                  JSON.stringify(password) +
                  ',"extra":' +
                  array(20000) +
                  "}",
                status: 400,
                reauth: true,
              },
            ];
      for (const test of cases) {
        const results = [];
        for (const fixture of pair) {
          const route =
            name === "anonymous"
              ? "/api/workers/enrollment-codes"
              : test.reauth
                ? "/api/auth/reauthenticate"
                : "/api/auth/login";
          const response = await fixture.observe(test.name, "POST", route, {
            raw: test.raw,
            status: test.status,
            csrf: test.reauth,
            headers: { "content-type": test.contentType ?? "application/json" },
          });
          const health = await fixture.observe(
            test.name + " health",
            "GET",
            "/healthz",
          );
          const timestamp = health.body.timestamp;
          assert.equal(new Date(timestamp).toISOString(), timestamp);
          assert.ok(Math.abs(Date.now() - Date.parse(timestamp)) < 15000);
          health.body.timestamp = "<timestamp>";
          results.push({ response, health });
        }
        assert.deepEqual(results[1], results[0], `${name}/${test.name}`);
        profile.http.push({
          name: test.name,
          bytes: Buffer.byteLength(test.raw),
          ...results[0],
        });
      }
    } catch (error) {
      profileFailure = error;
      throw error;
    } finally {
      const observerResults = await Promise.allSettled(
        [...observers].map(async ([kind, observer]) => {
          profile.cursorObservers[kind] = await observer.close();
        }),
      );
      const results = await Promise.allSettled(
        pair.map((fixture) => fixture.close()),
      );
      const errors = [...observerResults, ...results]
        .filter((r) => r.status === "rejected")
        .map((r) => r.reason);
      if (errors.length) {
        profile.cleanupFailures = errors.map((error) => error.stack);
        if (!profileFailure)
          throw new AggregateError(errors, "JSON fixture cleanup failed");
      }
    }
  }
} catch (error) {
  failure = error;
  report.failure = error.stack;
} finally {
  await postgresOwner?.close();
  const target = option("--report");
  if (target) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(report, null, 2) + "\n");
  }
  if (failure) console.error(`Retained failed JSON fixtures: ${root}`);
  else await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(JSON.stringify(report));
