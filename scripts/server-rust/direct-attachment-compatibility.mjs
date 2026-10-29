import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildRustExample, repositoryRoot } from "./build.mjs";
import * as protocol from "../../packages/protocol/dist/index.js";
import { directAttachmentWireFixtures } from "./direct-attachment-wire-fixtures.mjs";
const reportPath = process.argv.includes("--report")
  ? process.argv[process.argv.indexOf("--report") + 1]
  : undefined;
const report = {
  suite: "actual-direct-attachment-coordinator",
  completeReplacement: false,
  productionLoggingPolicy: process.argv.includes("--policy-logs"),
  cases: [],
  groups: [],
  scope:
    "Native authority vs actual TypeScript coordinator with controlled worker, timers, mutation and observer boundaries; production direct transport acceptance remains required",
};
const now = Date.parse("2026-10-28T00:00:00.000Z");
const input = (extra = {}) => ({
  attachmentId: "attachment",
  authSessionId: "account",
  ownerId: "owner",
  resourceId: "session",
  resourceKind: "worker-link",
  channels: ["worker-link", "worker-link"],
  worker: {
    workerId: "worker",
    online: true,
    directBroker:
      directAttachmentWireFixtures.directAttachmentTicketSchema[0].broker,
  },
  ...extra,
});
const tunnel = (extra = {}) =>
  input({
    resourceId: "tunnel",
    resourceKind: "tunnel",
    channels: ["tunnel-data"],
    tunnelRoute: {
      tunnelId: "tunnel",
      attachmentId: "attachment",
      sourceEndpointId: "client",
      destinationEndpointId: "worker",
      target: { kind: "tcp", host: "127.0.0.1", port: 43124 },
    },
    ...extra,
  });
