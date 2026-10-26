// Exercise the actual parsers, validators, responses and process lifetimes.
// Unknown nested fields are intentionally within existing transport byte caps.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { buildRustServer } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { LiveProbe, initialize } from "./live-sockets.mjs";
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
  profiles: [],
};
const array = (depth) => "[".repeat(depth) + "0" + "]".repeat(depth);
const object = (depth) => '{"x":'.repeat(depth) + "null" + "}".repeat(depth);
const http = [];
const add = (name, raw, status = 400, options = {}) =>
  http.push({ name, raw, status, ...options });
for (const depth of [128, 2048, 20000]) {
  add(`unknown array ${depth}`, '{"extra":' + array(depth) + "}", 201);
  add(`unknown object ${depth}`, '{"extra":' + object(depth) + "}", 201);
  add(`root array ${depth}`, array(depth));
  add(`known wrong type ${depth}`, '{"label":' + array(depth) + "}");
  add(`truncated array ${depth}`, '{"extra":' + array(depth).slice(0, -1));
  add(
    `duplicate drops deep ${depth}`,
    '{"extra":' + array(depth) + ',"extra":true}',
    201,
  );
  add(
    `nested poison ${depth}`,
    '{"extra":' +
      "[".repeat(depth) +
      '{"__proto__":{}}' +
      "]".repeat(depth) +
      "}",
  );
}
for (const [name, raw] of [
  ["empty", ""],
  ["whitespace", " \t\r\n"],
  ["truncated object", '{"extra":'],
  ["trailing comma", '{"extra":1,}'],
  ["trailing token", "{} false"],
  ["leading zero", '{"extra":01}'],
  ["bad fraction", '{"extra":1.}'],
  ["bad exponent", '{"extra":1e+}'],
  ["nonfinite literal", '{"extra":NaN}'],
  ["raw control", '{"extra":"\u0000"}'],
  ["bad escape", '{"extra":"\\x00"}'],
  ["bad unicode escape", '{"extra":"\\uD80"}'],
  ["prototype key", '{"__proto__":{}}'],
  ["constructor prototype", '{"extra":{"constructor":{"prototype":{}}}}'],
])
  add(name, raw);
for (const [name, raw] of [
  ["null defaults", "null"],
  ["BOM", "\ufeff{}"],
  [
    "strings and escapes",
    '{"extra":"\\ud800\\udfff\\ud800é😀\\\\\\\"/\\b\\f\\n\\r\\t"}',
  ],
  [
    "numeric overflow",
    '{"extra":[1e999,-1e999,-0,1.7976931348623157e308,5e-324]}',
  ],
  ["duplicate and index keys", '{"9":0,"2":0,"extra":0,"2":1,"4294967295":2}'],
  [
    "constructor without prototype",
    '{"constructor":{},"extra":{"prototype":{}}}',
  ],
])
  add(name, raw, 201);
add(
  "invalid UTF8 replacement",
  Buffer.from([123, 34, 120, 34, 58, 34, 240, 128, 128, 34, 125]),
  201,
);
add("plain text", "{}", 400, { contentType: "text/plain" });
add("unsupported type", "{}", 415, { contentType: "application/xml" });

const websocket = [];
const init = JSON.stringify(initialize());
const ws = (name, raw, code = "invalid-message", extra = {}) =>
  websocket.push({ name, raw, code, ...extra });
for (const depth of [128, 2048, 20000]) {
  ws(
    `unknown array ${depth}`,
    init.slice(0, -1) + ',"extra":' + array(depth) + "}",
  );
  // Keep valid deeply nested objects below the existing 64 KiB Live limit.
  ws(
    `unknown object ${depth}`,
    init.slice(0, -1) + ',"extra":' + object(Math.min(depth, 9000)) + "}",
  );
  ws(`root array ${depth}`, array(depth));
  ws(`truncated array ${depth}`, array(depth).slice(0, -1));
  ws(
    `nested known field ${depth}`,
    init.replace('"name":"Cantrip Live fixture"', '"name":' + array(depth)),
  );
}
for (const [name, raw] of [
  ["empty", ""],
  ["whitespace", " \n"],
  ["trailing token", "{}false"],
  ["trailing comma", '{"type":"initialize",}'],
  ["BOM is not JSON", "\ufeff" + init],
  ["invalid escape", '{"type":"\\uZZZZ"}'],
  ["null", "null"],
  ["string", '"hello"'],
  ["number overflow", "1e999"],
])
  ws(name, raw);
ws("valid initialization", init, null);
ws("lone UTF16 echo", '{"type":"ping","nonce":"\\ud800\\udfff\\ud800"}', null, {
  initialized: true,
});
ws(
  "duplicate properties",
  init.replace(
    '"protocolVersion":1',
    '"protocolVersion":99,"protocolVersion":1',
  ),
  null,
);

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
    const profile = { name, http: [], websocket: [] };
    report.profiles.push(profile);
    let profileFailure;
    try {
      for (const fixture of pair) await fixture.start();
      // Run Live before enrollment mutations: their resource publishers are
      // a separate unfinished domain, and must not contaminate parser cursors.
      if (name === "anonymous")
        for (const test of websocket) {
          const results = [];
          for (const fixture of pair) {
            const probe = await new LiveProbe(fixture).open();
            try {
              if (test.initialized) await probe.initialized();
              probe.socket.send(test.raw);
              const frame = await probe.message();
              assert.equal(
                frame.type,
                test.code ? "error" : test.initialized ? "pong" : "ready",
                test.name,
              );
              if (test.code) {
                assert.equal(frame.code, test.code, test.name);
                await probe.initialized();
              }
              await probe.ping("after-json");
              results.push(fixture.normalize(frame));
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
          });
        }
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
      const results = await Promise.allSettled(
        pair.map((fixture) => fixture.close()),
      );
      const errors = results
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
