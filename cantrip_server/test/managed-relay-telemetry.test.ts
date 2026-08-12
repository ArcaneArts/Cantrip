import { describe, expect, it } from "vitest";

import type { ServerRepository } from "../src/db/repository.js";
import { ManagedServerRelayTelemetry } from "../src/tunnels/managed-relay-telemetry.js";

describe("managed server relay telemetry", () => {
  it("flushes buffered adapter counters before teardown", async () => {
    const touches: unknown[] = [];
    const repository = {
      touchManagedServerRelay: async (
        ownerId: string,
        attachmentId: string,
        metrics: unknown,
      ) => touches.push({ attachmentId, metrics, ownerId }),
    } as unknown as ServerRepository;
    const changes: unknown[] = [];
    const identity = {
      attachmentId: "attachment-1",
      ownerId: "owner-1",
      projectId: "project-1",
      tunnelId: "tunnel-1",
    };
    const telemetry = new ManagedServerRelayTelemetry(
      repository,
      identity,
      (change) => changes.push(change),
    );
    const expiresAt = new Date("2030-01-01T00:00:00.000Z");

    telemetry.record(
      { bytesFromSource: 5, bytesToSource: 3, connectionDelta: 1 },
      expiresAt,
    );
    telemetry.record(
      { bytesFromSource: 2, bytesToSource: 4, connectionDelta: -1 },
      expiresAt,
    );
    await telemetry.close(expiresAt);

    expect(touches).toEqual([
      {
        attachmentId: "attachment-1",
        metrics: {
          activeConnectionDelta: 0,
          bytesFromSource: 7,
          bytesToSource: 7,
          expiresAt,
        },
        ownerId: "owner-1",
      },
    ]);
    expect(changes).toEqual([identity]);
  });
});
