import {
  terminalServerMessageSchema,
  type WorkerEvent,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { terminalRelayOutputMessage } from "../src/terminals/relay.js";

describe("terminal relay protocol", () => {
  it("translates worker output into the client-facing terminal frame", () => {
    const event: Extract<WorkerEvent, { type: "terminal.output" }> = {
      type: "terminal.output",
      operationId: "terminal-operation",
      sequence: 0,
      protectedData: {
        formatVersion: 1,
        keyRevision: 1,
        envelope: {
          version: 1,
          algorithm: "AES-256-GCM",
          keyRevision: 1,
          nonce: "AAAAAAAAAAAAAAAA",
          ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
        },
      },
    };

    expect(
      terminalServerMessageSchema.parse(terminalRelayOutputMessage(event)),
    ).toEqual({
      type: "output",
      operationId: event.operationId,
      sequence: event.sequence,
      protectedData: event.protectedData,
    });
  });
});
