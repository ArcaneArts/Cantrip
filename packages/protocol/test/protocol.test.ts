import { describe, expect, it } from "vitest";

import {
  codexAuthStatusSchema,
  codexDeviceLoginSchema,
  normalizeResponsesBaseUrl,
  serverBootstrapSchema,
  systemHealthSchema,
  terminalClientMessageSchema,
  terminalServerMessageSchema,
  workerCommandSchema,
  workerEventEnvelopeSchema,
  workerHeartbeatSchema,
} from "../src/index.js";

describe("Cantrip protocol", () => {
  it("accepts non-secret Codex account and device login state", () => {
    expect(
      codexAuthStatusSchema.parse({
        authenticated: true,
        authMode: "chatgpt",
        email: "user@example.com",
        planType: "plus",
        weeklyUsage: { usedPercent: 42, resetsAt: 1_786_665_600 },
      }).planType,
    ).toBe("plus");
    expect(
      codexDeviceLoginSchema.parse({
        loginId: "login-1",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
      }).userCode,
    ).toBe("ABCD-1234");
  });

  it("scopes Codex authentication commands to a provider", () => {
    expect(
      workerCommandSchema.parse({
        type: "codex.auth.status",
        providerId: "chatgpt-provider-1",
      }),
    ).toMatchObject({ providerId: "chatgpt-provider-1" });
    expect(
      workerCommandSchema.safeParse({ type: "codex.auth.status" }).success,
    ).toBe(false);
  });

  it("normalizes Responses provider URLs to their API root", () => {
    expect(
      normalizeResponsesBaseUrl(
        "https://openrouter.ai/api/v1/chat/completions",
      ),
    ).toBe("https://openrouter.ai/api/v1");
    expect(normalizeResponsesBaseUrl("https://openrouter.ai/api/v1/chat")).toBe(
      "https://openrouter.ai/api/v1",
    );
    expect(normalizeResponsesBaseUrl("https://openrouter.ai")).toBe(
      "https://openrouter.ai/api/v1",
    );
    expect(normalizeResponsesBaseUrl("http://127.0.0.1:11434/v1/")).toBe(
      "http://127.0.0.1:11434/v1",
    );
  });

  it("accepts a worker heartbeat", () => {
    const heartbeat = workerHeartbeatSchema.parse({
      architecture: "arm64",
      codexVersion: "codex-cli 1.0.0",
      name: "Local Worker",
      platform: "darwin",
      startedAt: "2026-08-07T12:00:00.000Z",
      workerId: "local-worker",
    });

    expect(heartbeat.workerId).toBe("local-worker");
  });

  it("rejects an unhealthy server payload", () => {
    const result = systemHealthSchema.safeParse({
      database: { engine: "sqlite", ready: true },
      service: "cantrip_server",
      status: "ok",
      timestamp: "2026-08-07T12:00:00.000Z",
      workers: { connected: 0 },
    });

    expect(result.success).toBe(false);
  });

  it("describes the local server boundary explicitly", () => {
    const bootstrap = serverBootstrapSchema.parse({
      protocolVersion: 1,
      server: {
        id: "server-id",
        deploymentMode: "local",
        bootstrapMode: "pnpm-dev",
      },
      auth: {
        mode: "none",
        currentUser: {
          id: "local-user",
          kind: "anonymous",
          displayName: "Local User",
          email: null,
        },
      },
      routing: {
        workerConnection: "server-only",
        directWorkerConnections: false,
      },
      storage: { conversations: "server", files: "worker" },
      agent: { model: "gemma4:26b", modelProvider: "ollama" },
      capabilities: {
        accounts: false,
        passwordProtection: false,
        linkCodes: false,
        multipleWorkers: false,
        workerSwitching: false,
        gitSync: false,
        worktrees: false,
      },
    });

    expect(bootstrap.auth.currentUser.kind).toBe("anonymous");
    expect(bootstrap.routing.directWorkerConnections).toBe(false);
    expect(bootstrap.storage).toEqual({
      conversations: "server",
      files: "worker",
    });
  });

  it("accepts correlated agent activity from a worker", () => {
    const event = workerEventEnvelopeSchema.parse({
      kind: "event",
      requestId: "request-1",
      event: {
        type: "agent.activity",
        activity: {
          type: "fileChange",
          id: "change-1",
          status: "completed",
          changes: [{ path: "src/App.tsx", kind: "update" }],
        },
      },
    });

    expect(event.event.activity.type).toBe("fileChange");
  });

  it("validates interactive terminal frames", () => {
    expect(
      terminalClientMessageSchema.parse({
        type: "resize",
        cols: 120,
        rows: 40,
      }),
    ).toEqual({ type: "resize", cols: 120, rows: 40 });
    expect(
      terminalServerMessageSchema.parse({
        type: "output",
        data: "\u001b[32mready\u001b[0m",
      }).type,
    ).toBe("output");
  });
});
