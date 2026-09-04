import type { EndpointContentContext } from "@cantrip/protocol/endpoint-content";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  openWorkerEndpointBytes,
  openWorkerEndpointContent,
  protectWorkerEndpointBytes,
  protectWorkerEndpointContent,
  type WorkerEndpointEncryptionService,
} from "./endpoint-content-encryption.js";
import {
  WorkerEncryptionError,
  type WorkerEncryptionService,
} from "./worker-encryption.js";

const context: EndpointContentContext = {
  domain: "client-control-content",
  serverId: "fixture-server",
  workerId: "fixture-worker",
  scopeId: "fixture-chat",
  operationId: "11111111-1111-4111-8111-111111111111",
  operation: "observation.snapshot",
  direction: "event",
  sequence: 0,
};

function fixture(ownerId = "fixture-owner", keyRevision = 3) {
  const issued: Uint8Array[] = [];
  const service: WorkerEndpointEncryptionService = {
    ownerId: () => ownerId,
    componentKey: () => {
      const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
      issued.push(key);
      return { key, keyRevision };
    },
  };
  return { service, issued };
}

describe("worker endpoint raw bytes", () => {
  it.each([new Uint8Array(), new Uint8Array([0, 255, 128, 13, 10])])(
    "round trips borrowed binary input and returns independently owned plaintext",
    async (plaintext) => {
      const { service, issued } = fixture();
      const original = plaintext.slice();
      const opaque = await protectWorkerEndpointBytes({
        context,
        plaintext,
        service,
      });
      const opened = await openWorkerEndpointBytes({
        context,
        opaque,
        service,
      });
      expect(opened).toEqual(original);
      expect(opened).not.toBe(plaintext);
      opened.fill(0);
      expect(plaintext).toEqual(original);
      expect(issued.every((key) => key.every((byte) => byte === 0))).toBe(true);
    },
  );

  it("rejects wrong owners, context, and stale revisions and clears issued keys", async () => {
    const source = fixture();
    const opaque = await protectWorkerEndpointBytes({
      context,
      plaintext: new Uint8Array([9]),
      service: source.service,
    });
    for (const input of [
      { ...fixture("other-owner"), context },
      { ...fixture(), context: { ...context, scopeId: "other-chat" } },
      { ...fixture("fixture-owner", 4), context },
    ]) {
      await expect(
        openWorkerEndpointBytes({
          context: input.context,
          opaque,
          service: input.service,
        }),
      ).rejects.toThrow();
      expect(input.issued.every((key) => key.every((byte) => byte === 0))).toBe(
        true,
      );
    }
  });

  it("does not expose key-service errors or attempt key initialization", async () => {
    const service: WorkerEndpointEncryptionService = {
      ownerId: () => "fixture-owner",
      componentKey: () => {
        throw new WorkerEncryptionError("missing-scope", "private key detail");
      },
    };
    await expect(
      protectWorkerEndpointBytes({
        context,
        plaintext: new Uint8Array([1]),
        service,
      }),
    ).rejects.toThrow("Endpoint content encryption is unavailable.");
  });

  it("preserves the existing JSON wrapper format", async () => {
    const { service } = fixture();
    const schema = z.object({ text: z.string() }).strict();
    const content = { text: "fixture JSON" };
    const opaque = await protectWorkerEndpointContent({
      context,
      content,
      schema,
      service: service as WorkerEncryptionService,
    });
    const bytes = await openWorkerEndpointBytes({ context, opaque, service });
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(content);
    bytes.fill(0);
    await expect(
      openWorkerEndpointContent({
        context,
        opaque,
        schema,
        service: service as WorkerEncryptionService,
      }),
    ).resolves.toEqual(content);
  });
});
