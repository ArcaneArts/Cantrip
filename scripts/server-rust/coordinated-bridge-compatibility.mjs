import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { rustEnvironment, repositoryRoot } from "./cargo.mjs";
import {
  redisFixture,
  bridgePeer,
  eventually,
} from "./coordinated-fixture-tools.mjs";
import {
  decodeRemoteSurfaceFrame,
  encodeRemoteSurfaceFrame,
  decodeTunnelDataPlaneFrame,
  encodeTunnelDataPlaneFrame,
  decodeWorkerLinkFrame,
  encodeWorkerLinkFrame,
} from "../../packages/protocol/dist/index.js";
import { workerLinkWireFixtures } from "./worker-link-wire-fixtures.mjs";
import { tunnelWireFixtures } from "./tunnel-wire-fixtures.mjs";
import { workerIngressFixtures } from "./worker-wire-fixtures.mjs";
import { workerNotificationSchema } from "../../packages/protocol/dist/index.js";
import { verifyIncomingDeadlines } from "./coordinated-deadline-cases.mjs";
import { verifyRedisInterruption } from "./coordinated-interruption-cases.mjs";
import { verifyBounds } from "./coordinated-bound-cases.mjs";
import { verifyTransportAdapter } from "./coordinated-transport-cases.mjs";
const { values } = parseArgs({
  options: {
    "redis-bin": { type: "string" },
    pair: { type: "string", multiple: true },
    report: { type: "string" },
  },
});
const root = await mkdtemp(path.join(tmpdir(), "cantrip-shared-bridge-"));
const report = {
  suite: "real-redis-coordinated-worker-bridge",
  root,
  completeReplacement: false,
  platform: process.platform,
  architecture: process.arch,
  scope:
    "Production Node/native bridge classes, controlled worker sockets/owner lookups and real private Redis. Not production server startup, SQL, WorkerLink service or App Live integration.",
  cases: [],
};
async function save() {
  if (values.report) {
    await mkdir(path.dirname(path.resolve(values.report)), { recursive: true });
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
  }
}
await save();
const env = await rustEnvironment();
const build = spawn(
  "cargo",
  [
    "build",
    "--locked",
    "--manifest-path",
    "cantrip_server_rs/Cargo.toml",
    "--example",
    "coordinated-bridge-fixture",
  ],
  { cwd: repositoryRoot, env, stdio: "inherit" },
);
await new Promise((resolve, reject) => {
  build.on("error", reject);
  build.on("exit", (code) =>
    code === 0
      ? resolve()
      : reject(new Error(`Bridge fixture build exited ${code}`)),
  );
});
const executable = path.join(
  env.CARGO_TARGET_DIR ?? path.join(repositoryRoot, "cantrip_server_rs/target"),
  env.CARGO_BUILD_TARGET,
  "debug/examples/coordinated-bridge-fixture" +
    (process.platform === "win32" ? ".exe" : ""),
);
const redis = await redisFixture(
  values["redis-bin"] ?? process.env.CANTRIP_TEST_REDIS_BIN ?? "redis-server",
  root,
);
const peers = [];
const continuity = {
  ownerId: "owner",
  credentialId: "credential",
  workerProcessGeneration: "process",
};
const terminalEvent = structuredClone(
  workerIngressFixtures.find((v) => v.event?.type === "terminal.output").event,
);
const notification = workerNotificationSchema.parse(
  workerIngressFixtures.find(
    (v) =>
      v.notification &&
      v.notification.type !== "inference.status" &&
      workerNotificationSchema.safeParse(v.notification).success,
  ).notification,
);
async function event(peer, check, name) {
  const events = await eventually(
    () => peer.drain(),
    (values) => values.some(check),
    name,
  );
  return events.find(check);
}
const outputs = (peer, name) =>
  peer.events.filter((e) => e.kind === "worker-output" && e.peer === name);
const completions = (peer, name) =>
  peer.events.filter((e) => e.kind === "completion" && e.name === name);
