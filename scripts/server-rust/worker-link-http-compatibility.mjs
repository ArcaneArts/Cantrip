// Actual HTTP upgrades and binary sockets, using the unchanged production
// WorkerConnection with controlled authority acknowledgments. Resource execution,
// direct attachments and shared-server routing have separate acceptance work.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import * as protocol from "../../packages/protocol/dist/worker-link.js";
import {
  accountResourceUsageSchema,
  directAttachmentTicketSchema,
} from "../../packages/protocol/dist/index.js";
import { WorkerConnection } from "../../cantrip_worker/src/transport.ts";
import { saveWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import { buildRustServer } from "./build.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { heartbeat, password } from "./security-fixtures.mjs";
import { workerLinkWireFixtures } from "./worker-link-wire-fixtures.mjs";
import { directAttachmentWireFixtures } from "./direct-attachment-wire-fixtures.mjs";

const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const WebSocket = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("ws");
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-worker-link-http-"));
const report = {
  suite: "worker-link-http-sockets",
  databaseMode,
  completeReplacement: false,
  controlledWorkerCommands: true,
  profiles: [],
};
const origin = "http://127.0.0.1:5173",
  workerId = "links-worker",
  clientId = "fixture-client";
const fixedUuid = "55555555-5555-4555-8555-555555555555";
const frameIdentity = ({
  protocolVersion,
  sessionId,
  routeGeneration,
  effectiveRoute,
  channel,
  lane,
}) => ({
  protocolVersion,
  sessionId,
  routeGeneration,
  effectiveRoute,
  channel,
  lane,
});
async function until(read, check, label) {
  const end = Date.now() + 10000;
  for (;;) {
    const value = await read();
    try {
      check(value);
      return value;
    } catch (cause) {
      if (Date.now() >= end) {
        cause.message = label + ": " + cause.message;
        throw cause;
      }
    }
    await delay(10);
  }
}
class Fixture extends HttpFixture {
  normalize(value, key = "") {
    if (key === "token" && typeof value === "string") {
      assert.match(value, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(Buffer.from(value, "base64url").length, 32);
      const tokens = (this.grantTokens ??= new Map());
      if (!tokens.has(value)) tokens.set(value, `<grant-token:${tokens.size}>`);
      (this.grantHashes ??= new Map()).set(
        createHash("sha256").update(value).digest("hex"),
        tokens.get(value) + ":sha256",
      );
      return tokens.get(value);
    }
    if (key === "tokenHash" && this.grantHashes?.has(value))
      return this.grantHashes.get(value);
    if (key === "tokenHash") {
      assert.match(value, /^[a-f0-9]{64}$/);
      const hashes = (this.unreturnedGrantHashes ??= new Map());
      if (!hashes.has(value))
        hashes.set(value, `<unreturned-grant-hash:${hashes.size}>`);
      return hashes.get(value);
    }
    if (key === "leaseExpiresAt" && typeof value === "string") {
      assert.match(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      assert.ok(Number.isFinite(Date.parse(value)));
      assert.ok(Date.parse(value) <= Date.now() + 120000 + 1000);
      return "<timestamp>";
    }
    if (key === "secret" && typeof value === "string") {
      assert.match(value, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(Buffer.from(value, "base64url").length, 32);
      const secrets = (this.directSecrets ??= new Map());
      if (!secrets.has(value))
        secrets.set(value, `<direct-secret:${secrets.size}>`);
      return secrets.get(value);
    }
    if (key === "absoluteExpiresAt" && typeof value === "string") {
      assert.match(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      assert.ok(
        Date.parse(value) > Date.now() &&
          Date.parse(value) <= Date.now() + 43200000 + 1000,
      );
      return "<absolute-lease-expiry>";
    }
    return super.normalize(value, key);
  }
}
async function socket(fixture, route, options = {}) {
  const cookies = [...fixture.client(options.client).cookies]
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  const ws = new WebSocket(
    fixture.server.origin.replace(/^http/, "ws") + route,
    {
      headers: {
        ...(cookies ? { cookie: cookies } : {}),
        ...(options.origin === null
          ? {}
          : { origin: options.origin ?? origin }),
      },
    },
  );
  const frames = [],
    closed = new Promise((resolve) =>
      ws.once("close", (code, reason) =>
        resolve({ code, reason: reason.toString() }),
      ),
    );
  ws.on("message", (bytes, binary) =>
    frames.push({ bytes: Buffer.from(bytes), binary }),
  );
  const opened = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("WorkerLink socket handshake timed out"));
    }, 10000);
    const finish = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    ws.once("open", () => finish({ status: 101 }));
    ws.on("error", (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    ws.once("unexpected-response", (_request, response) => {
      const chunks = [];
      response.on("data", (bytes) => chunks.push(bytes));
      response.once("end", () => {
        finish({
          status: response.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString()),
        });
        ws.terminate();
      });
    });
  });
  return {
    ws,
    frames,
    closed,
    opened,
    async close() {
      ws.close();
      await closed;
    },
  };
}
let postgres, failure;
try {
  const executable =
    process.env.CANTRIP_RUST_SERVER_BINARY ?? (await buildRustServer());
  if (databaseMode !== "pglite")
    postgres = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "accounts"]) {
    const outputs = [];
    report.profiles.push({ profile, runtimes: outputs });
    for (const kind of ["node", "rust"]) {
      const databaseUrl =
        postgres && (kind === "node" || databaseMode === "postgres")
          ? await postgres.database()
          : undefined;
      const fixture = new Fixture({
        kind,
        executable,
        root,
        name: "links-" + profile,
        databaseMode,
        environment: {
          CANTRIP_AUTH_MODE: profile,
          CANTRIP_REGISTRATION_ENABLED: "true",
          CANTRIP_WORKER_LINK_LAN_ENABLED: "true",
          CANTRIP_BANDWIDTH_USAGE_FLUSH_THRESHOLD_BYTES: "1024",
          CANTRIP_BANDWIDTH_USAGE_FLUSH_INTERVAL_MS: "250",
          ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
          ...(kind === "rust" && databaseMode === "bundled-postgres"
            ? {
                CANTRIP_POSTGRES_BIN_DIR:
                  process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
              }
            : {}),
        },
      });
      const result = {
        kind,
        observations: [],
        sockets: [],
        binary: [],
        commands: [],
        faults: [],
      };
      outputs.push(result);
      let worker,
        connected = false,
        peerInstalled,
        signalOnInstall = false,
        mode = "accept",
        directMode = "accept",
        transportGeneration;
      let heldType,
        heldPromise,
        releaseHeld,
        heldReached = false;
      const hold = (type) => {
        heldType = type;
        heldReached = false;
        heldPromise = new Promise((resolve) => {
          releaseHeld = resolve;
        });
      };
      const abortedPost = async (route, body) => {
        const controller = new AbortController(),
          client = fixture.client();
        const request = fetch(fixture.server.origin + route, {
          method: "POST",
          signal: controller.signal,
          headers: {
            origin,
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
            ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
            cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }).then(
          (response) => ({ status: response.status }),
          (cause) => ({ error: cause.name }),
        );
        await until(
          () => heldReached,
          (value) => assert.equal(value, true),
          "actual worker request held",
        );
        controller.abort();
        assert.deepEqual(await request, { error: "AbortError" });
      };
      const commands = [],
        workerFrames = [],
        sockets = [];
      const visit = async (label, method, route, options = {}) => {
        result.observations.push({
          label,
          ...(await fixture.observe(label, method, route, {
            csrf:
              !["GET", "HEAD"].includes(method) &&
              !!fixture.client(options.client).csrf,
            ...options,
          })),
        });
        return fixture.records.get(label);
      };
      const observeSocket = async (label, route, options, status) => {
        const peer = await socket(fixture, route, options);
        sockets.push(peer);
        assert.equal(peer.opened.status, status, label);
        result.sockets.push({ label, ...peer.opened });
        return peer;
      };
      try {
        await fixture.start();
        if (profile === "accounts") {
          for (const client of ["main", "other"])
            await visit("register " + client, "POST", "/api/auth/register", {
              client,
              status: 201,
              json: {
                email: `link-${client}@example.invalid`,
                displayName: client,
                password,
              },
            });
          await visit(
            "same account second session",
            "POST",
            "/api/auth/login",
            {
              client: "second",
              json: { email: "link-main@example.invalid", password },
            },
          );
        } else await visit("local session", "GET", "/api/auth/session");
        const bootstrap = await visit("bootstrap", "GET", "/api/bootstrap"),
          owner = bootstrap.auth.currentUser.id;
        for (const json of [
          null,
          {},
          [],
          { clientInstanceId: "" },
          { clientInstanceId: "x", extra: true },
        ]) {
          await visit(
            "open body " + JSON.stringify(json),
            "POST",
            "/api/workers/missing/worker-link/sessions",
            {
              json,
              status: protocol.workerLinkSessionOpenRequestSchema.safeParse(
                json,
              ).success
                ? 404
                : 400,
            },
          );
        }
        await visit(
          "missing worker",
          "POST",
          "/api/workers/missing/worker-link/sessions",
          { json: { clientInstanceId: clientId }, status: 404 },
        );
        const code = await visit(
          "code",
          "POST",
          "/api/workers/enrollment-codes",
          { json: {}, status: 201 },
        );
        const enrolled = await visit(
          "enroll",
          "POST",
          "/api/internal/workers/enroll",
          {
            client: "worker",
            json: {
              code: code.code,
              heartbeat: {
                ...heartbeat,
                workerId,
                directBroker:
                  directAttachmentWireFixtures.directAttachmentTicketSchema[0]
                    .broker,
              },
            },
            status: 201,
          },
        );
        await visit(
          "offline worker",
          "POST",
          `/api/workers/${workerId}/worker-link/sessions`,
          { json: { clientInstanceId: clientId }, status: 503 },
        );
        const config = {
          dataDirectory: path.join(root, "links-" + profile, kind, "worker"),
          name: "WorkerLink transport fixture",
          serverUrl: fixture.server.origin,
          enrollmentCode: null,
          replacement: null,
          token: enrolled.credential,
          tokenSource: "persisted",
          workerId,
        };
        saveWorkerCredential({
          credential: config.token,
          dataDirectory: config.dataDirectory,
          serverUrl: config.serverUrl,
          workerId,
        });
        worker = new WorkerConnection(
          config,
          async (command) => {
            if (
              !command.type.startsWith("worker-link.") &&
              !command.type.startsWith("direct.capability.")
            )
              return null;
            commands.push(command);
            if (command.type === heldType) {
              heldType = undefined;
              heldReached = true;
              await heldPromise;
            }
            if (command.type.startsWith("direct.capability.")) {
              if (directMode === "error")
                throw new Error("Controlled direct preparation failure");
              if (command.type === "direct.capability.prepare")
                return {
                  accepted: directMode !== "reject",
                  capabilityId:
                    directMode === "mismatch"
                      ? fixedUuid
                      : command.binding.capabilityId,
                };
              if (command.type === "direct.capability.renew")
                return {
                  renewed: true,
                  leaseExpiresAt: command.leaseExpiresAt,
                };
              return null;
            }
            if (command.type === "worker-link.identity.resolve")
              return {
                serverId: bootstrap.server.id,
                ownerId: owner,
                workerId,
                workerProcessGeneration: fixedUuid,
              };
            if (command.type === "worker-link.peer.install") {
              peerInstalled = command.peerSession;
              if (signalOnInstall)
                assert.equal(
                  worker.sendNotification({
                    type: "worker-link.peer.signal",
                    envelope: {
                      ...workerLinkWireFixtures
                        .workerLinkPeerSignalEnvelopeSchema[0],
                      peerSessionId: peerInstalled.peerSessionId,
                      sessionId: peerInstalled.sessionId,
                      route: peerInstalled.route,
                      routeGeneration: peerInstalled.routeGeneration,
                      sender: "worker",
                      signalSequence: 0,
                    },
                  }),
                  true,
                );
            }
            if (mode === "error")
              throw new Error("Controlled WorkerLink acknowledgment failure");
            return { accepted: mode !== "reject" };
          },
          undefined,
          undefined,
          undefined,
          1000,
          (generation) => {
            connected = true;
            transportGeneration = generation;
          },
          {
            connectionGeneration: fixedUuid,
            handleWorkerLinkFrame(header, payload) {
              workerFrames.push({
                header,
                payload: Buffer.from(payload).toString("base64"),
              });
              if (header.kind === "open")
                assert.equal(
                  worker.sendWorkerLinkFrame(
                    {
                      ...frameIdentity(header),
                      kind: "accept",
                      initialCreditBytes: 65536,
                      sequence: 0,
                    },
                    new Uint8Array(),
                  ),
                  true,
                );
              if (header.kind === "data")
                assert.equal(
                  worker.sendWorkerLinkFrame(
                    { ...header, direction: "worker-to-client", sequence: 1 },
                    payload,
                  ),
                  true,
                );
            },
          },
        );
        worker.start();
        await until(
          () => connected,
          (value) => assert.equal(value, true),
          "worker ready",
        );
        const opened = await visit(
          "open session",
          "POST",
          `/api/workers/${workerId}/worker-link/sessions`,
          { json: { clientInstanceId: clientId }, status: 201 },
        );
        protocol.workerLinkSessionSchema.parse(opened);
        assert.equal(opened.identity.serverGeneration, transportGeneration);
        assert.equal(opened.identity.workerProcessGeneration, fixedUuid);
        assert.equal(
          Date.parse(opened.lease.absoluteExpiresAt) -
            Date.parse(opened.lease.issuedAt),
          43200000,
        );
        assert.equal(
          Date.parse(opened.lease.expiresAt) -
            Date.parse(opened.lease.issuedAt),
          120000,
        );
        const base = `/api/worker-links/${opened.sessionId}`,
          connect =
            base +
            `/connect?clientInstanceId=${clientId}&routeGeneration=${opened.routeGeneration}`;
        assert.equal(
          (
            await visit(
              "reuse session",
              "POST",
              `/api/workers/${workerId}/worker-link/sessions`,
              { json: { clientInstanceId: clientId }, status: 201 },
            )
          ).sessionId,
          opened.sessionId,
        );
        await visit("renew", "POST", base + "/renew");
        for (const json of [
          undefined,
          null,
          {},
          { topics: [] },
          { topics: ["runtime", "runtime"] },
          { topics: ["missing"] },
          { topics: ["runtime"], extra: true },
        ])
          await visit(
            "invalid observation " + JSON.stringify(json),
            "POST",
            base + "/observations/grant",
            { json, status: 400 },
          );
        await visit(
          "missing observation session",
          "POST",
          `/api/worker-links/${fixedUuid}/observations/grant`,
          { json: { topics: ["runtime"] }, status: 404 },
        );
        if (profile === "accounts") {
          for (const client of ["other", "second"])
            await visit(
              "foreign observation " + client,
              "POST",
              base + "/observations/grant",
              { client, json: { topics: ["runtime"] }, status: 404 },
            );
        }
        const observation = await visit(
          "observation grant",
          "POST",
          base + "/observations/grant",
          { json: { topics: ["runtime", "filesystem"] }, status: 201 },
        );
        protocol.workerLinkResourceGrantSchema.parse(observation);
        assert.equal(observation.binding.sessionId, opened.sessionId);
        assert.deepEqual(observation.binding.identity, opened.identity);
        assert.deepEqual(observation.binding.lanes, ["events"]);
        assert.deepEqual(observation.binding.operations, ["events:subscribe"]);
        assert.equal(observation.binding.maxChannels, 1);
        assert.equal(observation.binding.resource.kind, "observations");
        assert.equal(observation.binding.resource.resourceId, workerId);
        const installation = commands.find(
          (c) =>
            c.type === "worker-link.grant.install" &&
            c.grant.binding.grantId === observation.binding.grantId,
        );
        assert.deepEqual(installation.grant.binding, observation.binding);
        assert.deepEqual(installation.grant.observation, {
          subscriptionId: observation.binding.resource.attachmentId,
          topics: ["runtime", "filesystem"],
        });
        assert.equal(
          installation.grant.tokenHash,
          createHash("sha256").update(observation.token).digest("hex"),
        );
        assert.equal(installation.grant.token, undefined);
        await visit(
          "renew observation grant",
          "POST",
          base + `/grants/${observation.binding.grantId}/renew`,
        );
        await visit(
          "release observation grant",
          "DELETE",
          base + `/grants/${observation.binding.grantId}`,
          { status: 204 },
        );
        await visit(
          "repeat observation release",
          "DELETE",
          base + `/grants/${observation.binding.grantId}`,
          { status: 204 },
        );
        mode = "reject";
        await visit(
          "observation installation rejected",
          "POST",
          base + "/observations/grant",
          { json: { topics: ["runtime"] }, status: 409 },
        );
        mode = "error";
        await visit(
          "observation installation failed",
          "POST",
          base + "/observations/grant",
          { json: { topics: ["runtime"] }, status: 502 },
        );
        mode = "accept";
        const unicode = await visit(
          "UTF16 client identity",
          "POST",
          `/api/workers/${workerId}/worker-link/sessions`,
          {
            json: { clientInstanceId: "\ud83e\udd80:a\ud800" },
            status: 201,
          },
        );
        assert.equal(unicode.identity.clientInstanceId, "\ud83e\udd80:a\ud800");
        await visit(
          "UTF16 identity renewal",
          "POST",
          `/api/worker-links/${unicode.sessionId}/renew`,
        );
        hold("worker-link.session.install");
        await abortedPost(`/api/workers/${workerId}/worker-link/sessions`, {
          clientInstanceId: "aborted-install",
        });
        releaseHeld();
        const retained = await visit(
          "retry aborted installation",
          "POST",
          `/api/workers/${workerId}/worker-link/sessions`,
          { json: { clientInstanceId: "aborted-install" }, status: 201 },
        );
        assert.notEqual(retained.sessionId, opened.sessionId);
        assert.equal(
          commands.filter(
            (c) =>
              c.type === "worker-link.session.install" &&
              c.session.identity.clientInstanceId === "aborted-install",
          ).length,
          1,
        );
        result.faults.push({
          label: "caller abort preserves acknowledged installation",
          installations: 1,
        });
        await visit("renew malformed body", "POST", base + "/renew", {
          json: {},
          raw: "{",
          status: 400,
        });
        await visit("bad peer id", "POST", base + "/peers/bad/mailbox", {
          json: {},
          status: 400,
        });
        await visit("bad grant id", "POST", base + "/grants/bad/renew", {
          status: 400,
        });
        await visit(
          "missing grant",
          "POST",
          base + `/grants/${fixedUuid}/renew`,
          { status: 409 },
        );
        await visit(
          "release missing grant",
          "DELETE",
          base + `/grants/${fixedUuid}`,
          { status: 204 },
        );
        for (const peerId of [
          "00000000-0000-0000-0000-000000000000",
          "ffffffff-ffff-ffff-ffff-ffffffffffff",
          "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
          "55555555-5555-9555-8555-555555555555",
        ]) {
          await visit(
            "UUID leaf " + peerId,
            "POST",
            base + `/peers/${peerId}/mailbox`,
            {
              json: {},
              status:
                protocol.workerLinkPeerSessionSchema.shape.peerSessionId.safeParse(
                  peerId,
                ).success
                  ? 409
                  : 400,
            },
          );
        }
        await visit(
          "invalid peer body before missing session",
          "POST",
          "/api/worker-links/missing/peers",
          { json: {}, status: 400 },
        );
        await visit("stale peer route", "POST", base + "/peers", {
          json: { route: "lan", routeGeneration: opened.routeGeneration + 1 },
          status: 409,
        });
        signalOnInstall = true;
        const descriptor = await visit(
          "open peer with early worker signal",
          "POST",
          base + "/peers",
          {
            json: { route: "lan", routeGeneration: opened.routeGeneration },
            status: 201,
          },
        );
        const peer = descriptor.peerSession,
          peerBase = base + `/peers/${peer.peerSessionId}`;
        assert.equal(peer.peerSessionId, peerInstalled.peerSessionId);
        const mailbox = await visit(
          "mailbox early signal",
          "POST",
          peerBase + "/mailbox",
          { json: {} },
        );
        assert.equal(mailbox.signals.length, 1);
        await visit("invalid cursor", "POST", peerBase + "/mailbox", {
          json: { afterSignalSequence: 1 },
          status: 409,
        });
        const signal = {
          ...workerLinkWireFixtures.workerLinkPeerSignalEnvelopeSchema[0],
          sessionId: opened.sessionId,
          peerSessionId: peer.peerSessionId,
          routeGeneration: opened.routeGeneration,
          route: "lan",
          sender: "client",
          signalSequence: 0,
        };
        await visit(
          "mismatched signal authority",
          "POST",
          peerBase + "/signals",
          { json: { signals: [{ ...signal, sender: "worker" }] }, status: 400 },
        );
        await visit("signal batch", "POST", peerBase + "/signals", {
          json: { signals: [signal, { ...signal, signalSequence: 1 }] },
          status: 204,
        });
        await visit("ack mailbox", "POST", peerBase + "/mailbox", {
          json: { afterSignalSequence: 0 },
        });
        await visit("release peer", "DELETE", peerBase, { status: 204 });
        await visit("release peer twice", "DELETE", peerBase, { status: 204 });
        await visit(
          "missing direct probe worker",
          "POST",
          "/api/workers/missing/direct-probe",
          { status: 404 },
        );
        const probe = await visit(
          "direct probe",
          "POST",
          `/api/workers/${workerId}/direct-probe`,
          { status: 201 },
        );
        directAttachmentTicketSchema.parse(probe);
        assert.equal(probe.binding.resourceKind, "probe");
        await visit(
          "inactive probe telemetry",
          "POST",
          `/api/direct-attachments/${probe.binding.capabilityId}/telemetry`,
          {
            json: {
              bytesFromLocal: 0,
              bytesToLocal: 0,
              connectionsOpened: 0,
              connectionsClosed: 0,
            },
            status: 409,
          },
        );
        await visit(
          "release probe",
          "DELETE",
          `/api/direct-attachments/${probe.binding.capabilityId}`,
          { status: 204 },
        );
        await visit(
          "release probe twice",
          "DELETE",
          `/api/direct-attachments/${probe.binding.capabilityId}`,
          { status: 204 },
        );
        await visit(
          "invalid direct telemetry schema throws",
          "POST",
          `/api/direct-attachments/${fixedUuid}/telemetry`,
          { json: {}, status: 500 },
        );
        const direct = await visit(
          "session direct ticket",
          "POST",
          base + "/direct",
          { status: 201 },
        );
        directAttachmentTicketSchema.parse(direct);
        assert.equal(direct.binding.attachmentId, opened.sessionId);
        assert.equal(
          direct.binding.leaseExpiresAt,
          fixture.records.get("renew").lease.expiresAt,
        );
        await visit(
          "wrong direct activation",
          "POST",
          base + "/direct-activate",
          { json: { capabilityId: fixedUuid }, status: 404 },
        );
        await visit("activate direct", "POST", base + "/direct-activate", {
          json: { capabilityId: direct.binding.capabilityId },
          status: 204,
        });
        for (const n of [0, 5, 3])
          await visit(
            "direct telemetry " + n,
            "POST",
            `/api/direct-attachments/${direct.binding.capabilityId}/telemetry`,
            {
              json: {
                bytesFromLocal: n,
                bytesToLocal: n,
                connectionsOpened: n,
                connectionsClosed: n,
              },
              status: 204,
            },
          );
        if (profile === "accounts") {
          await visit(
            "foreign direct probe hidden",
            "POST",
            `/api/workers/${workerId}/direct-probe`,
            { client: "other", status: 404 },
          );
          await visit(
            "foreign direct telemetry hidden",
            "POST",
            `/api/direct-attachments/${direct.binding.capabilityId}/telemetry`,
            {
              client: "other",
              json: {
                bytesFromLocal: 0,
                bytesToLocal: 0,
                connectionsOpened: 0,
                connectionsClosed: 0,
              },
              status: 404,
            },
          );
          await visit(
            "foreign release is idempotent",
            "DELETE",
            `/api/direct-attachments/${direct.binding.capabilityId}`,
            { client: "other", status: 204 },
          );
          await visit(
            "own grant survives foreign release",
            "POST",
            base + "/direct-activate",
            {
              json: { capabilityId: direct.binding.capabilityId },
              status: 204,
            },
          );
        }
        await visit(
          "release direct",
          "DELETE",
          `/api/direct-attachments/${direct.binding.capabilityId}`,
          { status: 204 },
        );
        await visit(
          "released direct cannot activate",
          "POST",
          base + "/direct-activate",
          { json: { capabilityId: direct.binding.capabilityId }, status: 404 },
        );
        for (const [value, status] of [
          ["reject", 409],
          ["error", 409],
          ["mismatch", 500],
        ]) {
          directMode = value;
          await visit(
            "probe worker " + value,
            "POST",
            `/api/workers/${workerId}/direct-probe`,
            { status },
          );
        }
        directMode = "mismatch";
        await visit(
          "session direct mismatch is worker failure",
          "POST",
          base + "/direct",
          { status: 502 },
        );
        directMode = "accept";
        const routeSession = await visit(
          "route session",
          "POST",
          `/api/workers/${workerId}/worker-link/sessions`,
          { json: { clientInstanceId: "route-client" }, status: 201 },
        );
        const routeBase = `/api/worker-links/${routeSession.sessionId}`;
        const routeDirect = await visit(
          "route direct ticket",
          "POST",
          routeBase + "/direct",
          { status: 201 },
        );
        const routeSocket = await observeSocket(
          "route replacement socket",
          routeBase +
            `/connect?clientInstanceId=route-client&routeGeneration=${routeSession.routeGeneration}`,
          {},
          101,
        );
        const route = await visit(
          "replace route",
          "POST",
          routeBase + "/route",
          { json: { preferredRoute: "relay" } },
        );
        assert.equal(route.routeGeneration, routeSession.routeGeneration + 1);
        assert.deepEqual(await routeSocket.closed, {
          code: 1008,
          reason: "WorkerLink session ended",
        });
        await visit(
          "route replacement revoked direct ticket",
          "POST",
          routeBase + "/direct-activate",
          {
            json: { capabilityId: routeDirect.binding.capabilityId },
            status: 404,
          },
        );
        const samples =
          workerLinkWireFixtures.workerLinkTelemetryBatchSchema[0].samples;
        await visit(
          "future telemetry generation",
          "POST",
          routeBase + "/telemetry",
          {
            json: { routeGeneration: route.routeGeneration + 1, samples },
            status: 409,
          },
        );
        await visit(
          "stale telemetry allowed",
          "POST",
          routeBase + "/telemetry",
          {
            json: { routeGeneration: routeSession.routeGeneration, samples },
            status: 204,
          },
        );
        await visit("release session", "DELETE", routeBase, { status: 204 });
        await visit("release session twice", "DELETE", routeBase, {
          status: 204,
        });
        const cleanup = await visit(
          "session for aborted direct preparation",
          "POST",
          `/api/workers/${workerId}/worker-link/sessions`,
          { json: { clientInstanceId: "cleanup-client" }, status: 201 },
        );
        hold("direct.capability.prepare");
        await abortedPost(`/api/worker-links/${cleanup.sessionId}/direct`);
        releaseHeld();
        await visit(
          "release session cleans abandoned ticket",
          "DELETE",
          `/api/worker-links/${cleanup.sessionId}`,
          { status: 204 },
        );
        const orphan = commands.find(
          (c) =>
            c.type === "direct.capability.prepare" &&
            c.binding.resourceId === cleanup.sessionId,
        );
        assert.ok(orphan);
        assert.equal(
          commands.filter(
            (c) =>
              c.type === "direct.capability.revoke" &&
              c.capabilityId === orphan.binding.capabilityId,
          ).length,
          1,
        );
        result.faults.push({
          label: "aborted direct preparation is revoked by session release",
          workerRevocations: 1,
        });
        const observationCleanup = await visit(
          "session for aborted observation installation",
          "POST",
          `/api/workers/${workerId}/worker-link/sessions`,
          {
            json: { clientInstanceId: "observation-cleanup-client" },
            status: 201,
          },
        );
        const observationCleanupBase = `/api/worker-links/${observationCleanup.sessionId}`;
        hold("worker-link.grant.install");
        await abortedPost(observationCleanupBase + "/observations/grant", {
          topics: ["runtime"],
        });
        const abandoned = commands.find(
          (c) =>
            c.type === "worker-link.grant.install" &&
            c.sessionId === observationCleanup.sessionId,
        );
        assert.ok(abandoned);
        await visit(
          "release during aborted observation installation",
          "DELETE",
          observationCleanupBase,
          { status: 204 },
        );
        releaseHeld();
        await until(
          () =>
            commands.filter(
              (c) =>
                c.type === "worker-link.grant.revoke" &&
                c.grantId === abandoned.grant.binding.grantId,
            ),
          (commands) => {
            assert.equal(commands.length, 1);
            assert.ok(
              commands.every(
                (c) =>
                  c.revocation.reason === "released" && c.grantGeneration === 1,
              ),
            );
          },
          "late acknowledged observation grant is compensated",
        );
        await visit(
          "aborted observation authority removed",
          "POST",
          observationCleanupBase + "/renew",
          { status: 404 },
        );
        result.faults.push({
          label:
            "aborted observation installation cannot resurrect a released session",
          grantRevocations: 1,
          sessionRevocations: commands.filter(
            (c) =>
              c.type === "worker-link.session.revoke" &&
              c.sessionId === observationCleanup.sessionId,
          ).length,
        });
        assert.equal(result.faults.at(-1).sessionRevocations, 1);
        await observeSocket("missing origin", connect, { origin: null }, 403);
        await observeSocket(
          "foreign origin",
          connect,
          { origin: "http://foreign.invalid" },
          403,
        );
        await observeSocket(
          "wrong client",
          base + "/connect?clientInstanceId=wrong",
          {},
          404,
        );
        await observeSocket(
          "duplicate client",
          connect + `&clientInstanceId=${clientId}`,
          {},
          404,
        );
        await observeSocket(
          "stale generation before upgrade",
          base + `/connect?clientInstanceId=${clientId}&routeGeneration=0`,
          {},
          409,
        );
        await observeSocket(
          "duplicate generation",
          connect + `&routeGeneration=${opened.routeGeneration}`,
          {},
          409,
        );
        await observeSocket(
          "noncanonical generation",
          base + `/connect?clientInstanceId=${clientId}&routeGeneration=01`,
          {},
          409,
        );
        if (profile === "accounts") {
          await visit("foreign owner renew", "POST", base + "/renew", {
            client: "other",
            status: 404,
          });
          await visit(
            "same owner foreign session renew",
            "POST",
            base + "/renew",
            { client: "second", status: 404 },
          );
          await observeSocket(
            "foreign owner connect",
            connect,
            { client: "other" },
            404,
          );
          await observeSocket(
            "foreign session connect",
            connect,
            { client: "second" },
            404,
          );
        }
        const legacy = await observeSocket(
          "legacy omitted generation",
          base + `/connect?clientInstanceId=${clientId}`,
          {},
          101,
        );
        const relay = await observeSocket("current relay", connect, {}, 101);
        assert.deepEqual(await legacy.closed, {
          code: 1012,
          reason: "WorkerLink relay was replaced",
        });
        const header = {
          ...workerLinkWireFixtures.workerLinkFrameHeaderSchema[0],
          sessionId: opened.sessionId,
          routeGeneration: opened.routeGeneration,
          grant: {
            ...workerLinkWireFixtures.workerLinkFrameHeaderSchema[0].grant,
            binding: {
              ...workerLinkWireFixtures.workerLinkFrameHeaderSchema[0].grant
                .binding,
              identity: opened.identity,
              sessionId: opened.sessionId,
              lease: opened.lease,
            },
          },
        };
        relay.ws.send(protocol.encodeWorkerLinkFrame(header, new Uint8Array()));
        await until(
          () => relay.frames.length,
          (n) => assert.equal(n, 1),
          "worker accept through both sockets",
        );
        const accepted = protocol.decodeWorkerLinkFrame(
          relay.frames.shift().bytes,
        );
        assert.equal(accepted.header.kind, "accept");
        const payload = Buffer.from([0, 1, 127, 128, 254, 255]);
        const data = {
          ...frameIdentity(header),
          kind: "data",
          sequence: 1,
          direction: "client-to-worker",
          payloadFormat: "raw",
        };
        relay.ws.send(protocol.encodeWorkerLinkFrame(data, payload));
        await until(
          () => relay.frames.length,
          (n) => assert.equal(n, 1),
          "binary echo",
        );
        const received = relay.frames.shift();
        assert.equal(received.binary, true);
        const expected = protocol.encodeWorkerLinkFrame(
          { ...data, direction: "worker-to-client" },
          payload,
        );
        assert.deepEqual(received.bytes, Buffer.from(expected));
        result.binary.push({
          label: "byte-exact bidirectional data",
          payload: payload.toString("base64"),
          accepted: fixture.normalize(accepted.header),
        });
        relay.ws.send(protocol.encodeWorkerLinkFrame(data, payload));
        result.sockets.push({
          label: "client replay",
          ...(await relay.closed),
        });
        assert.deepEqual(await relay.closed, {
          code: 1008,
          reason: "WorkerLink channel sequence is invalid",
        });
        const text = await observeSocket("text relay", connect, {}, 101);
        text.ws.send("not binary");
        assert.deepEqual(await text.closed, {
          code: 1003,
          reason: "WorkerLink relay requires binary frames",
        });
        result.sockets.push({ label: "text rejected", ...(await text.closed) });
        const malformed = await observeSocket(
          "malformed relay",
          connect,
          {},
          101,
        );
        malformed.ws.send(Buffer.from("invalid"));
        assert.deepEqual(await malformed.closed, {
          code: 1003,
          reason: "WorkerLink frame is invalid",
        });
        // Each frame enters the server on one socket and leaves on the other.
        // Both network legs count toward their respective ingress/egress totals.
        const totalFrameBytes =
          protocol.encodeWorkerLinkFrame(header, new Uint8Array()).byteLength +
          protocol.encodeWorkerLinkFrame(data, payload).byteLength +
          protocol.encodeWorkerLinkFrame(accepted.header, new Uint8Array())
            .byteLength +
          expected.byteLength;
        const expectedTraffic = {
          ingress: totalFrameBytes,
          egress: totalFrameBytes,
        };
        await until(
          async () => {
            await fixture.observe(
              "relay traffic observation",
              "GET",
              "/api/account/resource-usage",
            );
            return accountResourceUsageSchema
              .parse(fixture.records.get("relay traffic observation"))
              .bandwidth.breakdown.filter(
                (row) => row.channel === "terminal-relay",
              );
          },
          (rows) => {
            assert.equal(rows.length, 2);
            for (const row of rows) {
              assert.equal(row.bytes, String(expectedTraffic[row.direction]));
              assert.equal(row.operationCount, "4");
            }
          },
          "actual feature traffic persisted",
        );
        result.binary.push({
          label: "metered validated frame bytes",
          ...expectedTraffic,
        });
        const beforeLogout = await observeSocket(
          "relay for logout",
          connect,
          {},
          101,
        );
        if (profile === "accounts") {
          await visit("logout revokes capability", "POST", "/api/auth/logout", {
            status: 204,
          });
          assert.deepEqual(await beforeLogout.closed, {
            code: 1008,
            reason: "Account session ended",
          });
          result.sockets.push({
            label: "logout closes relay",
            ...(await beforeLogout.closed),
          });
          await visit("login again", "POST", "/api/auth/login", {
            json: { email: "link-main@example.invalid", password },
          });
          await visit("old capability unavailable", "POST", base + "/renew", {
            status: 404,
          });
          assert.ok(
            commands.some((c) => c.type === "worker-link.session.revoke"),
          );
          const cancelled = await visit(
            "session for aborted logout",
            "POST",
            `/api/workers/${workerId}/worker-link/sessions`,
            { json: { clientInstanceId: clientId }, status: 201 },
          );
          const logoutSocket = await observeSocket(
            "relay for aborted logout",
            `/api/worker-links/${cancelled.sessionId}/connect?clientInstanceId=${clientId}`,
            {},
            101,
          );
          hold("worker-link.session.revoke");
          await abortedPost("/api/auth/logout");
          assert.equal(
            logoutSocket.ws.readyState,
            WebSocket.OPEN,
            "revocation acknowledgment is still pending",
          );
          releaseHeld();
          assert.deepEqual(await logoutSocket.closed, {
            code: 1008,
            reason: "Account session ended",
          });
          result.faults.push({
            label: "caller abort preserves logout capability cleanup",
            close: await logoutSocket.closed,
          });
          await visit("login after aborted logout", "POST", "/api/auth/login", {
            json: { email: "link-main@example.invalid", password },
          });
          await visit(
            "aborted logout capability unavailable",
            "POST",
            `/api/worker-links/${cancelled.sessionId}/renew`,
            { status: 404 },
          );
        } else await beforeLogout.close();
        mode = "reject";
        await visit(
          "worker rejects installation",
          "POST",
          `/api/workers/${workerId}/worker-link/sessions`,
          { json: { clientInstanceId: "rejected" }, status: 409 },
        );
        mode = "error";
        await visit(
          "worker installation failure",
          "POST",
          `/api/workers/${workerId}/worker-link/sessions`,
          { json: { clientInstanceId: "failed" }, status: 502 },
        );
        mode = "accept";
        result.workerFrames = workerFrames.map((value) =>
          fixture.normalize(value),
        );
        // Capture before shutdown because its interleaving with worker disconnect
        // is independently exercised by the native lifecycle/fault suites.
        result.commands = commands.map((command) => fixture.normalize(command));
        assert.ok(
          workerFrames.some(
            (f) =>
              f.header.kind === "close" &&
              f.header.code === "endpoint-disconnected",
          ),
        );
      } catch (cause) {
        result.scenarioError = { message: cause.message, stack: cause.stack };
        result.failedCommandTrace = commands.map((c) => fixture.normalize(c));
        throw cause;
      } finally {
        releaseHeld?.();
        for (const peer of sockets) peer.ws.terminate();
        worker?.close();
        await fixture.close();
      }
    }
    const comparable = (value) => {
      const { kind, ...rest } = value;
      const commands = [...rest.commands];
      // The reference explicitly uses Promise.all for account revocations.
      // Independent owner lookups may complete in either order; retain the raw
      // trace above and compare each contiguous batch as a complete multiset.
      const independent = (command) =>
        command.type === "worker-link.session.revoke" &&
        command.revocation.reason === "account-session-ended";
      for (let start = 0; start < commands.length; start++) {
        if (!independent(commands[start])) continue;
        let end = start + 1;
        while (end < commands.length && independent(commands[end])) end++;
        commands.splice(
          start,
          end - start,
          ...commands
            .slice(start, end)
            .sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
        );
        start = end - 1;
      }
      return { ...rest, commands };
    };
    assert.deepEqual(
      comparable(outputs[1]),
      comparable(outputs[0]),
      "Node/Rust " + profile,
    );
  }
} catch (cause) {
  failure = cause;
  report.error = { message: cause.message, stack: cause.stack };
} finally {
  await postgres?.close();
  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    profiles: report.profiles.map((p) => ({
      profile: p.profile,
      runtimes: p.runtimes.map((r) => ({
        kind: r.kind,
        observations: r.observations.length,
        sockets: r.sockets.length,
        commands: r.commands.length,
      })),
    })),
  }),
);
