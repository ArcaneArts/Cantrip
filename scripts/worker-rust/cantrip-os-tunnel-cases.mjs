// Core and the native worker reach an owned guest-loopback listener through
// the real service broker. The fixture guest has no host network access.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { encryptEndpointContentPayload } from "../../packages/crypto/dist/index.js";
import { openTunnelDataFrame } from "../../tests/reference-node-worker/src/tunnel-data-protection.ts";
import { Connection } from "./worker-link-tunnel-cases.mjs";
import { ownerId } from "./cantrip-os-grant.mjs";

export async function verifyCantripOsTunnel({
  origin,
  call,
  docker,
  container,
  actual,
  os,
  binding,
  workerId,
  componentKey,
  eventually,
}) {
  const ready = actual.home + "/cantrip-tunnel-fixture-" + randomUUID();
  const guest = (...args) =>
    docker("exec", "--user", String(actual.uid), container, ...args);
  await docker(
    "exec",
    "--detach",
    "--user",
    String(actual.uid),
    container,
    "python3",
    "-c",
    `
import pathlib, socket, sys
from contextlib import closing
ready = pathlib.Path(sys.argv[1])
with closing(socket.socket()) as listener:
    listener.bind(("127.0.0.1", 0))
    listener.listen(2)
    listener.settimeout(60)
    ready.write_text(str(listener.getsockname()[1]))
    for count in range(2):
        service, _ = listener.accept()
        with closing(service):
            try:
                payload = b"".join(iter(lambda: service.recv(65536), b""))
                if payload:
                    service.sendall(b"guest:" + payload)
            except ConnectionError:
                pass
        ready.with_suffix(".closed").write_text(str(count + 1))
`,
    ready,
  );
  const port = await eventually(async () => {
    const value = Number(await guest("cat", ready));
    assert.ok(Number.isInteger(value) && value > 0);
    return value;
  });

  const clientInstanceId = randomUUID();
  const session = await call(
    "POST",
    "/api/workers/" + workerId + "/worker-link/sessions",
    { clientInstanceId },
    201,
  );
  const base = "/api/worker-links/" + session.sessionId;
  const relay = await call("POST", base + "/route", {
    preferredRoute: "relay",
  });
  const tunnelId = randomUUID();
  const source = {
    bindingId: binding.id,
    worktreeId: binding.worktreeId,
    bindingGeneration: binding.bindingGeneration,
    attachmentGeneration: os.attachmentGeneration,
    runtimeGeneration: os.runtimeGeneration,
  };
  const configuration = {
    formatVersion: 1,
    algorithm: "AES-256-GCM",
    keyRevision: 1,
    key: randomBytes(32).toString("base64url"),
  };
  const protectedRecord = {
    operationId: tunnelId,
    revision: 1,
    protectedContent: await encryptEndpointContentPayload({
      ownerId,
      componentKey,
      keyRevision: 1,
      context: {
        domain: "tunnel-content",
        serverId: relay.identity.serverId,
        workerId,
        scopeId: JSON.stringify(["tunnel", tunnelId]),
        operationId: tunnelId,
        operation: "tunnel.record",
        direction: "stored",
        sequence: 1,
      },
      plaintext: Buffer.from(
        JSON.stringify({
          name: "Guest TCP fixture",
          description: null,
          source: { kind: "desktop-loopback" },
          destination: { kind: "worker-os-tcp", workerId, port, source },
          dataProtection: configuration,
        }),
      ),
    }),
  };
  const tunnel = await call(
    "POST",
    "/api/tunnels",
    {
      id: tunnelId,
      projectId: binding.projectId,
      protocolHint: "tcp",
      source: { kind: "desktop-loopback" },
      destination: {
        kind: "worker-adapter",
        adapter: "cantrip-os",
        resourceId: tunnelId,
        workerId,
      },
      osSource: source,
      protectedRecord,
    },
    201,
  );
  assert.deepEqual(tunnel.protectedRecord, protectedRecord);
  const { attachmentId } = await call(
    "POST",
    "/api/tunnels/" + tunnelId + "/attachments",
    { clientId: clientInstanceId },
    201,
  );
  const { grant, route } = await call(
    "POST",
    base + "/tunnel-attachments/" + attachmentId + "/grant",
    {},
    201,
  );
  assert.ok(grant.binding.operations.includes("stream:guest-connect"));
  const url = new URL(base + "/connect", origin);
  url.protocol = "ws:";
  url.searchParams.set("clientInstanceId", clientInstanceId);
  url.searchParams.set("routeGeneration", String(relay.routeGeneration));
  const connection = new Connection(url, relay);
  try {
    await connection.open(grant, 65536);
    const wrong = connection.stream(route, {
      ...route.target,
      protectedRecord: { ...protectedRecord, operationId: randomUUID() },
    });
    assert.equal(
      (await wrong.next("rejected")).header.code,
      "protected-target-invalid",
    );

    const stream = connection.stream(route, undefined, 65536);
    await stream.next("accepted");
    const request = Buffer.from("private guest fixture " + randomUUID());
    stream.send(
      { kind: "data", direction: "source-to-destination" },
      request,
      configuration,
    );
    stream.send({ kind: "half-close", direction: "source-to-destination" });
    const chunks = [];
    for (;;) {
      const { header, payload } = await stream.next("data", "half-close");
      if (header.kind === "half-close") break;
      chunks.push(openTunnelDataFrame(configuration, header, payload));
    }
    assert.deepEqual(
      Buffer.concat(chunks),
      Buffer.concat([Buffer.from("guest:"), request]),
    );

    const held = connection.stream(route);
    await held.next("accepted");
    await call(
      "DELETE",
      "/api/tunnel-attachments/" + attachmentId,
      undefined,
      204,
    );
    await connection.nextControl("close");
    await eventually(async () => {
      assert.equal(await guest("cat", ready + ".closed"), "2");
    });
  } finally {
    connection.socket.terminate();
  }
}
