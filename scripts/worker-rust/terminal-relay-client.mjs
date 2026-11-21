import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as crypto from "../../packages/crypto/dist/index.js";
import { TerminalRelayProbe } from "../server-rust/terminal-relay-probe.mjs";

export async function attachTerminal({
  origin,
  ownerId,
  serverId,
  surfaceKey,
  id,
}) {
  const fixture = {
    server: { origin },
    client: () => ({ cookies: new Map() }),
  };
  const operationId = randomUUID();
  const relay = new TerminalRelayProbe(
    fixture,
    `/api/terminals/${id}/connect?operationId=${operationId}`,
  );
  return protectedTerminalView(relay, {
    ownerId,
    serverId,
    surfaceKey,
    id,
    operationId,
  });
}

export async function protectedTerminalView(
  relay,
  { ownerId, serverId, surfaceKey, id, operationId },
) {
  try {
    await relay.open();
    const binding = (direction, sequence) => ({
      serverId,
      surfaceKind: "terminal",
      surfaceId: id,
      operationId,
      direction,
      sequence,
    });
    const secret = { ownerId, keyRevision: 1, componentKey: surfaceKey };
    let sequence = 0,
      outputSequence = 0,
      data = "",
      hydration;
    const snapshotParts = [];
    async function output(frame) {
      assert.equal(frame.type, "output", JSON.stringify(frame));
      assert.equal(frame.operationId, operationId);
      assert.equal(frame.sequence, outputSequence);
      const bytes = await crypto.decryptSurfaceStreamPayload({
        ...secret,
        context: binding("output", outputSequence++),
        opaque: frame.protectedData,
      });
      const content = JSON.parse(Buffer.from(bytes).toString());
      assert.equal(content.type, "terminal.output");
      if (frame.hydration) {
        assert.equal(frame.sequence, 0, "metadata starts the snapshot");
        hydration = frame.hydration;
      }
      if (hydration && snapshotParts.length < hydration.snapshotChunks) {
        snapshotParts.push(content.data);
      }
      data += content.data;
    }
    for (;;) {
      const frame = await relay.next();
      if (frame.type === "ready") break;
      await output(frame);
    }
    if (hydration) {
      assert.equal(snapshotParts.length, hydration.snapshotChunks);
      assert.equal(snapshotParts.join("").length, hydration.snapshotCharacters);
    }
    return {
      relay,
      replay: data,
      hydration,
      snapshotParts,
      async input(text) {
        const protectedData = await crypto.encryptSurfaceStreamPayload({
          ...secret,
          context: binding("input", sequence),
          plaintext: Buffer.from(
            JSON.stringify({ type: "terminal.input", data: text }),
          ),
        });
        relay.send({
          type: "input",
          operationId,
          sequence: sequence++,
          protectedData,
        });
      },
      async read(match) {
        while (!match.test(data)) await output(await relay.next());
        return data;
      },
    };
  } catch (error) {
    await relay.close();
    throw error;
  }
}
