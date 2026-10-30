// Observe completion through the real telemetry operation. Seeing a worker
// request alone does not mean its acknowledgment has reached the server.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

export const emptyDirectTelemetry = {
  bytesFromLocal: 0,
  bytesToLocal: 0,
  connectionsClosed: 0,
  connectionsOpened: 0,
};

export async function directPreparationPublished(fixture, capabilityId, proof) {
  const client = fixture.client();
  const end = Date.now() + 10000;
  for (;;) {
    const response = await fetch(
      fixture.server.origin +
        `/api/direct-attachments/${capabilityId}/telemetry`,
      {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1:5173",
          "content-type": "application/json",
          cookie: [...client.cookies].map(([k, v]) => k + "=" + v).join("; "),
          ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
        },
        body: JSON.stringify(emptyDirectTelemetry),
      },
    );
    const body = await response.json();
    proof.push({ status: response.status, body });
    if (response.status === 409) {
      assert.deepEqual(body, {
        error: "Direct attachment renewal was rejected.",
      });
      return response.status;
    }
    assert.equal(
      response.status,
      404,
      "only an unpublished capability may be retried",
    );
    assert.deepEqual(body, { error: "Direct attachment not found." });
    assert.ok(
      Date.now() < end,
      "actual telemetry observes the prepared capability",
    );
    await delay(10);
  }
}