const auth = (extra = {}) => ({
  ownerId: "owner",
  authSessionId: "account",
  attachmentId: "attachment",
  ...extra,
});
const cap = "@ticket.binding.capabilityId";
const telemetry = (n, extra = {}) => ({
  bytesFromLocal: n,
  bytesToLocal: 2 * n,
  connectionsClosed: n,
  connectionsOpened: 2 * n,
  ...extra,
});
function child(command, args) {
  const process_ = spawn(command, args, {
    cwd: repositoryRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let diagnostics = "",
    failed;
  const replies = [];
  process_.stderr.on(
    "data",
    (v) => (diagnostics = (diagnostics + v).slice(-16000)),
  );
  createInterface({ input: process_.stdout }).on("line", (line) => {
    const reply = replies.shift();
    if (!reply) throw new Error("Unexpected direct fixture output");
    try {
      reply.resolve(JSON.parse(line));
    } catch (cause) {
      reply.reject(cause);
    }
  });
  const exited = new Promise((resolve) =>
    process_.once("exit", (code, signal) => {
      failed = new Error(
        `Direct fixture exit ${code ?? signal}: ${diagnostics}`,
      );
      for (const reply of replies.splice(0)) reply.reject(failed);
      resolve({ code, signal });
    }),
  );
  process_.once("error", (cause) => {
    failed = cause;
    for (const reply of replies.splice(0)) reply.reject(cause);
  });
  return {
    request(value) {
      if (failed) throw failed;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                "Direct fixture request timed out: " + JSON.stringify(value),
              ),
            ),
          15000,
        );
        replies.push({
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        process_.stdin.write(JSON.stringify(value) + "\n");
      });
    },
    async stop() {
      process_.stdin.end();
      let timer;
      try {
        const result = await Promise.race([
          exited,
          new Promise((resolve) => {
            timer = setTimeout(() => {
              process_.kill();
              resolve({ timeout: true });
            }, 3000);
          }),
        ]);
        assert.equal(result.code, 0, diagnostics);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
function normalizer() {
  const ids = new Map(),
    secrets = new Map();
  return function normalize(v, key = "") {
    if (Array.isArray(v)) return v.map((v) => normalize(v));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, v]) => [k, normalize(v, k)]),
      );
    if (typeof v !== "string") return v;
    if (key === "secret") {
      assert.match(v, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(Buffer.from(v, "base64url").length, 32);
      if (!secrets.has(v)) secrets.set(v, `<secret:${secrets.size}>`);
      return secrets.get(v);
    }
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        v,
      ) &&
      v !== "55555555-5555-4555-8555-555555555555"
    ) {
      if (!ids.has(v)) ids.set(v, `<uuid:${ids.size}>`);
      return ids.get(v);
    }
    return v;
  };
}
const executable = await buildRustExample("direct-attachment-fixture");
async function group(name, run, options = {}) {
  const pair = [
    child(process.execPath, [
      "--import",
      "tsx",
      "scripts/server-rust/direct-attachment-node-fixture.mjs",
    ]),
    child(executable, []),
  ];
  const normalize = pair.map(normalizer),
    tickets = pair.map(() => []);
  let last;
  const request = async (label, value) => {
    const raw = await Promise.all(pair.map((c) => c.request(value)));
    raw.forEach((v) =>
      assert.equal(v?.driverError, undefined, label + ": " + v?.driverError),
    );
    for (let i = 0; i < 2; i++)
      if (value.request?.method === "prepare" && raw[i]?.ok) {
        protocol.directAttachmentTicketSchema.parse(raw[i].ok);
        tickets[i].push(raw[i].ok);
      }
    const values = raw.map((v, i) => normalize[i](v));
    last = raw;
    if (!isDeepStrictEqual(values[1], values[0])) {
      report.mismatch = {
        group: name,
        label,
        request: value,
        node: values[0],
        rust: values[1],
      };
      throw new Error(`Direct attachment mismatch: ${name}/${label}`);
    }
    report.cases.push({ group: name, label, outcome: values[0] });
    return raw[0];
  };
  const call = (label, request_) =>
    request(label, { op: "call", request: request_ });
  const start = (label, request_) =>
    request("start " + label, { op: "start", name: label, request: request_ });
  const join = (label) => request("join " + label, { op: "join", name: label });
  const behavior = (type, value) =>
    request("behavior " + type, { op: "behavior", type, value });
  const release = (type, value = null) =>
    request("release " + type, { op: "release", type, value });
  const time = (at) => request("time " + at, { op: "time", now: at });
  const snapshot = async (label) => {
    const result = await request(label, { op: "snapshot" });
    for (let i = 0; i < 2; i++) {
      const logs = JSON.stringify(last[i].logs);
      for (const ticket of tickets[i]) {
        assert.ok(!logs.includes(ticket.secret), "secret in direct logs");
        assert.ok(
          !logs.includes(ticket.binding.capabilityId),
          "capability in direct logs",
        );
      }
    }
    return result;
  };
  const held = async (type, count = 1) => {
    // Observe actual admitted requests rather than assuming scheduler progress.
    const deadline = Date.now() + 10000;
    for (;;) {
      const raw = await Promise.all(
        pair.map((c) => c.request({ op: "snapshot" })),
      );
      // A held child callback can become visible before its parent's adjacent
      // synchronous log emission on Rust's executor. Require both the actual
      // hold and the complete, identical trace before inspecting that phase.
      if (
        raw.every((r) => (r.held[type] ?? 0) === count) &&
        isDeepStrictEqual(normalize[1](raw[1]), normalize[0](raw[0]))
      )
        break;
      assert.ok(Date.now() < deadline, "Expected held " + type);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return snapshot("held " + type + " " + count);
  };
  try {
    await request("initialize", {
      op: "init",
      now,
      jitter: 0,
      policyLogger: process.argv.includes("--policy-logs"),
      ...options,
    });
    await run({
      request,
      call,
      start,
      join,
      behavior,
      release,
      time,
      snapshot,
      held,
    });
    await call("close", { method: "close" });
    const trace = await snapshot("final trace");
    report.groups.push({
      name,
      cases: report.cases.filter((c) => c.group === name).length,
      commands: trace.commands.length,
      events: trace.logs.length,
      observers: trace.observers.length,
    });
  } finally {
    for (const c of pair) await c.stop();
  }
}
let failure;
try {
  await group(
    "capability authority, activation and telemetry",
    async ({ call, time, snapshot }) => {
      await call("prepare", {
        method: "prepare",
        input: input(),
        save: "ticket",
      });
      for (const authorization of [
        auth({ ownerId: "other" }),
        auth({ authSessionId: "other" }),
        auth({ attachmentId: "other" }),
      ])
        assert.deepEqual(
          await call("foreign activation " + JSON.stringify(authorization), {
            method: "activate",
            capability: cap,
            authorization,
            outcome: "completed",
          }),
          { ok: false },
        );
      assert.deepEqual(
        await call("matching ticket", {
          method: "matches",
          capability: cap,
          authorization: auth(),
        }),
        { ok: true },
      );
      assert.deepEqual(
        await call("generic is not a tunnel", {
          method: "tunnelLease",
          capability: cap,
          authorization: auth(),
        }),
        { ok: null },
      );
      assert.deepEqual(
        await call("inactive renewal", {
          method: "renew",
          capability: cap,
          authorization: auth(),
        }),
        { ok: { status: "not-active" } },
      );
      await call("rejected activation retains authority", {
        method: "activate",
        capability: cap,
        authorization: auth(),
        outcome: "attachment_stale",
      });
      await call("activate", {
        method: "activate",
        capability: cap,
        authorization: auth(),
        outcome: "completed",
      });
      await call("activate twice", {
        method: "activate",
        capability: cap,
        authorization: auth(),
        outcome: "completed",
      });
      for (const n of [0, 10, 5, 10, 15])
        await call("monotonic telemetry " + n, {
          method: "telemetry",
          capability: cap,
          authorization: auth(),
          input: telemetry(n, {
            lastDestinationRejectionCode: "target-rejected",
          }),
        });
      for (const step of [10000, 20000, 30000]) {
        await time(now + step);
        assert.equal(
          (
            await call("renew at " + step, {
              method: "renew",
              capability: cap,
              authorization: auth(),
            })
          ).ok.renewed,
          true,
        );
      }
      await call("foreign revoke", {
        method: "revoke",
        capability: cap,
        authorization: auth({ ownerId: "other" }),
        reason: "released",
      });
      await call("revoke", {
        method: "revoke",
        capability: cap,
        reason: "released",
      });
      await call("revoke twice", {
        method: "revoke",
        capability: cap,
        reason: "released",
      });
      assert.deepEqual(
        await call("generic final telemetry absent", {
          method: "finalTelemetry",
          capability: cap,
          authorization: auth(),
          input: telemetry(100),
        }),
        { ok: null },
      );
      await snapshot("no generic lifecycle observers");
    },
  );
  await group(
    "preparation validation and worker failures",
    async ({ request, call, behavior, snapshot }) => {
      await request("disconnect", { op: "connected", value: false });
      await call("offline bridge", { method: "prepare", input: input() });
      await request("connect", { op: "connected", value: true });
      await call("offline summary", {
        method: "prepare",
        input: input({ worker: { ...input().worker, online: false } }),
      });
      await call("missing broker", {
        method: "prepare",
        input: input({
          worker: { ...input().worker, directBroker: { available: false } },
        }),
      });
      await call("expired lease", {
        method: "prepare",
        input: input({ leaseExpiresAt: new Date(now).toISOString() }),
      });
      await call("expired maximum", {
        method: "prepare",
        input: input({ maxLeaseExpiresAt: new Date(now - 1).toISOString() }),
      });
      for (const value of [
        {
          error: "protected material must not be logged",
          code: "opaque-secret-code",
        },
        { error: "transport failed", unavailable: true, code: "ECONNRESET" },
        { response: null },
        {
          response: {
            accepted: false,
            capabilityId: "55555555-5555-4555-8555-555555555555",
          },
        },
        {
          response: {
            accepted: true,
            capabilityId: "55555555-5555-4555-8555-555555555555",
          },
        },
      ]) {
        await behavior("direct.capability.prepare", value);
        await call("failed install " + JSON.stringify(value), {
          method: "prepare",
          input: input(),
        });
      }
      await behavior("direct.capability.prepare", null);
      const invalid = input();
      delete invalid.attachmentId;
      await call("generated attachment and invalid Date fallback", {
        method: "prepare",
        input: {
          ...invalid,
          leaseExpiresAt: "invalid",
          maxLeaseExpiresAt: "invalid",
        },
        save: "ticket",
      });
      await snapshot("validated logs");
    },
  );
  await group(
    "renewal outcomes and fixed-expiry boundary",
    async ({ call, time, behavior }) => {
      await call("prepare long lease", {
        method: "prepare",
        input: input({ leaseExpiresAt: new Date(now + 200000).toISOString() }),
        save: "ticket",
      });
      await call("activate", {
        method: "activate",
        capability: cap,
        authorization: auth(),
        outcome: "completed",
      });
      assert.equal(
        (
          await call("outside renewal window", {
            method: "renew",
            capability: cap,
            authorization: auth(),
          })
        ).ok.renewed,
        false,
      );
      await time(now + 110000);
      assert.equal(
        (
          await call("window cannot shorten", {
            method: "renew",
            capability: cap,
            authorization: auth(),
          })
        ).ok.renewed,
        false,
      );
      await time(now + 150000);
      await call("extension in window", {
        method: "renew",
        capability: cap,
        authorization: auth(),
      });
      await time(now + 210000);
      assert.deepEqual(
        await call("expiry before delayed timer", {
          method: "renew",
          capability: cap,
          authorization: auth(),
        }),
        { ok: { status: "expired" } },
      );
      await time(now);
      await call("legacy", {
        method: "prepare",
        input: input({
          worker: {
            ...input().worker,
            directBroker: {
              ...input().worker.directBroker,
              leaseRenewal: false,
            },
          },
        }),
        save: "ticket",
      });
      await call("legacy activate", {
        method: "activate",
        capability: cap,
        authorization: auth(),
        outcome: "completed",
      });
      assert.deepEqual(
        await call("legacy renewal", {
          method: "renew",
          capability: cap,
          authorization: auth(),
        }),
        { ok: { status: "unsupported" } },
      );
      await call("legacy revoke", {
        method: "revoke",
        capability: cap,
        reason: "released",
      });
      for (const response of [
        { renewed: false },
        { renewed: true, leaseExpiresAt: new Date(now).toISOString() },
        {
          renewed: true,
          leaseExpiresAt: new Date(now + 43200001).toISOString(),
        },
        null,
      ]) {
        await call("prepare rejected renewal", {
          method: "prepare",
          input: input(),
          save: "ticket",
        });
        await call("activate rejected renewal", {
          method: "activate",
          capability: cap,
          authorization: auth(),
          outcome: "completed",
        });
        await time(now + 10000);
        await behavior("direct.capability.renew", { response });
        assert.deepEqual(
          await call("bad renewal ack " + JSON.stringify(response), {
            method: "renew",
            capability: cap,
            authorization: auth(),
          }),
          { ok: { status: "worker-rejected" } },
        );
        await time(now);
      }
    },
  );
  await group(
    "retryable errors retain the valid grant",
    async ({ call, time, behavior }) => {
      await call("prepare", {
        method: "prepare",
        input: input(),
        save: "ticket",
      });
      await call("activate", {
        method: "activate",
        capability: cap,
        authorization: auth(),
        outcome: "completed",
      });
      await time(now + 10000);
      for (const value of [
        { error: "temporarily offline", unavailable: true },
        { error: "Worker command direct.capability.renew timed out." },
        ...[
          "ECONNREFUSED",
          "ECONNRESET",
          "EHOSTUNREACH",
          "ENETUNREACH",
          "ENOTFOUND",
          "EPIPE",
          "ETIMEDOUT",
          "ERR_SOCKET_CLOSED",
        ].map((code) => ({ error: "transport failure", code })),
      ]) {
        await behavior("direct.capability.renew", value);
        assert.deepEqual(
          await call("retryable " + JSON.stringify(value), {
            method: "renew",
            capability: cap,
            authorization: auth(),
          }),
          { ok: { status: "retryable-failure" } },
        );
        assert.deepEqual(
          await call("still matches", {
            method: "matches",
            capability: cap,
            authorization: auth(),
          }),
          { ok: true },
        );
      }
      await behavior("direct.capability.renew", null);
      await call("successful retry", {
        method: "renew",
        capability: cap,
        authorization: auth(),
      });
      await time(now + 20000);
      await behavior("direct.capability.renew", {
        error: "not retryable",
        code: "ERR_INVALID_STATE",
      });
      assert.deepEqual(
        await call("fail closed", {
          method: "renew",
          capability: cap,
          authorization: auth(),
        }),
        { ok: { status: "worker-rejected" } },
      );
    },
  );
  await group(
    "unbound leases, kind fences and serialized resource mutation",
    async ({ call, start, join, behavior, release, held }) => {
      await call("unbound lease", {
        method: "acquire",
        name: "unbound",
        input: input({ resourceId: null }),
      });
      await start("resource", {
        method: "scope",
        scope: "resource",
        owner: "owner",
        kind: "worker-link",
        resource: "session",
        result: "resource mutation",
      });
      assert.deepEqual(
        await call("lease inactive under fence", {
          method: "active",
          lease: "unbound",
        }),
        { ok: false },
      );
      assert.deepEqual(
        await call("cannot bind fenced lease", {
          method: "bind",
          lease: "unbound",
          kind: "worker-link",
          resource: "session",
        }),
        { ok: false },
      );
      assert.deepEqual(
        await call("cannot acquire unbound kind", {
          method: "acquire",
          name: "blocked",
          input: input({ resourceId: null }),
        }),
        { ok: false },
      );
      assert.deepEqual(
        await call("other concrete resource lease", {
          method: "acquire",
          name: "other",
          input: input({ resourceId: "other", attachmentId: "other" }),
        }),
        { ok: true },
      );
      await call("other resource preparation", {
        method: "prepare",
        lease: "other",
        input: input({ resourceId: "other", attachmentId: "other" }),
        save: "other",
      });
      await call("release other", { method: "release", lease: "other" });
      await call("release unbound", { method: "release", lease: "unbound" });
      await join("resource");
      await behavior("mutation", { hold: true });
      await start("first", {
        method: "scope",
        scope: "resource",
        owner: "owner",
        kind: "worker-link",
        resource: "session",
        result: "first",
      });
      await held("mutation");
      await start("second", {
        method: "scope",
        scope: "resource",
        owner: "owner",
        kind: "worker-link",
        resource: "session",
        result: "second",
      });
      assert.deepEqual(
        await call("queued mutation remains fenced", {
          method: "acquire",
          name: "blocked-again",
          input: input(),
        }),
        { ok: false },
      );
      await behavior("mutation", null);
      await release("mutation");
      await join("first");
      await join("second");
      assert.deepEqual(
        await call("lease after mutations", {
          method: "acquire",
          name: "after",
          input: input(),
        }),
        { ok: true },
      );
      await call("release after", { method: "release", lease: "after" });
    },
  );
  await group(
    "late preparation is revoked before resource mutation",
    async ({ call, start, join, behavior, release, held }) => {
      await behavior("direct.capability.prepare", { hold: true });
      await start("prepare", {
        method: "prepare",
        input: input(),
        save: "ticket",
      });
      await held("direct.capability.prepare");
      await start("resource", {
        method: "scope",
        scope: "resource",
        owner: "owner",
        kind: "worker-link",
        resource: "session",
        result: "after revoke",
      });
      assert.deepEqual(
        await call("fenced preparation", {
          method: "acquire",
          name: "blocked",
          input: input(),
        }),
        { ok: false },
      );
      await release("direct.capability.prepare");
      assert.equal(
        (await join("prepare")).error.class,
        "DirectAttachmentUnavailableError",
      );
      await join("resource");
    },
  );
  await group(
    "renewal cannot resurrect revoked authority",
    async ({ call, start, join, time, behavior, release, held }) => {
      await call("prepare", {
        method: "prepare",
        input: tunnel(),
        save: "ticket",
      });
      await call("activate", {
        method: "activate",
        capability: cap,
        authorization: auth(),
        outcome: "completed",
      });
      await time(now + 10000);
      await behavior("direct.capability.renew", { hold: true });
      await start("renew", {
        method: "renew",
        capability: cap,
        authorization: auth(),
      });
      await held("direct.capability.renew");
      await call("resource revocation", {
        method: "scope",
        scope: "resource",
        owner: "owner",
        kind: "tunnel",
        resource: "tunnel",
      });
      await release("direct.capability.renew");
      assert.deepEqual(await join("renew"), { ok: { status: "missing" } });
      assert.deepEqual(
        await call("absent authority", {
          method: "matches",
          capability: cap,
          authorization: auth(),
        }),
        { ok: false },
      );
      for (const n of [10, 100])
        await call("one final report " + n, {
          method: "finalTelemetry",
          capability: cap,
          authorization: auth(),
          input: telemetry(n),
        });
      await time(now + 130001);
      assert.deepEqual(
        await call("retired report expired", {
          method: "finalTelemetry",
          capability: cap,
          authorization: auth(),
          input: telemetry(100),
        }),
        { ok: null },
      );
    },
  );
  await group(
    "session, owner and attachment scope isolation",
    async ({ call, behavior }) => {
      for (const [save, value] of [
        ["ticket", input()],
        [
          "foreign",
          input({
            ownerId: "other",
            attachmentId: "other",
            authSessionId: "other",
          }),
        ],
        [
          "sameOwner",
          input({ attachmentId: "second", authSessionId: "second" }),
        ],
      ])
        await call("prepare " + save, {
          method: "prepare",
          input: value,
          save,
        });
      await call("session revoke", {
        method: "scope",
        scope: "session",
        account: "account",
      });
      assert.deepEqual(
        await call("other session remains", {
          method: "matches",
          capability: "@sameOwner.binding.capabilityId",
          authorization: auth({
            authSessionId: "second",
            attachmentId: "second",
          }),
        }),
        { ok: true },
      );
      await behavior("direct.capability.revoke", {
        error: "offline",
        unavailable: true,
      });
      await call("owner revoke delivery failure", {
        method: "scope",
        scope: "owner",
        owner: "owner",
      });
      assert.deepEqual(
        await call("foreign owner remains", {
          method: "matches",
          capability: "@foreign.binding.capabilityId",
          authorization: auth({
            ownerId: "other",
            authSessionId: "other",
            attachmentId: "other",
          }),
        }),
        { ok: true },
      );
      await call("attachment revoke", {
        method: "scope",
        scope: "attachment",
        attachment: "other",
      });
    },
  );
  await group(
    "offline and actual expiry callbacks",
    async ({ request, call }) => {
      await call("prepare", {
        method: "prepare",
        input: tunnel(),
        save: "ticket",
      });
      await call("telemetry", {
        method: "telemetry",
        capability: cap,
        authorization: auth(),
        input: telemetry(8),
      });
      await call("offline", { method: "offline", worker: "worker" });
      await call("final offline report", {
        method: "finalTelemetry",
        capability: cap,
        authorization: auth(),
        input: telemetry(10),
      });
      await call("prepare expires", {
        method: "prepare",
        input: input(),
        save: "ticket",
      });
      await request("run due timers", { op: "advance", now: now + 60000 });
      assert.deepEqual(
        await call("expired absent", {
          method: "matches",
          capability: cap,
          authorization: auth(),
        }),
        { ok: false },
      );
    },
  );
  await group(
    "shutdown waits for route entry and preparation",
    async ({ call, start, join, behavior, release, held }) => {
      await call("route entry", {
        method: "acquire",
        name: "entry",
        input: input({ resourceId: null }),
      });
      await start("close", { method: "close" });
      assert.deepEqual(
        await call("entry fenced", { method: "active", lease: "entry" }),
        { ok: false },
      );
      await call("release entry", { method: "release", lease: "entry" });
      await join("close");
      await call("closed refuses acquisition", {
        method: "acquire",
        name: "closed",
        input: input(),
      });
    },
  );
  await group(
    "late prepare during shutdown",
    async ({ start, join, behavior, release, held }) => {
      await behavior("direct.capability.prepare", { hold: true });
      await start("prepare", { method: "prepare", input: input() });
      await held("direct.capability.prepare");
      await start("close", { method: "close" });
      await release("direct.capability.prepare");
      assert.equal(
        (await join("prepare")).error.class,
        "DirectAttachmentUnavailableError",
      );
      await join("close");
    },
  );
  await group(
    "renewals serialize without duplicate extension",
    async ({ call, start, join, time, behavior, release, held, snapshot }) => {
      await call("prepare", {
        method: "prepare",
        input: input(),
        save: "ticket",
      });
      await call("activate", {
        method: "activate",
        capability: cap,
        authorization: auth(),
        outcome: "completed",
      });
      await time(now + 10000);
      await behavior("direct.capability.renew", { hold: true });
      await start("first renewal", {
        method: "renew",
        capability: cap,
        authorization: auth(),
      });
      await held("direct.capability.renew");
      await start("second renewal", {
        method: "renew",
        capability: cap,
        authorization: auth(),
      });
      await held("direct.capability.renew");
      await behavior("direct.capability.renew", null);
      await release("direct.capability.renew");
      assert.equal((await join("first renewal")).ok.renewed, true);
      assert.equal((await join("second renewal")).ok.renewed, false);
      assert.equal(
        (await snapshot("one extension command")).commands.filter(
          (c) => c.command.type === "direct.capability.renew",
        ).length,
        1,
      );
    },
  );
  await group(
    "lifecycle persistence is drained and failures are redacted",
    async ({ call, start, join, time, behavior, release, held }) => {
      await call("prepare", {
        method: "prepare",
        input: tunnel(),
        save: "ticket",
      });
      await call("activate", {
        method: "activate",
        capability: cap,
        authorization: auth(),
        outcome: "completed",
      });
      await time(now + 10000);
      await behavior("observer:renewed", { hold: true });
      await behavior("observer:finalized", { hold: true });
      await call("renew without waiting for persistence", {
        method: "renew",
        capability: cap,
        authorization: auth(),
      });
      await held("observer:renewed");
      await start("close", { method: "close" });
      await held("observer:finalized");
      await release("observer:renewed", {
        error: "private persistence details",
        code: "private-code",
      });
      await release("observer:finalized", {
        error: "private persistence details",
        code: "ECONNRESET",
      });
      await join("close");
      assert.deepEqual(
        await call("final telemetry cleared after writes drain", {
          method: "finalTelemetry",
          capability: cap,
          authorization: auth(),
          input: telemetry(2),
        }),
        { ok: null },
      );
    },
  );
  await group(
    "UTF16 identity fences and failed mutations release authority",
    async ({ call, behavior }) => {
      const owner = "a:\ud83e\udd80\ud800",
        resource = "resource:\ud800";
      await call("UTF16 prepare", {
        method: "prepare",
        input: input({ ownerId: owner, resourceId: resource }),
        save: "ticket",
      });
      await call("wrong owner scope", {
        method: "scope",
        scope: "resource",
        owner: "a:\ud83e\udd80\ufffd",
        kind: "worker-link",
        resource,
      });
      assert.deepEqual(
        await call("UTF16 owner remains distinct", {
          method: "matches",
          capability: cap,
          authorization: auth({ ownerId: owner }),
        }),
        { ok: true },
      );
      await behavior("mutation", { error: "controlled mutation failed" });
      assert.equal(
        (
          await call("failed resource mutation", {
            method: "scope",
            scope: "resource",
            owner,
            kind: "worker-link",
            resource,
          })
        ).error.class,
        "Error",
      );
      await behavior("mutation", null);
      assert.deepEqual(
        await call("failed mutation fence released", {
          method: "acquire",
          name: "after",
          input: input({ ownerId: owner, resourceId: resource }),
        }),
        { ok: true },
      );
      await call("release", { method: "release", lease: "after" });
    },
  );
  await group(
    "operational repeat suppression and UTF16 owner keys",
    async ({ call, snapshot, time }) => {
      for (const ownerId of ["owner:\ud800", "owner:�"])
        for (let i = 0; i < 29; i++)
          await call(
            "uncorrelated activation " + JSON.stringify(ownerId) + " " + i,
            {
              method: "activate",
              capability: "missing",
              authorization: auth({
                ownerId,
                attachmentId: "token=private-attachment",
              }),
              outcome: i % 2 ? "capability_mismatch" : "transport_error",
            },
          );
      const trace = await snapshot("operational summaries");
      if (process.argv.includes("--policy-logs")) {
        assert.equal(trace.logs.length, 4);
        assert.deepEqual(
          trace.logs.map((v) => v.context.counts?.repeated ?? 0),
          [0, 25, 0, 25],
        );
        assert.ok(
          trace.logs.every(
            (v) => v.context.attachmentId === "token=[REDACTED]",
          ),
        );
      }
      await time(now + 30000);
      await call("new window emits old summary and new event", {
        method: "activate",
        capability: "missing",
        authorization: auth({ ownerId: "owner:\ud800" }),
        outcome: "capability_mismatch",
      });
    },
  );
} catch (cause) {
  failure = cause;
  report.error = { message: cause.message, stack: cause.stack };
} finally {
  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    suite: report.suite,
    cases: report.cases.length,
    groups: report.groups,
  }),
);
