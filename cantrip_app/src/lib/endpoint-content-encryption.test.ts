import { describe, expect, it, vi } from "vitest";
import {
  computerUseActionSchema,
  type ComputerUseAction,
} from "@cantrip/protocol/computer-use";

// These adapters are tested against real AEAD with fixed in-memory component
// keys. Never initialize the default native key provider or a real profile.
vi.mock("./client-encryption", () => ({
  ClientEncryptionError: class extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  clientEncryption: undefined,
}));
vi.mock("./client-session", () => ({ getClientSession: () => null }));

import type { ClientEncryptionService } from "./client-encryption";
import type { ClientSessionContext } from "./client-session";
import {
  openEndpointBytes,
  openEndpointContent,
  protectEndpointBytes,
  protectEndpointContent,
  type ClientEndpointContentContext,
} from "./endpoint-content-encryption";

const context: ClientEndpointContentContext = {
  domain: "client-control-content",
  workerId: "fixture-worker",
  scopeId: "fixture-chat",
  operationId: "11111111-1111-4111-8111-111111111111",
  operation: "observation.snapshot",
  direction: "event",
  sequence: 0,
};

function fixture(
  input: {
    ownerId?: string;
    serverId?: string;
    keyRevision?: number;
    status?: string;
  } = {},
) {
  const issued: Uint8Array[] = [];
  const identity = {
    ownerId: input.ownerId ?? "fixture-owner",
    serverId: input.serverId ?? "fixture-server",
  };
  const service = {
    getSnapshot: () => ({
      status: input.status ?? "ready",
      identity,
      masterKeyRevision: input.keyRevision ?? 3,
    }),
    componentKey: () => {
      const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
      issued.push(key);
      return key;
    },
  } as unknown as ClientEncryptionService;
  const session = () =>
    ({
      serverId: identity.serverId,
      user: { id: identity.ownerId },
    }) as ClientSessionContext;
  return { options: { service, session }, issued };
}

describe("client endpoint raw bytes", () => {
  it.each([new Uint8Array(), new Uint8Array([0, 255, 128, 13, 10])])(
    "preserves borrowed bytes, returns owned plaintext, and clears temporary keys",
    async (plaintext) => {
      const { options, issued } = fixture();
      const original = plaintext.slice();
      const opaque = await protectEndpointBytes({
        context,
        plaintext,
        options,
      });
      const opened = await openEndpointBytes({ context, opaque, options });
      expect(opened).toEqual(original);
      expect(opened).not.toBe(plaintext);
      opened.fill(0);
      expect(plaintext).toEqual(original);
      expect(issued.every((key) => key.every((byte) => byte === 0))).toBe(true);
    },
  );

  it("authenticates session owner/server and the endpoint context and key revision", async () => {
    const source = fixture();
    const opaque = await protectEndpointBytes({
      context,
      plaintext: new Uint8Array([1]),
      options: source.options,
    });
    for (const input of [
      { ...fixture({ ownerId: "other-owner" }), context },
      { ...fixture({ serverId: "other-server" }), context },
      { ...fixture({ keyRevision: 4 }), context },
      { ...fixture(), context: { ...context, workerId: "other-worker" } },
    ]) {
      await expect(
        openEndpointBytes({
          context: input.context,
          opaque,
          options: input.options,
        }),
      ).rejects.toMatchObject({ code: "decryption-failed" });
      expect(input.issued.every((key) => key.every((byte) => byte === 0))).toBe(
        true,
      );
    }
  });

  it("rejects locked or mismatched sessions without requesting any key", async () => {
    const locked = fixture({ status: "locked" });
    const switched = fixture();
    switched.options.session = () =>
      ({
        serverId: "other-server",
        user: { id: "fixture-owner" },
      }) as ClientSessionContext;
    for (const input of [locked, switched]) {
      await expect(
        protectEndpointBytes({
          context,
          plaintext: new Uint8Array([1]),
          options: input.options,
        }),
      ).rejects.toMatchObject({ code: "locked" });
      expect(input.issued).toHaveLength(0);
    }
  });

  it("preserves the existing JSON wrapper format", async () => {
    const { options } = fixture();
    const schema = computerUseActionSchema;
    const content = { operation: "targets.list" } as const;
    const opaque = await protectEndpointContent<ComputerUseAction>({
      context,
      content,
      schema,
      options,
    });
    const bytes = await openEndpointBytes({ context, opaque, options });
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(content);
    bytes.fill(0);
    await expect(
      openEndpointContent({ context, opaque, schema, options }),
    ).resolves.toEqual(content);
  });
});
