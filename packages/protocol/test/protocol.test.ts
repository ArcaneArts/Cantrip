import { describe, expect, it } from "vitest";

import {
  serverBootstrapSchema,
  systemHealthSchema,
  workerEventEnvelopeSchema,
  workerHeartbeatSchema,
} from "../src/index.js";

describe("Cantrip protocol", () => {
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
});
