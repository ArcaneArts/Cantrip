import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { encryptSurfaceStreamPayload } from "../../packages/crypto/dist/index.js";
import { directTunnelTicketSchema } from "../../packages/protocol/dist/direct-data-plane.js";
import { directTerminalForwarder } from "../server-rust/direct-terminal-forwarder.mjs";
import { deadline } from "../server-rust/native-broker-client.mjs";
import {
  TerminalRelayProbe,
  until,
} from "../server-rust/terminal-relay-probe.mjs";
import { connectDirect } from "./direct-client.mjs";
import { protectedTerminalView } from "./terminal-relay-client.mjs";

export async function verifyLegacyDirectTerminal({
  binary,
  call,
  checkout,
  ownerId,
  serverId,
  surfaceKey,
  id,
  marker,
  pid,
}) {
  const response = await call("POST", `/api/terminals/${id}/direct`, {
    clientId: "native-terminal-direct-fixture",
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const ticket = directTunnelTicketSchema.parse(response.body);
  assert.equal(ticket.binding.resourceKind, "terminal");
  assert.equal(ticket.binding.resourceId, id);
  assert.equal(ticket.route.tunnelId, `terminal:${id}`);
  const attachment = "/api/direct-attachments/" + ticket.binding.capabilityId;
  let forward;
  let released = false;
  try {
    forward = await directTerminalForwarder(binary, ticket);
    const operationId = randomUUID();
    const fixture = {
      server: { origin: `http://127.0.0.1:${forward.port}` },
      client: () => ({ cookies: new Map() }),
    };
    if (!marker) {
      const invalid = new TerminalRelayProbe(fixture, "/terminal");
      await assert.rejects(
        deadline(invalid.open(), "Terminal WebSocket without an operation"),
      );
      await deadline(invalid.close(), "Invalid terminal WebSocket teardown");
    }
    const relay = new TerminalRelayProbe(
      fixture,
      "/terminal?operationId=" + operationId,
    );
    const view = await protectedTerminalView(relay, {
      ownerId,
      serverId,
      surfaceKey,
      id,
      operationId,
    });
    if (marker) {
      assert.ok(view.replay.includes(marker));
      assert.equal(view.hydration.format, "legacy-raw");
    }
    const competing = new TerminalRelayProbe(
      fixture,
      "/terminal?operationId=" + randomUUID(),
    );
    await assert.rejects(
      deadline(competing.open(), "Second terminal WebSocket"),
    );
    await deadline(competing.close(), "Second terminal WebSocket teardown");

    relay.send(Buffer.from("invalid binary"), { binary: true, raw: true });
    assert.equal(
      (await relay.next(({ type }) => type === "error")).message,
      "Terminal messages must be text.",
    );
    const suffix = randomUUID();
    const privateProof = "direct-terminal-" + suffix;
    const proofName = "direct-terminal-proof-" + suffix;
    const proof = path.join(checkout, proofName);
    const command =
      `printf '%s\\n' "$$" >> '${proofName}'; ` +
      `/bin/stty size >> '${proofName}'; ` +
      `printf '%s%s\\n' direct-terminal- '${suffix}'\r`;
    const protectedData = await encryptSurfaceStreamPayload({
      ownerId,
      componentKey: surfaceKey,
      keyRevision: 1,
      context: {
        serverId,
        surfaceKind: "terminal",
        surfaceId: id,
        operationId,
        direction: "input",
        sequence: 0,
      },
      plaintext: Buffer.from(
        JSON.stringify({ type: "terminal.input", data: command }),
      ),
    });
    const input = { type: "input", operationId, sequence: 0, protectedData };
    relay.send({ ...input, operationId: randomUUID() });
    assert.equal(
      (await relay.next(({ type }) => type === "error")).message,
      "Invalid protected terminal message.",
    );
    await assert.rejects(readFile(proof), { code: "ENOENT" });
    relay.send({ type: "resize", cols: 103, rows: 35 });
    relay.send(input);
    await view.read(new RegExp(privateProof));
    relay.send(input);
    assert.equal(
      (await relay.next(({ type }) => type === "error")).message,
      "Invalid protected terminal message.",
    );
    const written = /^(\d+)\n35 103\n$/.exec(await readFile(proof, "utf8"));
    assert.ok(written);
    if (pid) assert.equal(written[1], pid);
    assert.equal(
      Buffer.concat([
        ...forward.carrier.sentFrames,
        ...forward.carrier.frames,
      ]).includes(Buffer.from(privateProof)),
      false,
    );

    await connectDirect(ticket, { expectClose: 1008 });
    assert.equal((await call("DELETE", attachment)).status, 204);
    released = true;
    assert.equal(
      (await until(() => forward.carrier.closed, "Revoked terminal broker"))
        .code,
      1008,
    );
    await deadline(relay.closed, "Revoked terminal WebSocket");
    forward.check();
    return { marker: privateProof, pid: written[1] };
  } finally {
    if (!released) await call("DELETE", attachment);
    await forward?.close();
  }
}
