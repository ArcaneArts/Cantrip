import { describe, expect, it } from "vitest";

import {
  agentInteractionProvenanceSchema,
  agentInteractionRequestCreateSchema,
  agentInteractionRequestPayloadSchema,
  agentInteractionRequestSchema,
  agentInteractionRequestWireSchema,
  encryptedAgentInteractionRequestCreateSchema,
} from "./agent-interactions.js";

const provenance = {
  chatId: "chat",
  threadId: "native-thread",
  turnId: null,
  itemId: null,
  executionLaneId: null,
  workerId: "worker",
};
const permissions = {
  kind: "permissions",
  startedAtMs: 0,
  environmentId: null,
  cwd: "/fixture",
  reason: null,
  requestedPermissions: { computerUse: true },
};
const native = {
  requestKey: "native-approval-key",
  projectId: null,
  provenance: { ...provenance, owner: "computer-use", threadId: null },
  payload: { ...permissions, source: "native-computer-use", cwd: null },
  expiresAt: null,
};
const protectedPayload = {
  formatVersion: 1,
  keyRevision: 1,
  envelope: {
    version: 1,
    algorithm: "AES-256-GCM",
    keyRevision: 1,
    nonce: "A".repeat(16),
    ciphertext: "A".repeat(22),
  },
};
const timestamps = {
  id: "5191a6c1-ae3d-4ce3-bd0b-4f83fda6c331",
  status: "pending",
  resolvedByUserId: null,
  resolvedAt: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

describe("interaction provenance ownership", () => {
  it("preserves historical absent-owner Codex JSON exactly", () => {
    expect(
      JSON.stringify(agentInteractionProvenanceSchema.parse(provenance)),
    ).toBe(JSON.stringify(provenance));
    const payload = agentInteractionRequestPayloadSchema.parse(permissions);
    expect(JSON.stringify(payload)).toBe(JSON.stringify(permissions));
    expect(
      agentInteractionProvenanceSchema.parse({ ...provenance, owner: "codex" })
        .owner,
    ).toBe("codex");
  });
  it.each([undefined, "codex"])(
    "requires a real native thread for Codex owner %s",
    (owner) => {
      expect(
        agentInteractionProvenanceSchema.safeParse({
          ...provenance,
          ...(owner ? { owner } : {}),
          threadId: null,
        }).success,
      ).toBe(false);
    },
  );
  it("allows CUA without a native thread/turn but requires its chat", () => {
    expect(agentInteractionRequestCreateSchema.safeParse(native).success).toBe(
      true,
    );
    expect(
      agentInteractionProvenanceSchema.safeParse({
        ...native.provenance,
        chatId: null,
      }).success,
    ).toBe(false);
    expect(
      agentInteractionProvenanceSchema.safeParse({
        ...native.provenance,
        workerId: "",
      }).success,
    ).toBe(false);
    expect(
      agentInteractionProvenanceSchema.safeParse({
        ...native.provenance,
        owner: "unknown",
      }).success,
    ).toBe(false);
  });
  it("permits null cwd only for explicitly native computer-use permissions", () => {
    expect(
      agentInteractionRequestPayloadSchema.safeParse({
        ...permissions,
        cwd: null,
      }).success,
    ).toBe(false);
    expect(
      agentInteractionRequestPayloadSchema.safeParse(native.payload).success,
    ).toBe(true);
    expect(
      agentInteractionRequestPayloadSchema.safeParse({
        ...native.payload,
        source: "other",
      }).success,
    ).toBe(false);
    expect(
      agentInteractionRequestPayloadSchema.safeParse({
        ...native.payload,
        cwd: "",
      }).success,
    ).toBe(false);
  });
  it("rejects mismatched native payload and provenance on create and stored reads", () => {
    const mismatches = [
      { ...native, provenance },
      { ...native, payload: permissions },
      {
        ...native,
        payload: {
          kind: "fileChange",
          startedAtMs: 0,
          reason: null,
          grantRoot: null,
        },
      },
    ];
    for (const request of mismatches) {
      expect(
        agentInteractionRequestCreateSchema.safeParse(request).success,
      ).toBe(false);
      expect(
        agentInteractionRequestSchema.safeParse({
          ...request,
          ...timestamps,
          response: null,
        }).success,
      ).toBe(false);
    }
  });
  it("accepts protected native permissions and rejects another protected kind", () => {
    const { payload: _payload, ...base } = native;
    const encrypted = {
      ...base,
      classification: { kind: "permissions" },
      protectedPayload,
    };
    expect(
      encryptedAgentInteractionRequestCreateSchema.safeParse(encrypted).success,
    ).toBe(true);
    expect(
      agentInteractionRequestWireSchema.safeParse({
        ...encrypted,
        ...timestamps,
        protectedResponse: null,
      }).success,
    ).toBe(true);
    expect(
      encryptedAgentInteractionRequestCreateSchema.safeParse({
        ...encrypted,
        classification: { kind: "commandExecution" },
      }).success,
    ).toBe(false);
  });
  it("requires genuine public CUA request UUIDs without rewriting historical Codex IDs", () => {
    expect(
      agentInteractionRequestSchema.safeParse({
        ...native,
        ...timestamps,
        response: null,
      }).success,
    ).toBe(true);
    expect(
      agentInteractionRequestSchema.safeParse({
        ...native,
        ...timestamps,
        id: "fake-native-thread",
        response: null,
      }).success,
    ).toBe(false);
    expect(
      agentInteractionRequestSchema.safeParse({
        ...native,
        provenance,
        payload: permissions,
        ...timestamps,
        id: "historical-codex-request",
        response: null,
      }).success,
    ).toBe(true);
  });
});
