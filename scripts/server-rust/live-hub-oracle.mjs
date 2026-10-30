// Differential core-hub adapter. HTTP/session/database integration is separate.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { mock } from "node:test";
import { AppLiveHub } from "../../cantrip_server/src/live/hub.ts";
import { appLiveServerMessageSchema } from "../../packages/protocol/dist/index.js";
import { buildRustExample } from "./build.mjs";
import { liveHubCases } from "./live-hub-scenarios.mjs";
const settle = () => new Promise((resolve) => setImmediate(resolve));
class Socket {
  readyState = 1;
  bufferedAmount = 0;
  sent = [];
  closed = null;
  listeners = new Map();
  active = true;
  fail = false;
  on(event, listener) {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }
  close(code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closed = { code, reason };
    for (const listener of this.listeners.get("close") ?? []) listener();
  }
  send(raw) {
    if (this.fail) throw new Error("Controlled socket send failure");
    this.sent.push(appLiveServerMessageSchema.parse(JSON.parse(raw)));
  }
  receive(raw, binary) {
    for (const listener of this.listeners.get("message") ?? [])
      listener(raw, binary);
  }
}
async function reference(input) {
  mock.timers.enable({
    apis: ["setTimeout", "setInterval", "Date"],
    now: 1792886400000,
  });
  const sockets = {},
    controls = {},
    usage = [],
    external = [];
  let externalFail = false;
  const hub = new AppLiveHub({
    epoch: "oracle-epoch",
    ...input.options,
    now: () => Date.now(),
    usageRecorder: {
      record(v) {
        usage.push({
          owner: v.ownerId,
          ingress: v.direction === "ingress",
          bytes: v.bytes,
          notify: v.notifyChange ?? true,
        });
      },
    },
    ...(input.external
      ? {
          async publishExternal(publication) {
            external.push(publication);
            if (externalFail)
              throw new Error("Controlled external publication failure");
          },
        }
      : {}),
  });
  const snapshots = [];
  try {
    for (const op of input.steps) {
      const id = op.socket ?? "one";
      let result = null;
      switch (op.op) {
        case "attach": {
          const socket = (sockets[id] = new Socket());
          hub.attach(socket, {
            ownerId: op.owner ?? "owner-one",
            sessionId: op.session,
            authorizeScope: (scope) =>
              scope.projectId !== "denied" && scope.chatId !== "denied",
            isActive: () => {
              if (socket.active === "error")
                throw new Error("Controlled session lookup failure");
              return socket.active;
            },
          });
          break;
        }
        case "frame":
          sockets[id].receive(
            op.raw ?? JSON.stringify(op.message),
            op.binary ?? false,
          );
          break;
        case "ack": {
          const request = sockets[op.requestSocket ?? id].sent.findLast(
            (v) => v.type === "client-control-request",
          );
          assert.ok(request, "Control request must really have been delivered");
          sockets[id].receive(
            JSON.stringify({
              type: "client-control-ack",
              correlationId: request.correlationId,
              status: op.status ?? "applied",
            }),
            false,
          );
          break;
        }
        case "publish":
        case "publish-confirmed":
          try {
            result =
              op.op === "publish"
                ? hub.publish(op.publication)
                : await hub.publishConfirmed(op.publication);
          } catch (e) {
            result = { error: e.message };
          }
          break;
        case "external":
          result = hub.receiveExternal(op.publication);
          break;
        case "external-fail":
          externalFail = op.value;
          break;
        case "active":
          sockets[id].active = op.value;
          break;
        case "buffer":
          sockets[id].bufferedAmount = op.bytes;
          break;
        case "send-fail":
          sockets[id].fail = true;
          break;
        case "closed-state":
          sockets[id].readyState = 3;
          break;
        case "disconnect":
          sockets[id].close(1006, "Controlled network loss");
          break;
        case "revoke-owner":
          result = hub.revokeOwner(op.owner);
          break;
        case "revoke-session":
          result = hub.revokeSession(op.session);
          break;
        case "control":
          controls[op.label] = null;
          void hub
            .requestClientControl(
              op.owner ?? "owner-one",
              op.command,
              op.timeoutMs,
            )
            .then((result) => {
              controls[op.label] = result;
            });
          break;
        case "advance":
          mock.timers.tick(op.ms);
          break;
        case "close":
          hub.close();
          break;
        default:
          throw new Error(`Unknown operation ${op.op}`);
      }
      await settle();
      snapshots.push(
        structuredClone({
          result,
          stats: hub.stats(),
          sockets: Object.fromEntries(
            Object.entries(sockets).map(([k, v]) => [
              k,
              { open: v.readyState === 1, sent: v.sent, closed: v.closed },
            ]),
          ),
          usage,
          external,
          controls,
        }),
      );
    }
    // The native adapter returns JSON over stdio. Apply that same boundary to
    // the reference, including JavaScript's wire representation of -0 as 0.
    return JSON.parse(JSON.stringify(snapshots));
  } finally {
    hub.close();
    mock.timers.reset();
  }
}
function normalize(value) {
  const ids = new Map();
  function visit(v, key) {
    if (Array.isArray(v)) return v.map((v) => visit(v));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, v]) => [k, visit(v, k)]),
      );
    if (
      ["connectionId", "correlationId"].includes(key) &&
      typeof v === "string"
    ) {
      assert.match(
        v,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        "Generated identity must remain UUIDv4",
      );
      if (!ids.has(v)) ids.set(v, `<${key}:${ids.size}>`);
      return ids.get(v);
    }
    return v;
  }
  return visit(value);
}
const binary = await buildRustExample("live-hub-oracle");
const caseOption = process.argv.indexOf("--case");
const cases = liveHubCases().filter(
  (c) => caseOption < 0 || c.name.includes(process.argv[caseOption + 1]),
);
assert.ok(cases.length);
const expected = [];
for (const fixture of cases) expected.push(await reference(fixture));
const child = spawnSync(binary, [], {
  input: cases.map((c) => JSON.stringify(c)).join("\n") + "\n",
  encoding: "utf8",
  maxBuffer: 128 * 1024 * 1024,
  timeout: 60000,
});
if (child.stderr) process.stderr.write(child.stderr);
assert.ifError(child.error);
assert.equal(child.status, 0, "Native oracle process must exit successfully");
const actual = child.stdout
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assert.equal(actual.length, cases.length);
const report = {
  suite: "app-live-core-differential",
  completeReplacement: false,
  scope:
    "Actual hubs with controlled IO, active-session callbacks and clocks; not HTTP or database authorization acceptance",
  cases: [],
};
let failure;
for (let i = 0; i < cases.length; i++) {
  try {
    assert.deepEqual(normalize(actual[i]), normalize(expected[i]));
    report.cases.push({
      name: cases[i].name,
      steps: cases[i].steps.length,
      passed: true,
    });
  } catch (error) {
    report.cases.push({ name: cases[i].name, passed: false });
    failure ??= error;
    report.failure ??= {
      case: cases[i].name,
      actual: actual[i],
      expected: expected[i],
    };
  }
}
const index = process.argv.indexOf("--report");
if (index >= 0) {
  const file = path.resolve(process.argv[index + 1]);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(report, null, 2) + "\n");
}
console.log(
  JSON.stringify(
    {
      suite: report.suite,
      cases: cases.length,
      steps: cases.reduce((n, c) => n + c.steps.length, 0),
      passed: report.cases.filter((c) => c.passed).length,
      firstFailure: report.failure?.case,
    },
    null,
    2,
  ),
);
if (failure) throw failure;
