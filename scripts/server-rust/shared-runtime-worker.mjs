// Actual unchanged WorkerConnection, HTTP handlers and relay sockets. WorkerLink
// installation/renewal acknowledgments are controlled; no resource execution claim.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { WorkerConnection } from "../../cantrip_worker/src/transport.ts";
import { saveWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import {
  directAttachmentTicketSchema,
  workerLinkSessionSchema,
} from "../../packages/protocol/dist/index.js";
import { eventually } from "./coordinated-fixture-tools.mjs";
import { deadline } from "./live-sockets.mjs";
import { request, requestHeaders } from "./shared-runtime-fixture-tools.mjs";
import { verifyTenantSession } from "./shared-runtime-tenants.mjs";
const WebSocket = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
)("ws");
const generation = "55555555-5555-4555-8555-555555555555";

async function operation(peer, method, route, status) {
  return (await request(peer, method, route, undefined, status)).body;
}

async function relay(peer, session, client = "main") {
  const url = new URL(
    `/api/worker-links/${session.sessionId}/connect`,
    peer.server.origin,
  );
  url.protocol = "ws:";
  url.searchParams.set("clientInstanceId", session.identity.clientInstanceId);
  url.searchParams.set("routeGeneration", String(session.routeGeneration));
  const socket = new WebSocket(url, {
    headers: requestHeaders(peer, { client, csrf: false }),
  });
  const closed = new Promise((resolve) =>
    socket.once("close", (code, reason) =>
      resolve({ code, reason: reason.toString() }),
    ),
  );
  const opened = new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  await deadline(opened, "shared WorkerLink relay upgrade");
  return { socket, closed };
}

async function addOwnerSession(authority, remote, login, client) {
  await authority.observe(
    "owner-session-" + client,
    "POST",
    "/api/auth/login",
    {
      client,
      json: login,
      status: 200,
    },
  );
  const session = authority.client(client);
  remote.clients.set(client, {
    cookies: new Map(session.cookies),
    csrf: session.csrf,
  });
}

async function activateDirect(issuer, control, client, clientInstanceId) {
  const options = { client };
  const session = workerLinkSessionSchema.parse(
    (
      await request(
        issuer,
        "POST",
        `/api/workers/${control.workerId}/worker-link/sessions`,
        { clientInstanceId },
        201,
        options,
      )
    ).body,
  );
  const route = `/api/worker-links/${session.sessionId}`;
  const ticket = directAttachmentTicketSchema.parse(
    (await request(issuer, "POST", route + "/direct", undefined, 201, options))
      .body,
  );
  assert.equal(ticket.binding.attachmentId, session.sessionId);
  const capabilityId = ticket.binding.capabilityId;
  await request(
    issuer,
    "POST",
    route + "/direct-activate",
    { capabilityId },
    204,
    options,
  );
  return { session, route, capabilityId, control };
}

function directRevocations({ capabilityId, control }) {
  return control.commands
    .filter(
      (command) =>
        command.type === "direct.capability.revoke" &&
        command.capabilityId === capabilityId,
    )
    .map((command) => command.reason);
}

async function verifyDirectRevocation(ticket, reason) {
  const reasons = await eventually(
    () => directRevocations(ticket),
    (reasons) => reasons.length > 0,
    "direct attachment teardown after sign-out",
  );
  assert.deepEqual(reasons, [reason]);
}

async function verifySinglePeerLogout(
  authority,
  issuer,
  peers,
  control,
  sockets,
  login,
  result,
) {
  await addOwnerSession(authority, issuer, login, "retiring");
  const retiring = await activateDirect(
    issuer,
    control,
    "retiring",
    "single-session-logout",
  );
  const sibling = await activateDirect(
    issuer,
    control,
    "main",
    "single-session-sibling",
  );
  const retiringRelays = [];
  const siblingRelays = [];
  for (const peer of peers) {
    const retiringRelay = await relay(peer, retiring.session, "retiring");
    retiringRelays.push(retiringRelay);
    sockets.push(retiringRelay);
    const siblingRelay = await relay(peer, sibling.session);
    siblingRelays.push(siblingRelay);
    sockets.push(siblingRelay);
  }
  assert.notEqual(
    retiring.session.identity.accountSessionId,
    sibling.session.identity.accountSessionId,
  );
  await request(authority, "POST", "/api/auth/logout", undefined, 204, {
    client: "retiring",
  });
  const relayClosures = await Promise.all(
    retiringRelays.map((socket) =>
      deadline(socket.closed, "single-session relay teardown"),
    ),
  );
  for (const closure of relayClosures) {
    assert.deepEqual(closure, { code: 1008, reason: "Account session ended" });
  }
  await verifyDirectRevocation(retiring, "Authorization session was revoked");
  assert.deepEqual(directRevocations(sibling), []);
  for (const socket of siblingRelays)
    assert.equal(socket.socket.readyState, WebSocket.OPEN);
  const renewed = workerLinkSessionSchema.parse(
    await operation(issuer, "POST", sibling.route + "/renew", 200),
  );
  assert.deepEqual(renewed.identity, sibling.session.identity);
  await operation(issuer, "DELETE", sibling.route, 204);
  await Promise.all(
    siblingRelays.map((socket) =>
      deadline(socket.closed, "sibling relay released"),
    ),
  );
  sockets.length = 0;
  result.singlePeerRevocation = {
    issuer: peers.indexOf(issuer),
    logoutPeer: peers.indexOf(authority),
    relayClosures,
    directRevocations: 1,
    siblingRetained: true,
  };
  result.cases.push(
    "single-session sign-out closes relays and revokes a direct attachment issued by the Rust peer while the sibling session stays usable",
  );
}

