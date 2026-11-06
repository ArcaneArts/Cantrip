import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { password } from "./security-fixtures.mjs";
import { LiveProbe, deadline } from "./live-sockets.mjs";
import { request, requestHeaders } from "./shared-runtime-fixture-tools.mjs";
import { publication, publish } from "./shared-runtime-live.mjs";
const WebSocket = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("ws");

export async function prepareForeignAccount(peers) {
  await peers[0].observe("foreign-registration", "POST", "/api/auth/register", {
    client: "foreign",
    status: 201,
    json: {
      email: "shared-foreign@example.invalid",
      displayName: "Foreign owner",
      password,
    },
  });
  const original = peers[0].client("foreign");
  peers[1].clients.set("foreign", {
    cookies: new Map(original.cookies),
    csrf: original.csrf,
  });
  for (const peer of peers) {
    await peer.observe("foreign-bootstrap", "GET", "/api/bootstrap", {
      client: "foreign",
    });
    assert.notEqual(
      peer.records.get("foreign-bootstrap").auth.currentUser.id,
      peer.records.get("bootstrap").auth.currentUser.id,
    );
  }
}
async function rejectRelay(peer, session) {
  const url = new URL(
    `/api/worker-links/${session.sessionId}/connect`,
    peer.server.origin,
  );
  url.protocol = "ws:";
  url.searchParams.set("clientInstanceId", session.identity.clientInstanceId);
  url.searchParams.set("routeGeneration", String(session.routeGeneration));
  const socket = new WebSocket(url, {
    headers: requestHeaders(peer, { client: "foreign", csrf: false }),
  });
  socket.on("error", () => {});
  try {
    const response = await deadline(
      new Promise((resolve, reject) => {
        socket.once("open", () =>
          reject(new Error("Foreign relay unexpectedly upgraded")),
        );
        socket.once("error", reject);
        socket.once("unexpected-response", (_request, response) => {
          const chunks = [];
          response.on("data", (bytes) => chunks.push(bytes));
          response.once("end", () =>
            resolve({
              status: response.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString()),
            }),
          );
        });
      }),
      "foreign WorkerLink relay rejection",
    );
    assert.deepEqual(response, {
      status: 404,
      body: { error: "WorkerLink session is unavailable." },
    });
  } finally {
    socket.terminate();
  }
}
export async function verifyTenantSession(peers, workerId, session, result) {
  for (const peer of peers) {
    const options = { client: "foreign" };
    assert.deepEqual(
      (await request(peer, "GET", "/api/workers", undefined, 200, options))
        .body,
      [],
    );
    assert.deepEqual(
      (
        await request(
          peer,
          "POST",
          `/api/workers/${workerId}/worker-link/sessions`,
          { clientInstanceId: "foreign-attempt" },
          404,
          options,
        )
      ).body,
      { error: "Worker not found." },
    );
    const base = `/api/worker-links/${session.sessionId}`;
    assert.deepEqual(
      (await request(peer, "POST", base + "/renew", undefined, 404, options))
        .body,
      { error: "WorkerLink session not found." },
    );
    await request(peer, "DELETE", base, undefined, 204, options);
    await rejectRelay(peer, session);
  }
  result.cases.push(
    "foreign account cannot enumerate worker, install/renew/revoke owner's shared session or upgrade its relay; owner session remains usable",
  );
}
export async function verifyTenantLive(peers, owned, result) {
  const foreign = peers.map(
    (peer) => new LiveProbe(peer, { client: "foreign" }),
  );
  try {
    for (const probe of foreign) {
      await probe.open();
      await probe.initialized();
      await probe.subscribed();
    }
    for (const [i, peer] of peers.entries()) {
      const own = "shared-tenant-owner-" + i,
        other = "shared-tenant-foreign-" + i;
      await publish(
        peer,
        [publication(own, peer.records.get("bootstrap").auth.currentUser.id)],
        true,
      );
      for (const probe of owned)
        await probe.message((v) => v.type === "event" && v.entityId === own);
      await publish(
        peer,
        [
          publication(
            other,
            peer.records.get("foreign-bootstrap").auth.currentUser.id,
          ),
        ],
        true,
      );
      for (const probe of foreign)
        await probe.message((v) => v.type === "event" && v.entityId === other);
      for (const probe of foreign) {
        await probe.ping();
        assert.ok(!probe.history.some((v) => v.entityId === own));
      }
      for (const probe of owned) {
        await probe.ping();
        assert.ok(!probe.history.some((v) => v.entityId === other));
      }
    }
    result.cases.push(
      "both account owners receive their own actual local/external live publications while opposite-owner events stay isolated",
    );
  } finally {
    await Promise.allSettled(foreign.map((p) => p.close()));
  }
}