async function requested(peer, name, count) {
  await eventually(
    () => peer.drain(),
    () =>
      outputs(peer, name).filter((e) => e.text !== undefined).length >= count,
    "actual worker request",
  );
  return JSON.parse(
    outputs(peer, name).filter((e) => e.text !== undefined)[count - 1].text,
  );
}
async function response(peer, name, request, result = { fixture: true }) {
  await peer.call("receive", {
    peer: name,
    message: {
      kind: "response",
      requestId: request.requestId,
      ok: true,
      result,
    },
  });
}
async function run(pair) {
  const kinds = pair.split("/");
  assert.ok(
    kinds.length === 2 && kinds.every((k) => ["node", "rust"].includes(k)),
  );
  const observation = { pair, steps: [] };
  report.cases.push(observation);
  await save();
  const prefix = "cantrip:relay:v1:bridge:" + randomUUID();
  const a = bridgePeer(
      kinds[0],
      executable,
      root,
      pair.replace("/", "-") + "-a",
    ),
    b = bridgePeer(kinds[1], executable, root, pair.replace("/", "-") + "-b");
  peers.push(a, b);
  const options = (instanceId) => ({
    url: redis.url,
    instanceId,
    keyPrefix: prefix,
    // Keep periodic renewals outside the explicitly paused attachment schedules.
    // Interruption/renewal timers receive separate acceptance scenarios.
    presenceTtlMs: 60000,
    maximumInstances: 4,
  });
  const step = (name) => observation.steps.push(name);
  try {
    await a.call("init", { options: options("a"), graceMs: 1000 });
    await b.call("init", { options: options("b"), graceMs: 1000 });
    for (const p of [a, b]) await p.call("subscribe", { workerId: "worker" });
    assert.equal(
      await b.call("attach", {
        workerId: "worker",
        peer: "first",
        ownerId: "owner",
        continuity,
      }),
      true,
    );
    await eventually(
      () => a.call("connected", { workerId: "worker" }),
      (v) => v === true,
      "remote presence",
    );
    assert.deepEqual(
      await a.call("identity", { workerId: "worker" }),
      continuity,
    );
    await a.call("begin", {
      workerId: "worker",
      name: "success",
      command: { type: "worker.version" },
      options: { ownerId: "owner" },
    });
    const first = await requested(b, "first", 1);
    assert.equal(first.kind, "request");
    assert.equal(first.command.type, "worker.version");
    assert.equal(first.inferenceAdmissionAck, true);
    await response(b, "first", first, { available: true });
    assert.deepEqual(
      (
        await event(
          a,
          (e) => e.kind === "completion" && e.name === "success",
          "remote result",
        )
      ).result,
      { available: true },
    );
    step("real shared request, worker correlation, continuity and response");
    await a.call("begin", {
      workerId: "worker",
      name: "failure",
      command: { type: "worker.version" },
      options: { ownerId: "owner" },
    });
    const failed = await requested(b, "first", 2);
    await b.call("receive", {
      peer: "first",
      message: {
        kind: "response",
        requestId: failed.requestId,
        ok: false,
        error: {
          code: "project-source-unavailable",
          message: "Project source is unavailable.",
        },
      },
    });
    const failure = await event(
      a,
      (e) => e.kind === "completion" && e.name === "failure",
      "remote failure",
    );
    assert.equal(failure.ok, false);
    assert.equal(failure.error.name, "WorkerCommandError");
    assert.equal(failure.error.code, "project-source-unavailable");
    assert.equal(failure.error.operation, "worker.version");
    assert.equal(failure.error.workerId, "worker");
    assert.match(failure.error.requestId, /^[a-f0-9-]{36}$/);
    step("worker failure code, message and outer correlation survive routing");
    await a.call("gateEvent", { name: "ordered" });
    await a.call("begin", {
      workerId: "worker",
      name: "ordered",
      command: { type: "worker.version" },
      options: { ownerId: "owner" },
    });
    const ordered = await requested(b, "first", 3);
    await b.call("receive", {
      peer: "first",
      message: {
        kind: "event",
        requestId: ordered.requestId,
        event: { ...terminalEvent, sequence: 0 },
      },
    });
    await event(
      a,
      (e) => e.kind === "command-event" && e.name === "ordered",
      "event callback begins",
    );
    await b.call("receive", {
      peer: "first",
      message: {
        kind: "event",
        requestId: ordered.requestId,
        event: { ...terminalEvent, sequence: 1 },
      },
    });
    await response(b, "first", ordered);
    await delay(40);
    await a.drain();
    assert.equal(completions(a, "ordered").length, 0);
    assert.equal((await a.call("stats")).activeRequests, 0);
    await a.call("releaseEvent", { name: "ordered" });
    assert.equal(
      (
        await event(
          a,
          (e) => e.kind === "completion" && e.name === "ordered",
          "ordered completion",
        )
      ).ok,
      true,
    );
    assert.deepEqual(
      a.events
        .filter((e) => e.kind === "command-event" && e.name === "ordered")
        .map((e) => e.event.sequence),
      [0, 1],
    );
    step(
      "response removes pending deadline but waits for preceding event callbacks",
    );
    await a.call("begin", {
      workerId: "worker",
      name: "event-failure",
      failEvent: true,
      command: { type: "worker.version" },
      options: { ownerId: "owner" },
    });
    const eventFailed = await requested(b, "first", 4);
    await b.call("receive", {
      peer: "first",
      message: {
        kind: "event",
        requestId: eventFailed.requestId,
        event: { type: "terminal.ready" },
      },
    });
    const eventFailure = await event(
      a,
      (e) => e.kind === "completion" && e.name === "event-failure",
      "event consumer rejection",
    );
    assert.equal(
      eventFailure.error.message,
      "Controlled event handler failed.",
    );
    await response(b, "first", eventFailed);
    step(
      "event-consumer failure rejects once and late worker response stays isolated",
    );
    const surface = {
      protocolVersion: 1,
      surfaceId: "surface",
      attachmentId: "attachment",
      sequence: 1,
      channel: "control",
    };
    const tunnel = structuredClone(
      tunnelWireFixtures.tunnelDataPlaneFrameHeaderSchema[0],
    );
    const link = structuredClone(
      workerLinkWireFixtures.workerLinkFrameHeaderSchema.find(
        (h) => h.kind !== "data",
      ),
    );
    for (const [transport, header, encode, decode, payload] of [
      [
        "surface",
        surface,
        encodeRemoteSurfaceFrame,
        decodeRemoteSurfaceFrame,
        Buffer.from([1, 2]),
      ],
      [
        "tunnel",
        tunnel,
        encodeTunnelDataPlaneFrame,
        decodeTunnelDataPlaneFrame,
        Buffer.alloc(tunnel.kind === "data" ? 1 : 0),
      ],
      [
        "worker-link",
        link,
        encodeWorkerLinkFrame,
        decodeWorkerLinkFrame,
        Buffer.alloc(0),
      ],
    ]) {
      const before = outputs(b, "first").filter(
        (e) => e.bytes !== undefined,
      ).length;
      assert.equal(
        await a.call("sendFrame", {
          workerId: "worker",
          transport,
          header,
          payloadBase64: payload.toString("base64"),
        }),
        true,
      );
      await eventually(
        () => b.drain(),
        () =>
          outputs(b, "first").filter((e) => e.bytes !== undefined).length ===
          before + 1,
        transport + " forwarded",
      );
      const sent = decode(
        Buffer.from(
          outputs(b, "first")
            .filter((e) => e.bytes !== undefined)
            .at(-1).bytes,
          "base64",
        ),
      );
      assert.deepEqual(sent.header, header);
      assert.deepEqual(Buffer.from(sent.payload), payload);
      const returned = { ...header, sequence: header.sequence + 1 };
      await b.call("receive", {
        peer: "first",
        bytes: Buffer.from(encode(returned, payload)).toString("base64"),
      });
      const frame = await event(
        a,
        (e) => e.kind === "frame" && e.transport === transport,
        transport + " fanout",
      );
      assert.deepEqual(frame.header, returned);
      assert.equal(frame.payloadBase64, payload.toString("base64"));
    }
    step(
      "surface, tunnel and WorkerLink opaque binary routing in both directions",
    );
    const rawHeader = { ...link, sequence: 333 };
    const headerBytes = Buffer.from(
      "\n" + JSON.stringify(rawHeader, null, 2) + "\n",
    );
    const raw = Buffer.alloc(8 + headerBytes.length);
    raw.write("CWLK");
    raw.writeUInt32BE(headerBytes.length, 4);
    headerBytes.copy(raw, 8);
    const binaryBefore = outputs(b, "first").filter(
      (e) => e.bytes !== undefined,
    ).length;
    assert.equal(
      await b.call("sendFrame", {
        workerId: "worker",
        transport: "worker-link",
        header: rawHeader,
        payloadBase64: "",
        frameBytes: raw.toString("base64"),
      }),
      true,
    );
    await eventually(
      () => b.drain(),
      () =>
        outputs(b, "first").filter((e) => e.bytes !== undefined).length ===
        binaryBefore + 1,
      "local branded send",
    );
    assert.equal(
      outputs(b, "first")
        .filter((e) => e.bytes !== undefined)
        .at(-1).bytes,
      raw.toString("base64"),
    );
    await b.call("receive", { peer: "first", bytes: raw.toString("base64") });
    assert.equal(
      (
        await event(
          b,
          (e) =>
            e.kind === "frame" &&
            e.transport === "worker-link" &&
            e.header.sequence === 333,
          "local branded delivery",
        )
      ).bytes,
      raw.toString("base64"),
    );
    assert.equal(
      (
        await event(
          a,
          (e) =>
            e.kind === "frame" &&
            e.transport === "worker-link" &&
            e.header.sequence === 333,
          "remote normalized delivery",
        )
      ).bytes,
      Buffer.from(encodeWorkerLinkFrame(rawHeader, Buffer.alloc(0))).toString(
        "base64",
      ),
    );
    step(
      "local WorkerLink frames retain original bytes while remote routing rebuilds normalized frames",
    );
    const claim = await b.call("presence", { workerId: "worker" });
    await a.call("begin", {
      workerId: "worker",
      name: "retained",
      command: { type: "worker.version" },
      options: { ownerId: "owner" },
    });
    const retained = await requested(b, "first", 5);
    await b.call("interrupt", { peer: "first" });
    await delay(50);
    assert.equal(
      await b.call("attach", {
        workerId: "worker",
        peer: "second",
        ownerId: "owner",
        continuity,
      }),
      true,
    );
    assert.equal(
      (await b.call("presence", { workerId: "worker" })).connectionId,
      claim.connectionId,
    );
    await response(b, "first", retained);
    await delay(20);
    await a.drain();
    assert.equal(completions(a, "retained").length, 0);
    await response(b, "second", retained);
    assert.equal(
      (
        await event(
          a,
          (e) => e.kind === "completion" && e.name === "retained",
          "same-generation recovery",
        )
      ).ok,
      true,
    );
    await b.drain();
    assert.equal(
      outputs(b, "second").filter((e) => e.text !== undefined).length,
      0,
    );
    step(
      "same-generation reconnect retains one claim and never replays uncertain input",
    );
    await a.call("begin", {
      workerId: "worker",
      name: "owner-fence",
      command: { type: "worker.version" },
      options: { ownerId: "other-owner" },
    });
    const denied = await event(
      a,
      (e) => e.kind === "completion" && e.name === "owner-fence",
      "tenant fence",
    );
    assert.equal(denied.error.name, "Error");
    assert.equal(denied.error.class, "WorkerUnavailableError");
    step("remote owner mismatch is rejected before dispatch");
    await a.call("begin", {
      workerId: "worker",
      name: "timeout",
      command: { type: "worker.version" },
      options: { ownerId: "owner", timeoutMs: 80 },
    });
    await requested(b, "second", 1);
    const timeout = await event(
      a,
      (e) => e.kind === "completion" && e.name === "timeout",
      "remote deadline",
    );
    assert.equal(timeout.error.code, "worker-command-timeout");
    step("remote deadline expires without a worker acknowledgment");
    await b.call("gateOwner", { workerId: "worker" });
    const lookupCount = b.events.filter(
      (e) => e.kind === "owner-lookup",
    ).length;
    await a.call("begin", {
      workerId: "worker",
      name: "stale-owner",
      command: { type: "worker.version" },
      options: { ownerId: "owner" },
    });
    await eventually(
      () => b.drain(),
      () =>
        b.events.filter((e) => e.kind === "owner-lookup").length > lookupCount,
      "authenticated relay awaits owner",
    );
    assert.equal(
      await b.call("attach", {
        workerId: "worker",
        peer: "third",
        ownerId: "owner",
        continuity,
      }),
      true,
    );
    await b.call("releaseOwner", { workerId: "worker" });
    const stale = await event(
      a,
      (e) => e.kind === "completion" && e.name === "stale-owner",
      "replacement fences auth completion",
    );
    assert.equal(stale.error.name, "Error");
    assert.equal(stale.error.class, "WorkerUnavailableError");
    await b.drain();
    assert.equal(
      outputs(b, "third").filter((e) => e.text !== undefined).length,
      0,
    );
    step(
      "a command authenticated for an old attachment never runs on its replacement",
    );
    await a.call("disconnect", {
      workerId: "worker",
      reason: "revoked",
      code: 1008,
    });
    const closed = await event(
      b,
      (e) => e.kind === "worker-close" && e.peer === "third",
      "remote revocation",
    );
    assert.equal(closed.code, 1008);
    assert.equal(closed.reason, "revoked");
    await eventually(
      () => a.call("connected", { workerId: "worker" }),
      (v) => v === false,
      "remote owner removed",
    );
    step(
      "fenced remote disconnect releases presence and closes the matching socket",
    );
    for (const p of [a, b]) await p.call("subscribe", { workerId: "legacy" });
    assert.equal(
      await b.call("attach", {
        workerId: "legacy",
        peer: "legacy-0",
        ownerId: "owner",
      }),
      true,
    );
    await eventually(
      () => a.call("connected", { workerId: "legacy" }),
      (v) => v === true,
      "legacy presence",
    );
    assert.equal(await a.call("identity", { workerId: "legacy" }), null);
    const legacyClaim = await b.call("presence", { workerId: "legacy" });
    await a.call("begin", {
      workerId: "legacy",
      name: "legacy",
      command: { type: "worker.version" },
      options: { ownerId: "owner" },
    });
    const legacyRequest = await requested(b, "legacy-0", 1);
    await b.call("interrupt", { peer: "legacy-0" });
    assert.equal(
      await b.call("attach", {
        workerId: "legacy",
        peer: "legacy-1",
        ownerId: "owner",
      }),
      true,
    );
    assert.equal(
      (await b.call("presence", { workerId: "legacy" })).connectionId,
      legacyClaim.connectionId,
    );
    await response(b, "legacy-1", legacyRequest, { legacy: true });
    assert.deepEqual(
      (
        await event(
          a,
          (e) => e.kind === "completion" && e.name === "legacy",
          "legacy recovery",
        )
      ).result,
      { legacy: true },
    );
    assert.equal(
      outputs(b, "legacy-1").filter((e) => e.text !== undefined).length,
      0,
    );
    step(
      "legacy sockets that assert no continuity retain the admitted request and one claim",
    );
    for (let index = 2; index <= 4; index++) {
      await b.call("interrupt", { peer: `legacy-${index - 1}` });
      assert.equal(
        await b.call("attach", {
          workerId: "legacy",
          peer: `legacy-${index}`,
          ownerId: "owner",
        }),
        true,
      );
      assert.equal(
        (await b.call("presence", { workerId: "legacy" })).connectionId,
        legacyClaim.connectionId,
      );
    }
    await b.call("receive", {
      peer: "legacy-4",
      message: { kind: "notification", notification },
    });
    const marker = randomUUID();
    await b.call("barrier", { target: "a", name: marker });
    await event(
      a,
      (e) => e.kind === "barrier" && e.name === marker,
      "notification publication barrier",
    );
    const notifications = a.events.filter(
      (e) => e.kind === "notification" && e.workerId === "legacy",
    );
    assert.equal(notifications.length, 1);
    assert.deepEqual(notifications[0].value, notification);
    step(
      "repeated same-generation flaps keep one subscription set and one notification publication",
    );
    if (kinds[0] === "rust") {
      const workerId = "reclaimed-worker";
      await b.call("attach", {
        workerId,
        peer: "reclaimed",
        ownerId: "owner",
        continuity,
      });
      const claim = await b.call("presence", { workerId });
      await a.call("begin", {
        workerId,
        name: "reclaimed",
        command: { type: "worker.version" },
        options: { ownerId: "owner" },
      });
      const request = await requested(b, "reclaimed", 1);
      const replacement = { ...claim, connectionId: randomUUID() };
      const publish = (presence) =>
        redis.client.publish(
          prefix + ":messages",
          JSON.stringify({
            kind: "worker-presence",
            action: "online",
            presence,
            sourceInstanceId: claim.instanceId,
            messageId: randomUUID(),
            createdAt: Date.now(),
            expiresAt: Date.now() + 60000,
          }),
        );
      await publish(replacement);
      const marker = randomUUID();
      await b.call("barrier", { target: "a", name: marker });
      await event(
        a,
        (e) => e.kind === "barrier" && e.name === marker,
        "stale online publication",
      );
      await delay(150);
      await a.drain();
      assert.equal(completions(a, "reclaimed").length, 0);
      await redis.client.set(
        prefix + ":worker:" + workerId,
        JSON.stringify(replacement),
        { PX: 60000 },
      );
      await publish(replacement);
      const ended = await event(
        a,
        (e) => e.kind === "completion" && e.name === "reclaimed",
        "same-instance claim replacement",
      );
      assert.equal(ended.error.class, "WorkerUnavailableError");
      await response(b, "reclaimed", request);
      await a.drain();
      assert.equal(completions(a, "reclaimed").length, 1);
      step(
        "a confirmed replacement claim on the same instance rejects the old request once",
      );
    }
    for (const p of [a, b]) await p.call("subscribe", { workerId: "changed" });
    await b.call("attach", {
      workerId: "changed",
      peer: "changed-old",
      ownerId: "owner",
      continuity,
    });
    await eventually(
      () => a.call("connected", { workerId: "changed" }),
      (v) => v === true,
      "changed-process presence",
    );
    await a.call("begin", {
      workerId: "changed",
      name: "changed",
      command: { type: "worker.version" },
      options: { ownerId: "owner" },
    });
    await requested(b, "changed-old", 1);
    await b.call("attach", {
      workerId: "changed",
      peer: "changed-new",
      ownerId: "owner",
      continuity: { ...continuity, workerProcessGeneration: "another-process" },
    });
    const changedClose = await event(
      b,
      (e) => e.kind === "worker-close" && e.peer === "changed-old",
      "changed-process close",
    );
    assert.equal(changedClose.code, 1008);
    assert.equal(changedClose.reason, "Worker continuity identity changed");
    assert.equal(
      (
        await event(
          a,
          (e) => e.kind === "completion" && e.name === "changed",
          "changed-process pending rejection",
        )
      ).error.class,
      "WorkerUnavailableError",
    );
    await b.drain();
    assert.equal(
      outputs(b, "changed-new").filter((e) => e.text !== undefined).length,
      0,
    );
    step(
      "changed worker process closes the old lifecycle permanently without replay",
    );
    for (const p of [a, b]) await p.call("subscribe", { workerId: "move" });
    await b.call("attach", {
      workerId: "move",
      peer: "move-old",
      ownerId: "owner",
      continuity,
    });
    await eventually(
      () => a.call("connected", { workerId: "move" }),
      (v) => v === true,
      "migrating worker presence",
    );
    await a.call("begin", {
      workerId: "move",
      name: "move-old",
      command: { type: "worker.version" },
      options: { ownerId: "owner" },
    });
    await requested(b, "move-old", 1);
    assert.equal(
      await a.call("attach", {
        workerId: "move",
        peer: "move-new",
        ownerId: "owner",
        continuity,
      }),
      true,
    );
    assert.equal(
      (
        await event(
          b,
          (e) => e.kind === "worker-close" && e.peer === "move-old",
          "newest owner disconnects previous instance",
        )
      ).code,
      1012,
    );
    assert.equal(
      (
        await event(
          a,
          (e) => e.kind === "completion" && e.name === "move-old",
          "old instance cannot complete on replacement",
        )
      ).error.class,
      "WorkerUnavailableError",
    );
    assert.equal(
      (await a.call("presence", { workerId: "move" })).instanceId,
      "a",
    );
    await b.call("begin", {
      workerId: "move",
      name: "move-new",
      command: { type: "worker.version" },
      options: { ownerId: "owner" },
    });
    const newOwnerRequest = await requested(a, "move-new", 1);
    await response(a, "move-new", newOwnerRequest, { moved: true });
    assert.deepEqual(
      (
        await event(
          b,
          (e) => e.kind === "completion" && e.name === "move-new",
          "reverse remote route",
        )
      ).result,
      { moved: true },
    );
    step(
      "newest cross-instance claim wins, old work fails and reverse routing reaches only its new socket",
    );
    const staleWorker = "stale-refresh";
    await b.call("attach", {
      workerId: staleWorker,
      peer: "refresh-base",
      ownerId: "owner",
      continuity,
    });
    const refreshClaim = await b.call("presence", { workerId: staleWorker });
    await b.call("gateCoord", {
      operation: "refreshWorker",
      workerId: staleWorker,
      once: true,
    });
    const staleAttach = b.call("attach", {
      workerId: staleWorker,
      peer: "refresh-stale",
      ownerId: "owner",
      continuity,
    });
    staleAttach.catch(() => {});
    await event(
      b,
      (e) =>
        e.kind === "coordination-paused" &&
        e.operation === "refreshWorker" &&
        e.workerId === staleWorker,
      "older attachment awaits refresh",
    );
    assert.equal(
      await b.call("attach", {
        workerId: staleWorker,
        peer: "refresh-current",
        ownerId: "owner",
        continuity,
      }),
      true,
    );
    await b.call("releaseCoord", {
      operation: "refreshWorker",
      workerId: staleWorker,
    });
    assert.equal(await staleAttach, false);
    const superseded = await event(
      b,
      (e) => e.kind === "worker-close" && e.peer === "refresh-stale",
      "superseded refresh closes only its candidate",
    );
    assert.equal(superseded.code, 1012);
    assert.equal(superseded.reason, "Worker connection was superseded");
    assert.equal(
      (await b.call("presence", { workerId: staleWorker })).connectionId,
      refreshClaim.connectionId,
    );
    await a.call("begin", {
      workerId: staleWorker,
      name: "refresh-current",
      command: { type: "worker.version" },
      options: { ownerId: "owner" },
    });
    const afterRefresh = await requested(b, "refresh-current", 1);
    await response(b, "refresh-current", afterRefresh, { current: true });
    assert.deepEqual(
      (
        await event(
          a,
          (e) => e.kind === "completion" && e.name === "refresh-current",
          "current socket survives stale refresh",
        )
      ).result,
      { current: true },
    );
    step(
      "an older refresh completion cannot replace the newest same-generation socket",
    );
    const deadWorker = "claim-death";
    await b.call("gateCoord", {
      operation: "claimWorker",
      workerId: deadWorker,
      once: true,
      after: true,
    });
    const deadAttach = b.call("attach", {
      workerId: deadWorker,
      peer: "claim-dead",
      ownerId: "owner",
      continuity,
    });
    deadAttach.catch(() => {});
    await event(
      b,
      (e) =>
        e.kind === "coordination-paused" &&
        e.operation === "claimWorker" &&
        e.workerId === deadWorker,
      "new claim committed before socket activation",
    );
    const oldClaim = JSON.parse(
      await redis.client.get(`${prefix}:worker:${deadWorker}`),
    );
    await b.call("interrupt", { peer: "claim-dead" });
    assert.equal(
      await b.call("attach", {
        workerId: deadWorker,
        peer: "claim-current",
        ownerId: "owner",
        continuity,
      }),
      true,
    );
    const liveClaim = JSON.parse(
      await redis.client.get(`${prefix}:worker:${deadWorker}`),
    );
    assert.notEqual(liveClaim.connectionId, oldClaim.connectionId);
    await b.call("releaseCoord", {
      operation: "claimWorker",
      workerId: deadWorker,
    });
    assert.equal(await deadAttach, false);
    assert.equal(
      JSON.parse(await redis.client.get(`${prefix}:worker:${deadWorker}`))
        .connectionId,
      liveClaim.connectionId,
    );
    await a.call("begin", {
      workerId: deadWorker,
      name: "claim-current",
      command: { type: "worker.version" },
      options: { ownerId: "owner" },
    });
    const afterClaim = await requested(b, "claim-current", 1);
    await response(b, "claim-current", afterClaim, { current: true });
    assert.deepEqual(
      (
        await event(
          a,
          (e) => e.kind === "completion" && e.name === "claim-current",
          "replacement claim survives dead socket cleanup",
        )
      ).result,
      { current: true },
    );
    step(
      "cleanup after socket loss releases only its exact new claim and preserves a newer Redis owner",
    );
    const graceWorker = "grace-refresh";
    await b.call("attach", {
      workerId: graceWorker,
      peer: "grace-base",
      ownerId: "owner",
      continuity,
    });
    await a.call("begin", {
      workerId: graceWorker,
      name: "grace",
      command: { type: "worker.version" },
      options: { ownerId: "owner" },
    });
    await requested(b, "grace-base", 1);
    const interruptedAt = performance.now();
    await b.call("interrupt", { peer: "grace-base" });
    await delay(500);
    await b.call("gateCoord", {
      operation: "refreshWorker",
      workerId: graceWorker,
      once: true,
    });
    const dyingAttach = b.call("attach", {
      workerId: graceWorker,
      peer: "grace-dead",
      ownerId: "owner",
      continuity,
    });
    dyingAttach.catch(() => {});
    await event(
      b,
      (e) =>
        e.kind === "coordination-paused" &&
        e.operation === "refreshWorker" &&
        e.workerId === graceWorker,
      "candidate refresh pauses during existing grace",
    );
    await b.call("interrupt", { peer: "grace-dead" });
    await b.call("releaseCoord", {
      operation: "refreshWorker",
      workerId: graceWorker,
    });
    assert.equal(await dyingAttach, false);
    await delay(100);
    await a.drain();
    assert.equal(completions(a, "grace").length, 0);
    const grace = await event(
      a,
      (e) => e.kind === "completion" && e.name === "grace",
      "original reconnect grace expires",
    );
    assert.equal(grace.error.class, "WorkerUnavailableError");
    observation.graceElapsedMs = performance.now() - interruptedAt;
    assert.ok(
      observation.graceElapsedMs < 1350,
      `Failed reconnect extended original 1000ms grace to ${observation.graceElapsedMs}ms`,
    );
    step(
      "a socket dying during refresh neither terminates admitted work early nor restarts reconnect grace",
    );
    const expiryWorker = "expired-dispatch";
    await b.call("attach", {
      workerId: expiryWorker,
      peer: "expired-peer",
      ownerId: "owner",
      continuity,
    });
    await b.call("gateOwner", { workerId: expiryWorker });
    await a.call("begin", {
      workerId: expiryWorker,
      name: "expired-dispatch",
      command: { type: "worker.version" },
      options: { ownerId: "owner", timeoutMs: 80 },
    });
    await event(
      b,
      (e) => e.kind === "owner-lookup" && e.workerId === expiryWorker,
      "owner authentication waits beyond dispatch freshness",
    );
    const expired = await event(
      a,
      (e) => e.kind === "completion" && e.name === "expired-dispatch",
      "caller deadline while authentication is pending",
    );
    assert.equal(expired.error.code, "worker-command-timeout");
    await delay(30);
    await b.call("releaseOwner", { workerId: expiryWorker });
    await eventually(
      () => b.call("stats"),
      (stats) => stats.activeRequests === 0,
      "expired authenticated request stays undispatched",
    );
    await b.drain();
    assert.equal(
      outputs(b, "expired-peer").filter((e) => e.text !== undefined).length,
      0,
    );
    step(
      "owner lookup completing after absolute dispatch expiry never reaches the worker",
    );
    const offlineWorker = "stale-offline";
    for (const p of [a, b])
      await p.call("subscribe", { workerId: offlineWorker });
    await b.call("attach", {
      workerId: offlineWorker,
      peer: "offline-old",
      ownerId: "owner",
      continuity,
    });
    const offlineOld = await b.call("presence", { workerId: offlineWorker });
    await b.call("attach", {
      workerId: offlineWorker,
      peer: "offline-current",
      ownerId: "owner",
      continuity: {
        ...continuity,
        workerProcessGeneration: "new-offline-generation",
      },
    });
    const offlineCurrent = await b.call("presence", {
      workerId: offlineWorker,
    });
    await eventually(
      () => a.call("presence", { workerId: offlineWorker }),
      (p) => p?.connectionId === offlineCurrent.connectionId,
      "new offline-fence generation is visible",
    );
    await a.call("begin", {
      workerId: offlineWorker,
      name: "stale-offline",
      command: { type: "worker.version" },
      options: { ownerId: "owner" },
    });
    const offlineRequest = await requested(b, "offline-current", 1);
    await a.drain();
    const disconnects = a.events.filter(
      (e) => e.kind === "disconnect" && e.workerId === offlineWorker,
    ).length;
    await redis.client.publish(
      prefix + ":messages",
      JSON.stringify({
        kind: "worker-presence",
        action: "offline",
        presence: offlineOld,
        sourceInstanceId: "delayed-control",
        messageId: randomUUID(),
        createdAt: Date.now(),
        expiresAt: Date.now() + 60000,
      }),
    );
    const offlineBarrier = randomUUID();
    await b.call("barrier", { target: "a", name: offlineBarrier });
    await event(
      a,
      (e) => e.kind === "barrier" && e.name === offlineBarrier,
      "stale offline barrier",
    );
    assert.equal(
      a.events.filter(
        (e) => e.kind === "disconnect" && e.workerId === offlineWorker,
      ).length,
      disconnects,
    );
    assert.equal(completions(a, "stale-offline").length, 0);
    assert.equal(await a.call("connected", { workerId: offlineWorker }), true);
    await response(b, "offline-current", offlineRequest, { retained: true });
    assert.deepEqual(
      (
        await event(
          a,
          (e) => e.kind === "completion" && e.name === "stale-offline",
          "new generation survives stale offline",
        )
      ).result,
      { retained: true },
    );
    step(
      "delayed offline publication cannot disconnect or reject a newer relay generation",
    );
    await verifyIncomingDeadlines({
      receiver: b,
      redis,
      prefix,
      root,
      step,
      requested,
      response,
    });
    await verifyTransportAdapter({
      a,
      b,
      redis,
      prefix,
      step,
      event,
      requested,
      response,
    });
    await verifyBounds({ a, b, redis, prefix, root, step, event });
    await verifyRedisInterruption({
      pair,
      root,
      executable,
      redis,
      step,
      event,
      requested,
      response,
      observation,
    });
    observation.passed = true;
  } catch (error) {
    observation.failure = error.stack;
    observation.failureSnapshots = [];
    for (const peer of [a, b]) {
      try {
        await peer.drain();
        observation.failureSnapshots.push({
          peer: peer.name,
          events: peer.events,
          stats: await peer.call("stats"),
          coordination: await peer.call("coordinationStats"),
        });
      } catch (snapshotError) {
        observation.failureSnapshots.push({
          peer: peer.name,
          error: snapshotError.stack,
        });
      }
    }
    throw error;
  } finally {
    const stops = await Promise.allSettled([a.stop(), b.stop()]);
    observation.shutdown = stops.map((s, index) => ({
      peer: index === 0 ? a.name : b.name,
      passed: s.status === "fulfilled",
      failure: s.status === "rejected" ? s.reason.stack : undefined,
    }));
    await save();
    if (stops.some((s) => s.status === "rejected") && !observation.failure)
      throw stops.find((s) => s.status === "rejected").reason;
  }
}
try {
  for (const pair of values.pair ?? [
    "node/node",
    "node/rust",
    "rust/node",
    "rust/rust",
  ])
    await run(pair);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  for (const peer of peers) await peer.stop().catch(() => {});
  await redis.stop();
  await save();
}
console.log(
  JSON.stringify({
    root,
    cases: report.cases.map((c) => ({
      pair: c.pair,
      steps: c.steps.length,
      passed: c.passed,
      failure: c.failure,
    })),
    passed: report.passed,
    failure: report.failure,
  }),
);