async function verifyAccountWideLogout(
  peers,
  controls,
  sockets,
  login,
  result,
) {
  const issuerIndex = peers[1].kind === "rust" ? 1 : 0;
  const issuer = peers[issuerIndex];
  const authority = issuer.kind === "rust" ? peers[1 - issuerIndex] : peers[0];
  const remote = peers.find((peer) => peer !== authority);
  if (issuer.kind === "rust") {
    await verifySinglePeerLogout(
      authority,
      issuer,
      peers,
      controls[peers.indexOf(authority)],
      sockets,
      login,
      result,
    );
  }
  await addOwnerSession(authority, remote, login, "secondary");

  const tickets = [];
  const sessions = [];
  for (const [i, client] of ["main", "secondary"].entries()) {
    const ticketIssuer = i === 1 && issuer.kind === "rust" ? issuer : authority;
    const ticket = await activateDirect(
      ticketIssuer,
      controls[1 - i],
      client,
      "account-logout-" + client,
    );
    tickets.push(ticket);
    sessions.push(ticket.session);
    for (const peer of peers)
      sockets.push(await relay(peer, ticket.session, client));
  }
  assert.notEqual(
    sessions[0].identity.accountSessionId,
    sessions[1].identity.accountSessionId,
  );

  const logout = await request(
    authority,
    "POST",
    "/api/auth/logout-all",
    undefined,
    200,
  );
  assert.deepEqual(logout.body, { revokedSessions: 2 });
  const relayClosures = await Promise.all(
    sockets.map((s) => deadline(s.closed, "account-wide relay revocation")),
  );
  for (const closed of relayClosures)
    assert.deepEqual(closed, { code: 1008, reason: "Account sessions ended" });
  sockets.length = 0;

  for (const ticket of tickets) {
    await verifyDirectRevocation(ticket, "Account sessions were revoked");
  }
  for (const peer of peers) {
    for (const client of ["main", "secondary"])
      await request(peer, "GET", "/api/workers", undefined, 401, { client });
    assert.deepEqual(
      (
        await request(peer, "GET", "/api/workers", undefined, 200, {
          client: "foreign",
        })
      ).body,
      [],
    );
  }
  result.accountWideRevocation = {
    revokedSessions: logout.body.revokedSessions,
    relayClosures,
    directRevocations: tickets.length,
    directAttachmentsIssuedOnBothPeers: issuer.kind === "rust",
  };
  result.cases.push(
    "account-wide logout revokes two database sessions, closes relays on both peers and removes two active direct capabilities while the foreign account stays signed in",
  );
}

