import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildRustExample, repositoryRoot } from "./build.mjs";
import * as protocol from "../../packages/protocol/dist/index.js";

const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const reportPath = option("--report");
const report = {
  suite: "actual-worker-link-coordinator",
  completeReplacement: false,
  cases: [],
  workerCommands: [],
  scope:
    "Native and actual TypeScript local authority; HTTP, real-worker transports and Redis acceptance remain required",
};
const now = Date.parse("2026-10-28T00:00:00.000Z");
const constants = {
  serverId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  serverGeneration: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  workerGeneration: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};
const input = (extra = {}) => ({
  ownerId: "owner-a",
  accountSessionId: "account-a",
  clientInstanceId: "client-a",
  workerId: "worker-a",
  ...extra,
});
const limits = {
  maxChannels: 64,
  maxQueuedFrames: 128,
  maxQueuedBytes: 4194304,
  maxBytesPerSecond: 16777216,
};
const configuration = {
  directRoutes: { local: true, lan: true, wan: true },
  relayOnly: false,
  stunUrls: ["stun:stun.cloudflare.com:3478"],
  interfacePolicy: { mode: "default", interfaces: [] },
  vpnPolicy: { defaultRoute: "wan", lanAllowlist: [] },
  negotiationTimeoutMs: 8000,
  upgradeProbeTimeoutMs: 15000,
  maxPeerSessionsPerClient: 4,
  maxPeerSessionsPerWorker: 32,
  invalidHandshakeRatePerMinute: 60,
  laneLimits: Object.fromEntries(
    ["events", "interactive", "stream", "realtime", "bulk"].map((k) => [
      k,
      limits,
    ]),
  ),
};
function start(command, args) {
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "",
    failure;
  const replies = [];
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const reply = replies.shift();
    if (!reply) throw new Error("Unexpected fixture output: " + line);
    try {
      reply.resolve(JSON.parse(line));
    } catch (error) {
      reply.reject(error);
    }
  });
  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => {
      failure = new Error(
        `Coordinator fixture exited ${code ?? signal}: ${stderr.slice(-4000)}`,
      );
      for (const reply of replies.splice(0)) reply.reject(failure);
      resolve({ code, signal });
    }),
  );
  child.once("error", (error) => {
    failure = error;
    for (const reply of replies.splice(0)) reply.reject(error);
  });
  return {
    async request(value) {
      if (failure) throw failure;
      return new Promise((resolve, reject) => {
        replies.push({ resolve, reject });
        child.stdin.write(JSON.stringify(value) + "\n");
      });
    },
    async stop() {
      child.stdin.end();
      const result = await Promise.race([
        exited,
        new Promise((resolve) => {
          const timer = setTimeout(() => {
            child.kill();
            resolve({ timeout: true });
          }, 3000);
          timer.unref();
        }),
      ]);
      assert.equal(result.code, 0, stderr);
    },
  };
}
const executable = await buildRustExample("worker-link-coordinator-fixture");
let group = 0;
async function paired(options, run) {
  const pair = [
    start(process.execPath, [
      "--import",
      "tsx",
      "scripts/server-rust/worker-link-node-fixture.mjs",
    ]),
    start(executable, []),
  ];
  const maps = pair.map(() => new Map()),
    hashes = pair.map(() => new Map()),
    tokens = pair.map(() => new Set());
  const normalize = (v, i, k) => {
    if (k === "token") {
      assert.match(v, /^[A-Za-z0-9_-]{43}$/);
      return "<token>";
    }
    if (k === "tokenHash") {
      assert.match(v, /^[a-f0-9]{64}$/);
      return "<sha256>";
    }
    if (
      typeof v === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        v,
      ) &&
      !Object.values(constants).includes(v)
    ) {
      if (!maps[i].has(v)) maps[i].set(v, `generated-${maps[i].size}`);
      return maps[i].get(v);
    }
    if (Array.isArray(v)) return v.map((v) => normalize(v, i));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, v]) => [k, normalize(v, i, k)]),
      );
    return v;
  };
  const request = async (label, action) => {
    const result = await Promise.all(pair.map((p) => p.request(action)));
    report.cases.push({
      group,
      label,
      action,
      expected: result[0],
      actual: result[1],
    });
    for (let i = 0; i < 2; i++)
      if (result[i]?.value?.token) {
        const grant = result[i].value;
        assert(!tokens[i].has(grant.token), "Unique capability entropy");
        tokens[i].add(grant.token);
        hashes[i].set(
          grant.binding.grantId,
          createHash("sha256").update(grant.token).digest("hex"),
        );
      }
    assert.deepEqual(normalize(result[1], 1), normalize(result[0], 0), label);
    return result;
  };
  const call = async (label, value, rejected = false, save) => {
    const result = await request(label, {
      op: "call",
      call: value,
      ...(save ? { save } : {}),
    });
    assert.equal(result[0].rejected, rejected, label + " reference outcome");
    return result;
  };
  const behavior = (command, value) =>
    request("worker behavior " + command, { op: "behavior", command, value });
  const wait = async (command, count = 1) => {
    const deadline = Date.now() + 5000;
    let observed;
    do {
      observed = await Promise.all(
        pair.map((p) => p.request({ op: "held", command })),
      );
      if (observed.every((n) => n === count)) return;
      await new Promise((r) => setTimeout(r, 5));
    } while (Date.now() < deadline);
    assert.fail(
      "Actual pending acknowledgments: " +
        JSON.stringify({ command, count, observed }),
    );
  };
  const release = (command, value = null) =>
    request("release " + command, { op: "release", command, value });
  const spawn = (name, value) =>
    request("start " + name, { op: "spawn", name, call: value });
  const finish = async (name, rejected = false, save) => {
    const result = await request("finish " + name, {
      op: "await",
      name,
      ...(save ? { save } : {}),
    });
    assert.equal(result[0].rejected, rejected, name + " reference outcome");
    return result;
  };
  let runError;
  try {
    await request("initialize", { op: "init", now, ...constants, ...options });
    await run({ request, call, behavior, wait, release, spawn, finish });
    await request("exact redacted coordinator diagnostics", { op: "logs" });
    const logs = await Promise.all(
      pair.map((p) => p.request({ op: "commands" })),
    );
    for (let i = 0; i < 2; i++)
      for (const command of logs[i]) {
        protocol.workerRequestEnvelopeSchema.parse({
          kind: "request",
          requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          command: command.command,
        });
        if (command.command.type === "worker-link.grant.install") {
          const grant = command.command.grant;
          const hash = hashes[i].get(grant.binding.grantId);
          if (hash)
            assert.equal(
              grant.tokenHash,
              hash,
              "Worker receives the hash of the actual returned capability",
            );
          assert(!Object.hasOwn(grant, "token"));
        }
      }
    report.workerCommands.push({ group, expected: logs[0], actual: logs[1] });
    assert.deepEqual(
      normalize(logs[1], 1),
      normalize(logs[0], 0),
      "Exact ordered worker requests and owner/timeout scopes",
    );
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    const stopped = await Promise.allSettled(pair.map((p) => p.stop()));
    group++;
    if (!runError) {
      const failed = stopped.find((r) => r.status === "rejected");
      if (failed) throw failed.reason;
    }
  }
}
const open = (extra) => ({ method: "open", input: input(extra) });
const grant = (extra = {}) => ({
  method: "issue",
  input: {
    sessionId: "@s.sessionId",
    resourceKind: "terminal",
    resourceId: "terminal-a",
    attachmentId: "attachment-a",
    lanes: ["interactive"],
    operations: ["stream:open", "stream:read", "stream:write"],
    ...extra,
  },
});
const peer = (extra = {}) => ({
  method: "openPeer",
  session: "@s.sessionId",
  route: "lan",
  generation: 1,
  ...extra,
});
const signal = (sequence, sender = "client", extra = {}) => ({
  sessionId: "@s.sessionId",
  peerSessionId: "@p.peerSessionId",
  routeGeneration: 1,
  route: "lan",
  sender,
  signalSequence: sequence,
  signal: { type: "end-of-candidates" },
  ...extra,
});
const mailbox = (extra = {}) => ({
  method: "mailbox",
  session: "@s.sessionId",
  peer: "@p.peerSessionId",
  input: {},
  ...extra,
});
let failure;
try {
  await paired({}, async ({ call, request }) => {
    await call("first session", open(), false, "s");
    await call("identity reuse", open(), false, "same");
    await call(
      "second client",
      open({ clientInstanceId: "client-b" }),
      false,
      "other",
    );
    await call(
      "second worker",
      open({ workerId: "worker-b" }),
      false,
      "worker",
    );
    await call(
      "UTF16 client identity",
      open({ clientInstanceId: "😀:a\ud800" }),
      false,
      "unicode",
    );
    await call("same UTF16 identity", open({ clientInstanceId: "😀:a\ud800" }));
    await call(
      "distinct replacement-character identity",
      open({ clientInstanceId: "😀:a�" }),
    );
    await call("authorized", {
      method: "authorize",
      session: "@s.sessionId",
      owner: "owner-a",
      account: "account-a",
    });
    for (const [owner, account] of [
      ["owner-b", "account-a"],
      ["owner-a", "account-b"],
    ])
      await call("foreign authorization", {
        method: "authorize",
        session: "@s.sessionId",
        owner,
        account,
      });
    await call("grant", grant(), false, "g");
    await call(
      "clamped channel limit",
      grant({ maxChannels: 100 }),
      false,
      "clamped",
    );
    await call("grant renewal", {
      method: "renewGrant",
      session: "@s.sessionId",
      grant: "@g.binding.grantId",
    });
    await call(
      "invalid absolute lifetime",
      grant({ absoluteExpiresAt: "not-a-date" }),
      true,
    );
    await call(
      "elapsed absolute lifetime",
      grant({ absoluteExpiresAt: "2020-01-01T00:00:00.000Z" }),
      true,
    );
    await call(
      "empty operation schema rejection",
      grant({ operations: [] }),
      true,
    );
    await call("attachment revoke", {
      method: "scope",
      scope: "resource",
      owner: "owner-a",
      kind: "terminal",
      resource: "terminal-a",
      attachment: "attachment-a",
    });
    await call(
      "revoked renewal",
      {
        method: "renewGrant",
        session: "@s.sessionId",
        grant: "@g.binding.grantId",
      },
      true,
    );
    await call("missing revoke", {
      method: "revokeGrant",
      session: "@s.sessionId",
      grant: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    });
    await call("session renewal", { method: "renew", session: "@s.sessionId" });
    await call(
      "disabled route",
      { method: "route", session: "@s.sessionId", route: "wan" },
      true,
    );
    await call("relay route", {
      method: "route",
      session: "@s.sessionId",
      route: "relay",
    });
    await call("same route", {
      method: "route",
      session: "@s.sessionId",
      route: "relay",
    });
    await call("offline worker revokes its sessions", {
      method: "offline",
      worker: "worker-a",
    });
    await call("remaining other worker", { method: "stats" });
    await request("worker process generation", {
      op: "generation",
      value: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    });
    await call("new worker generation", open({ workerId: "worker-b" }));
    await call("old worker generation is unavailable", {
      method: "authorize",
      session: "@worker.sessionId",
      owner: "owner-a",
      account: "account-a",
    });
    await call("shutdown", { method: "close" });
    await call("closed open", open(), true);
  });
  await paired(
    { sessionLeaseMs: 100, sessionLifetimeMs: 500 },
    async ({ call, request }) => {
      await call("short session", open(), false, "s");
      await call("short grant", grant({ leaseMs: 10 }), false, "g");
      await request("expire grant exactly", { op: "clock", value: now + 10 });
      await call("grant expiry sweep", { method: "sweep" });
      await call(
        "lease cannot revive missing grant",
        {
          method: "renewGrant",
          session: "@s.sessionId",
          grant: "@g.binding.grantId",
        },
        true,
      );
      await request("session lease boundary", {
        op: "clock",
        value: now + 100,
      });
      await call("authorization excludes expired session", {
        method: "authorize",
        session: "@s.sessionId",
        owner: "owner-a",
        account: "account-a",
      });
      await call("session expiry sweep", { method: "sweep" });
      await call("expiry stats", { method: "stats" });
      await call("shutdown", { method: "close" });
    },
  );
  await paired(
    { configuration },
    async ({ call, request, behavior, wait, release, spawn, finish }) => {
      await call("peer session", open(), false, "s");
      await call("peer policy", { method: "configuration" });
      await call("disabled local peer route", peer({ route: "local" }), true);
      await call("stale peer round", peer({ generation: 2 }), true);
      await behavior("worker-link.peer.install", { hold: true });
      await spawn("peerA", peer());
      await wait("worker-link.peer.install");
      await spawn("peerB", peer());
      await release("worker-link.peer.install");
      await finish("peerA", false, "p");
      await finish("peerB", false, "p2");
      await behavior("worker-link.peer.install", null);
      await behavior("worker-link.peer.signal", { hold: true });
      await spawn("signal0", { method: "signal", input: signal(0) });
      await wait("worker-link.peer.signal");
      await spawn("signal1", { method: "signal", input: signal(1) });
      await release("worker-link.peer.signal");
      await finish("signal0");
      await wait("worker-link.peer.signal");
      await release("worker-link.peer.signal");
      await finish("signal1");
      await behavior("worker-link.peer.signal", null);
      await call(
        "sequence skips fail",
        { method: "signal", input: signal(3) },
        true,
      );
      await call(
        "worker cannot send as client",
        { method: "signal", input: signal(2, "worker") },
        true,
      );
      await behavior("worker-link.peer.signal", {
        response: { accepted: false },
      });
      await call(
        "worker rejection preserves sequence",
        { method: "signal", input: signal(2) },
        true,
      );
      await behavior("worker-link.peer.signal", null);
      await call("retry same client sequence", {
        method: "signal",
        input: signal(2),
      });
      await call("worker signal", {
        method: "notify",
        worker: "worker-a",
        input: {
          type: "worker-link.peer.signal",
          envelope: signal(0, "worker"),
        },
      });
      await call("idempotent worker duplicate", {
        method: "notify",
        worker: "worker-a",
        input: {
          type: "worker-link.peer.signal",
          envelope: signal(0, "worker"),
        },
      });
      const advertisement = {
        sessionId: "@s.sessionId",
        peerSessionId: "@p.peerSessionId",
        routeGeneration: 1,
        route: "lan",
        advertisementSequence: 0,
        candidates: [],
        complete: true,
      };
      await call("worker candidate advertisement", {
        method: "notify",
        worker: "worker-a",
        input: { type: "worker-link.peer.candidates", advertisement },
      });
      await call("mailbox retains raw sequence", mailbox());
      await call(
        "future cursor",
        mailbox({ input: { afterSignalSequence: 1 } }),
        true,
      );
      await call(
        "acknowledge mailbox",
        mailbox({
          input: { afterSignalSequence: 0, afterAdvertisementSequence: 0 },
        }),
      );
      await call("already acknowledged duplicate ignored", {
        method: "notify",
        worker: "worker-a",
        input: {
          type: "worker-link.peer.signal",
          envelope: signal(0, "worker", {
            signal: { type: "answer", sdp: "different" },
          }),
        },
      });
      await call("worker next signal", {
        method: "notify",
        worker: "worker-a",
        input: {
          type: "worker-link.peer.signal",
          envelope: signal(1, "worker"),
        },
      });
      await call("changed queued duplicate revokes peer", {
        method: "notify",
        worker: "worker-a",
        input: {
          type: "worker-link.peer.signal",
          envelope: signal(1, "worker", {
            signal: { type: "answer", sdp: "different" },
          }),
        },
      });
      await call("revoked mailbox", mailbox(), true);
      await call("new peer round", peer(), false, "p");
      await call("peer renewed with session", {
        method: "renew",
        session: "@s.sessionId",
      });
      await call("route change revokes peer", {
        method: "route",
        session: "@s.sessionId",
        route: "relay",
      });
      await call("old peer after route", mailbox(), true);
      await call("shutdown", { method: "close" });
    },
  );
  await paired({}, async ({ call, behavior, wait, release, spawn, finish }) => {
    await behavior("worker-link.session.install", { hold: true });
    await spawn("openingA", open());
    await wait("worker-link.session.install");
    await spawn("openingB", open());
    await call("opening sessions are counted", { method: "stats" });
    await behavior("worker-link.session.revoke", { hold: true });
    await spawn("revoking", {
      method: "scope",
      scope: "owner",
      owner: "owner-a",
    });
    await wait("worker-link.session.revoke");
    await call(
      "owner fence rejects new identity",
      open({ clientInstanceId: "late-client" }),
      true,
    );
    await release("worker-link.session.revoke");
    await finish("revoking");
    await behavior("worker-link.session.revoke", null);
    await release("worker-link.session.install");
    await finish("openingA", true);
    await finish("openingB", true);
    await behavior("worker-link.session.install", null);
    await call("open after fence ends", open(), false, "s");
    await behavior("worker-link.grant.install", { hold: true });
    await spawn("granting", grant());
    await wait("worker-link.grant.install");
    await behavior("worker-link.grant.revoke", { hold: true });
    await spawn("resourceRevoke", {
      method: "scope",
      scope: "resource",
      owner: "owner-a",
      kind: "terminal",
      resource: "terminal-a",
    });
    await wait("worker-link.grant.revoke");
    await call("resource fence rejects replacement grant", grant(), true);
    await release("worker-link.grant.revoke");
    await finish("resourceRevoke");
    await behavior("worker-link.grant.revoke", null);
    await release("worker-link.grant.install");
    await finish("granting", true);
    await behavior("worker-link.grant.install", null);
    await call("no grant after race", { method: "stats" });
    await call("shutdown", { method: "close" });
  });
  await paired({ maxActiveSessions: 2 }, async ({ call }) => {
    await call("limited first", open(), false, "s");
    await call("limited second", open({ clientInstanceId: "other" }));
    await call(
      "limit rejects third",
      open({ clientInstanceId: "third" }),
      true,
    );
    for (let i = 0; i < 128; i++)
      await call("grant capacity " + i, grant({ resourceId: "resource-" + i }));
    await call("grant limit", grant(), true);
    await call("capacity stats", { method: "stats" });
    await call("shutdown", { method: "close" });
  });
  await paired(
    { configuration },
    async ({ call, behavior, wait, release, spawn, finish }) => {
      await behavior("worker-link.identity.resolve", {
        response: {
          serverId: constants.serverId,
          ownerId: "foreign-owner",
          workerId: "worker-a",
          workerProcessGeneration: constants.workerGeneration,
        },
      });
      await call("resolved identity must match owner", open(), true);
      await behavior("worker-link.identity.resolve", null);
      await behavior("worker-link.session.install", {
        response: { accepted: false },
      });
      await call("unacknowledged session is removed", open(), true);
      await call("no failed session state", { method: "stats" });
      await behavior("worker-link.session.install", null);
      await call("replacement installation", open(), false, "s");
      await behavior("worker-link.grant.install", {
        error: "actual controlled worker grant failure",
      });
      await call("failed grant is removed", grant(), true);
      await call("no failed grant state", { method: "stats" });
      await behavior("worker-link.grant.install", null);
      await behavior("worker-link.peer.install", {
        response: { accepted: false },
      });
      await call("unacknowledged peer is removed", peer(), true);
      await behavior("worker-link.peer.install", null);
      await call("new peer after rejection", peer(), false, "p");
      await behavior("worker-link.peer.renew", {
        error: "controlled peer renewal failure",
      });
      await call("session renewal survives rejected peer", {
        method: "renew",
        session: "@s.sessionId",
      });
      await call("failed renewed peer is revoked", mailbox(), true);
      await behavior("worker-link.peer.renew", null);
      await call("grant for renewal race", grant(), false, "g");
      await behavior("worker-link.grant.renew", { hold: true });
      await spawn("renewGrant", {
        method: "renewGrant",
        session: "@s.sessionId",
        grant: "@g.binding.grantId",
      });
      await wait("worker-link.grant.renew");
      await call("revoke while renewal waits", {
        method: "revokeGrant",
        session: "@s.sessionId",
        grant: "@g.binding.grantId",
      });
      await release("worker-link.grant.renew");
      await finish("renewGrant", true);
      await behavior("worker-link.session.renew", { hold: true });
      await spawn("renewSession", { method: "renew", session: "@s.sessionId" });
      await wait("worker-link.session.renew");
      await call("shutdown during renewal", { method: "close" });
      await release("worker-link.session.renew");
      await finish("renewSession", true);
    },
  );
  await paired(
    {
      configuration: {
        ...configuration,
        maxPeerSessionsPerClient: 1,
        maxPeerSessionsPerWorker: 1,
      },
    },
    async ({ call }) => {
      await call("limited peer session", open(), false, "s");
      await call("limited peer", peer(), false, "p");
      await call("same peer does not use another slot", peer());
      await call("client peer capacity", peer({ route: "wan" }), true);
      await call(
        "other client same worker",
        open({ clientInstanceId: "other" }),
        false,
        "other",
      );
      await call(
        "worker peer capacity",
        peer({ session: "@other.sessionId" }),
        true,
      );
      await call(
        "independent worker",
        open({ workerId: "worker-b" }),
        false,
        "worker",
      );
      await call(
        "independent worker peer",
        peer({ session: "@worker.sessionId" }),
      );
      await call("route replacement frees client capacity", {
        method: "route",
        session: "@s.sessionId",
        route: "relay",
      });
      await call("new peer generation", peer({ generation: 2, route: "wan" }));
      await call("shutdown", { method: "close" });
    },
  );
  await paired({ configuration }, async ({ call }) => {
    await call("mailbox byte-limited session", open(), false, "s");
    await call("mailbox byte-limited peer", peer(), false, "p");
    const sdp = "🦀".repeat(130000);
    for (let sequence = 0; sequence < 9; sequence++)
      await call("bounded UTF8 signaling bytes " + sequence, {
        method: "notify",
        worker: "worker-a",
        input: {
          type: "worker-link.peer.signal",
          envelope: signal(sequence, "worker", {
            signal: { type: "answer", sdp },
          }),
        },
      });
    await call("mailbox overflow fails closed", mailbox(), true);
    await call("replacement peer after byte limit", peer(), false, "p");
    await call("skipped worker sequence fails closed", {
      method: "notify",
      worker: "worker-a",
      input: { type: "worker-link.peer.signal", envelope: signal(1, "worker") },
    });
    await call("skipped mailbox unavailable", mailbox(), true);
    await call("client signal-limited peer", peer(), false, "p");
    for (let sequence = 0; sequence <= 256; sequence++)
      await call(
        "bounded client signaling count " + sequence,
        { method: "signal", input: signal(sequence) },
        sequence === 256,
      );
    await call("signal limit revokes peer", mailbox(), true);
    await call("shutdown", { method: "close" });
  });
} catch (error) {
  failure = error;
  report.failure = error.stack;
}
if (reportPath) {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
}
console.log(
  JSON.stringify({
    groups: group,
    cases: report.cases.length,
    commands: report.workerCommands.map((r) => r.actual.length),
    passed: !failure,
  }),
);
if (failure) throw failure;
