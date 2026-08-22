import {
  agentActivityRawEnvelopeSchema,
  agentActivityRawRequestLimitBytes,
  agentActivityRawResponseLimitBytes,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { createAgentActivityRawEnvelope } from "../src/codex/raw-capture.js";

describe("protected agent activity raw capture", () => {
  it("redacts credential keys and recognizable token values", () => {
    const envelope = createAgentActivityRawEnvelope({
      request: {
        Authorization: "Bearer secret-value",
        nested: { api_key: "sk-supersecret123", query: "safe" },
      },
      response: "token=visible-secret safe-result",
      metadata: { cookie: "session=secret", requestId: "request-1" },
    });
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("supersecret123");
    expect(serialized).not.toContain("visible-secret");
    expect(serialized).not.toContain("session=secret");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("safe-result");
    expect(agentActivityRawEnvelopeSchema.parse(envelope)).toEqual(envelope);
  });

  it("enforces independent request and response byte limits", () => {
    const envelope = createAgentActivityRawEnvelope({
      request: "r".repeat(agentActivityRawRequestLimitBytes + 1_000),
      response: "s".repeat(agentActivityRawResponseLimitBytes + 1_000),
    });
    expect(envelope.request?.truncated).toBe(true);
    expect(envelope.response?.truncated).toBe(true);
    expect(
      new TextEncoder().encode(envelope.request?.text ?? "").byteLength,
    ).toBe(agentActivityRawRequestLimitBytes);
    expect(
      new TextEncoder().encode(envelope.response?.text ?? "").byteLength,
    ).toBe(agentActivityRawResponseLimitBytes);
  });

  it("omits binary bodies while retaining size and digest metadata", () => {
    const envelope = createAgentActivityRawEnvelope({
      response: new Uint8Array([1, 2, 3, 4]),
    });
    expect(envelope.response).toMatchObject({
      mediaType: "application/octet-stream",
      originalBytes: 4,
      text: null,
      truncated: false,
    });
    expect(envelope.response?.digest).toMatch(/^sha256:/u);
    expect(envelope.response?.omittedReason).toContain("Binary");
  });
});