export async function verifySharedWorkers(
  peers,
  directory,
  result,
  { whileConnected, ownerLogin },
) {
  const workers = [],
    sockets = [],
    controls = [];
  try {
    for (const [i, local] of peers.entries()) {
      const remote = peers[1 - i],
        workerId = "shared-enrolled-" + i;
      const bootstrap = local.records.get("bootstrap");
      const commands = [];
      let connected = 0;
      const config = {
        dataDirectory: path.join(directory, "worker-" + i),
        name: "Shared routing transport fixture",
        serverUrl: local.server.origin,
        enrollmentCode: null,
        replacement: null,
        token: local.records.get("enroll").credential,
        tokenSource: "persisted",
        workerId,
      };
      saveWorkerCredential({
        credential: config.token,
        dataDirectory: config.dataDirectory,
        serverUrl: config.serverUrl,
        workerId,
      });
      const worker = new WorkerConnection(
        config,
        async (command) => {
          if (
            !command.type.startsWith("worker-link.") &&
            !command.type.startsWith("direct.capability.")
          )
            return null;
          commands.push(command);
          if (command.type === "direct.capability.prepare")
            return {
              accepted: true,
              capabilityId: command.binding.capabilityId,
            };
          if (command.type === "direct.capability.revoke") return null;
          if (command.type === "worker-link.identity.resolve")
            return {
              serverId: bootstrap.server.id,
              ownerId: bootstrap.auth.currentUser.id,
              workerId,
              workerProcessGeneration: generation,
            };
          return { accepted: true };
        },
        undefined,
        undefined,
        undefined,
        1000,
        () => {
          connected++;
        },
        { connectionGeneration: generation },
      );
      workers.push(worker);
      worker.start();
      await eventually(
        () => connected,
        (v) => v,
        "actual shared worker ready",
      );
      // Observe the operation itself while the remote subscriber learns the
      // claim. A database heartbeat or Redis PING cannot prove this route ready.
      const opened = await eventually(
        async () => {
          const response = await fetch(
            remote.server.origin +
              `/api/workers/${workerId}/worker-link/sessions`,
            {
              method: "POST",
              headers: requestHeaders(remote, { json: true }),
              body: JSON.stringify({ clientInstanceId: "shared-control-" + i }),
              signal: AbortSignal.timeout(15000),
            },
          );
          const body = await response.json();
          assert.ok(
            response.status === 201 ||
              (response.status === 503 && body.error === "Worker is offline."),
            JSON.stringify({ status: response.status, body }),
          );
          return { status: response.status, body };
        },
        (v) => v.status === 201,
        "remote HTTP WorkerLink operation reaches actual worker",
      );
      const session = workerLinkSessionSchema.parse(opened.body);
      assert.equal(session.identity.ownerId, bootstrap.auth.currentUser.id);
      assert.equal(session.identity.workerId, workerId);
      assert.equal(session.identity.serverId, bootstrap.server.id);
      assert.equal(session.identity.workerProcessGeneration, generation);
      const base = `/api/worker-links/${session.sessionId}`;
      if (result.profile === "accounts") {
        const before = commands.length;
        await verifyTenantSession(peers, workerId, session, result);
        assert.equal(
          commands.length,
          before,
          "Foreign requests never dispatch a worker command",
        );
      }
      const renewalStarted = Date.now();
      const renewed = workerLinkSessionSchema.parse(
        await operation(local, "POST", base + "/renew", 200),
      );
      assert.deepEqual(renewed.identity, session.identity);
      assert.equal(renewed.sessionId, session.sessionId);
      assert.equal(
        renewed.lease.absoluteExpiresAt,
        session.lease.absoluteExpiresAt,
      );
      assert.ok(Date.parse(renewed.lease.expiresAt) > renewalStarted);
      assert.ok(
        Date.parse(renewed.lease.expiresAt) <= Date.now() + 120000 + 1000,
      );
      for (const peer of peers) sockets.push(await relay(peer, renewed));
      assert.equal(await operation(local, "DELETE", base, 204), null);
      for (const socket of sockets)
        assert.deepEqual(
          await deadline(socket.closed, "distributed actual relay revocation"),
          { code: 1008, reason: "WorkerLink session ended" },
        );
      sockets.length = 0;
      for (const type of [
        "worker-link.identity.resolve",
        "worker-link.session.install",
        "worker-link.session.renew",
        "worker-link.session.revoke",
      ])
        assert.ok(
          commands.some((c) => c.type === type),
          "Unchanged WorkerConnection acknowledged " + type,
        );
      result.cases.push(
        "worker " +
          i +
          " attached only locally receives remote HTTP install, cross-authority renewal/revocation and both real relay sockets close",
      );
      (result.workerCommands ??= []).push({
        worker: i,
        types: commands.map((c) => c.type),
      });
      controls.push({
        workerId,
        commands,
        async verifyRecovered() {
          const response = await request(
            remote,
            "POST",
            `/api/workers/${workerId}/worker-link/sessions`,
            { clientInstanceId: "after-recovery-" + i },
            201,
          );
          const session = workerLinkSessionSchema.parse(response.body);
          assert.equal(session.identity.workerId, workerId);
          await operation(
            local,
            "DELETE",
            `/api/worker-links/${session.sessionId}`,
            204,
          );
          assert.equal(
            connected,
            1,
            "Actual worker transport remains on its original ready connection",
          );
        },
      });
    }
    if (whileConnected) await whileConnected(controls);
    if (ownerLogin)
      await verifyAccountWideLogout(
        peers,
        controls,
        sockets,
        ownerLogin,
        result,
      );
  } finally {
    for (const socket of sockets) socket.socket.terminate();
    for (const worker of workers) worker.close();
  }
}
