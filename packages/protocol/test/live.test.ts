import { describe, expect, it } from "vitest";

import {
  appLiveClientMessageSchema,
  appLiveEventPayloadSchema,
  appLiveResourceSchema,
  appLiveScopeKey,
  appLiveServerMessageSchema,
  decodeAppLiveClientMessage,
  decodeAppLiveServerMessage,
  encodeAppLiveClientMessage,
  encodeAppLiveServerMessage,
  type AppLiveScope,
} from "../src/index.js";

const projectScope = {
  kind: "project" as const,
  projectId: "project-1",
};

describe("application live protocol", () => {
  it("advertises tunnel state as an invalidation resource", () => {
    expect(appLiveResourceSchema.parse("tunnel")).toBe("tunnel");
  });

  it("initializes with an optional same-epoch replay cursor", () => {
    expect(
      appLiveClientMessageSchema.parse({
        type: "initialize",
        protocolVersion: 1,
        client: { id: "client-1", name: "Cantrip App", version: "0.0.0" },
      }),
    ).toMatchObject({ resume: null });
    expect(
      appLiveClientMessageSchema.parse({
        type: "initialize",
        protocolVersion: 1,
        client: { id: "client-1", name: "Cantrip App", version: "0.0.0" },
        resume: { serverEpoch: "epoch-1", cursor: 42 },
      }),
    ).toMatchObject({ resume: { serverEpoch: "epoch-1", cursor: 42 } });
    expect(() =>
      appLiveClientMessageSchema.parse({
        type: "initialize",
        protocolVersion: 2,
        client: { id: "client-1", name: "Cantrip App", version: "0.0.0" },
      }),
    ).toThrow();
  });

  it("models unique bounded subscription scopes", () => {
    expect(
      appLiveClientMessageSchema.parse({
        type: "subscribe",
        requestId: "request-1",
        scopes: [
          { kind: "current-user" },
          projectScope,
          { kind: "chat", chatId: "chat-1" },
          { kind: "workflow-run", runId: "run-1" },
        ],
      }).scopes,
    ).toHaveLength(4);
    expect(() =>
      appLiveClientMessageSchema.parse({
        type: "subscribe",
        requestId: "request-1",
        scopes: [projectScope, projectScope],
      }),
    ).toThrow(/unique/i);
    expect(() =>
      appLiveClientMessageSchema.parse({
        type: "subscribe",
        requestId: "request-1",
        scopes: Array.from({ length: 129 }, (_, index) => ({
          kind: "project",
          projectId: `project-${index}`,
        })),
      }),
    ).toThrow();
  });

  it("uses stable collision-free scope keys", () => {
    const scopes: AppLiveScope[] = [
      { kind: "current-user" },
      projectScope,
      { kind: "chat", chatId: "chat-1" },
      { kind: "workflow-run", runId: "run-1" },
    ];
    expect(scopes.map(appLiveScopeKey)).toEqual([
      "current-user",
      "project:project-1",
      "chat:chat-1",
      "workflow-run:run-1",
    ]);
  });

  it("validates client control messages strictly", () => {
    expect(
      appLiveClientMessageSchema.parse({
        type: "ping",
        nonce: "nonce-1",
      }),
    ).toEqual({ type: "ping", nonce: "nonce-1" });
    expect(
      appLiveClientMessageSchema.parse({
        type: "resync-ack",
        requestId: "request-2",
        cursor: 9,
        scopes: [projectScope],
      }).type,
    ).toBe("resync-ack");
    expect(() =>
      appLiveClientMessageSchema.parse({
        type: "ping",
        nonce: "nonce-1",
        secret: "not allowed",
      }),
    ).toThrow();
    expect(() =>
      appLiveClientMessageSchema.parse({ type: "unknown" }),
    ).toThrow();
  });

  it("models ready, subscription, replay, heartbeat, and resync messages", () => {
    expect(
      appLiveServerMessageSchema.parse({
        type: "ready",
        protocolVersion: 1,
        serverEpoch: "epoch-1",
        connectionId: "connection-1",
        currentCursor: 4,
        heartbeatIntervalMs: 30_000,
        resume: "replaying",
      }).resume,
    ).toBe("replaying");
    expect(
      appLiveServerMessageSchema.parse({
        type: "subscribed",
        requestId: "request-1",
        scopes: [projectScope],
        cursor: 4,
      }).type,
    ).toBe("subscribed");
    expect(
      appLiveServerMessageSchema.parse({
        type: "unsubscribed",
        requestId: "request-2",
        scopes: [projectScope],
        cursor: 5,
      }).type,
    ).toBe("unsubscribed");
    expect(
      appLiveServerMessageSchema.parse({
        type: "caught-up",
        cursor: 7,
        replayedCount: 3,
      }),
    ).toMatchObject({ replayedCount: 3 });
    expect(
      appLiveServerMessageSchema.parse({
        type: "pong",
        nonce: "nonce-1",
        cursor: 7,
      }).type,
    ).toBe("pong");
    expect(
      appLiveServerMessageSchema.parse({
        type: "resync-required",
        cursor: 7,
        reason: "cursor-expired",
        scopes: [projectScope],
      }).reason,
    ).toBe("cursor-expired");
  });

  it("validates typed events and structured errors", () => {
    expect(
      appLiveServerMessageSchema.parse({
        type: "event",
        cursor: 12,
        scope: projectScope,
        resource: "chat",
        action: "updated",
        entityId: "chat-1",
        revision: 3,
        payload: { status: "running" },
        occurredAt: "2026-08-09T12:00:00.000Z",
      }),
    ).toMatchObject({ resource: "chat", revision: 3 });
    expect(
      appLiveServerMessageSchema.parse({
        type: "error",
        requestId: "request-1",
        code: "unauthorized-scope",
        message: "The requested project is unavailable.",
        retryable: false,
      }).code,
    ).toBe("unauthorized-scope");
    expect(() =>
      appLiveServerMessageSchema.parse({
        type: "event",
        cursor: -1,
        scope: projectScope,
        resource: "chat",
        action: "updated",
        entityId: "chat-1",
        revision: null,
        payload: null,
        occurredAt: "not-a-date",
      }),
    ).toThrow();
  });

  it("bounds event payloads while allowing bounded agent terminal tails", () => {
    expect(appLiveEventPayloadSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(
      appLiveEventPayloadSchema.parse({ body: "x".repeat(256 * 1_024) }),
    ).toBeTruthy();
    expect(() =>
      appLiveEventPayloadSchema.parse({
        body: Array.from({ length: 4 }, () => '"'.repeat(100_000)),
      }),
    ).toThrow(/786432/);
  });

  it("round-trips typed client and server messages through the JSON codec", () => {
    const clientMessage = {
      type: "subscribe" as const,
      requestId: "request-codec",
      scopes: [projectScope],
    };
    const serverMessage = {
      type: "pong" as const,
      nonce: "nonce-codec",
      cursor: 7,
    };

    expect(
      decodeAppLiveClientMessage(encodeAppLiveClientMessage(clientMessage)),
    ).toEqual({ data: clientMessage, success: true });
    expect(
      decodeAppLiveServerMessage(encodeAppLiveServerMessage(serverMessage)),
    ).toEqual({ data: serverMessage, success: true });
  });

  it("distinguishes malformed JSON from a schema-invalid live message", () => {
    expect(decodeAppLiveClientMessage("{")).toEqual({
      reason: "invalid-json",
      success: false,
    });
    expect(decodeAppLiveClientMessage('{"type":"unknown"}')).toEqual({
      reason: "invalid-message",
      success: false,
      value: { type: "unknown" },
    });
  });
});
