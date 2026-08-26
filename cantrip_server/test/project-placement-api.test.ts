import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  browserWireSummarySchema,
  cantripCliCommandResultSchema,
  explorerWireSummarySchema,
  executionPlacementResolutionSchema,
  executionTargetWireCatalogSchema,
  executionTargetResolutionSchema,
  projectTabLayoutWireSummarySchema,
  protectedScriptCommandListSchema,
  serverBootstrapSchema,
  terminalWireSummarySchema,
  unprobedCodexRuntimeReport,
  workerLinkPeerMailboxSchema,
  workerLinkPeerSessionDescriptorSchema,
  workerLinkResourceGrantSchema,
  workerLinkSessionSchema,
  type WorkerCommand,
  type WorkerNotification,
} from "@cantrip/protocol";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { surfaceStreamOpaqueSchema } from "@cantrip/protocol/surface-stream";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import {
  ExecutionPlacementUnavailableError,
  LOCAL_USER_ID,
} from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

import { opaquePolicyCreate } from "./policy-encryption-fixture.js";
import {
  protectedChatFields,
  protectedBrowserFields,
  protectedBrowserRemoteSurfaceFields,
  protectedDisplayLabelFields,
  protectedExplorerFields,
  protectedProjectFields,
  protectedTerminalFields,
} from "./private-label-fixture.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-project-placement-api-"),
);
const workerLinkLaneLimit = {
  maxChannels: 64,
  maxQueuedFrames: 128,
  maxQueuedBytes: 4 * 1_024 * 1_024,
  maxBytesPerSecond: 16 * 1_024 * 1_024,
};
const config: ServerConfig = {
  agentModel: "gemma4:26b",
  agentModelProvider: "ollama",
  appOrigins: ["http://127.0.0.1:5173"],
  authMode: "none",
  bootstrapMode: "pnpm-dev",
  dataDirectory,
  deploymentMode: "local",
  host: "127.0.0.1",
  ollamaBaseUrl: "http://127.0.0.1:11434/v1",
  port: 4310,
  workerLinkPeer: {
    directRoutes: { local: true, lan: true, wan: true },
    relayOnly: false,
    stunUrls: ["stun:stun.cloudflare.com:3478"],
    interfacePolicy: { mode: "default", interfaces: [] },
    vpnPolicy: { defaultRoute: "wan", lanAllowlist: [] },
    negotiationTimeoutMs: 8_000,
    upgradeProbeTimeoutMs: 15_000,
    maxPeerSessionsPerClient: 4,
    maxPeerSessionsPerWorker: 32,
    invalidHandshakeRatePerMinute: 60,
    laneLimits: {
      events: workerLinkLaneLimit,
      interactive: workerLinkLaneLimit,
      stream: workerLinkLaneLimit,
      realtime: workerLinkLaneLimit,
      bulk: workerLinkLaneLimit,
    },
  },
  workerToken: "test-worker-token",
};

const connectedWorkers = new Set(["worker-alpha", "worker-beta"]);
const routedCommands: Array<{ workerId: string; command: WorkerCommand }> = [];
const workerNotificationListeners = new Map<
  string,
  Set<(notification: WorkerNotification) => Promise<void> | void>
>();
let resolvedServerId = "";
const protectedSurfacePayload = surfaceStreamOpaqueSchema.parse({
  formatVersion: 1,
  keyRevision: 1,
  envelope: {
    version: 1,
    algorithm: "AES-256-GCM",
    keyRevision: 1,
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
  },
});
const protectedRepositoryPayload = {
  formatVersion: 1 as const,
  keyRevision: 1,
  envelope: protectedSurfacePayload.envelope,
};
function protectedSurfaceArguments(target: string) {
  return {
    target,
    operationId: randomUUID(),
    sequence: 0,
    protectedRequest: protectedSurfacePayload,
  };
}
const workerBridge: WorkerCommandBus = {
  attach() {},
  close() {},
  isConnected(workerId) {
    return connectedWorkers.has(workerId);
  },
  sendSurfaceFrame() {
    return false;
  },
  subscribeWorkerDisconnect() {
    return () => undefined;
  },
  subscribeSurfaceFrames() {
    return () => undefined;
  },
  subscribeNotifications(workerId, listener) {
    const listeners = workerNotificationListeners.get(workerId) ?? new Set();
    listeners.add(listener);
    workerNotificationListeners.set(workerId, listeners);
    return () => listeners.delete(listener);
  },
  async request(workerId, command, options) {
    routedCommands.push({ workerId, command });
    switch (command.type) {
      case "worker-link.identity.resolve":
        return {
          serverId: resolvedServerId,
          ownerId: LOCAL_USER_ID,
          workerId,
          workerProcessGeneration: "worker-generation-1",
        };
      case "worker-link.session.install":
      case "worker-link.session.renew":
      case "worker-link.session.route":
      case "worker-link.session.revoke":
      case "worker-link.grant.install":
      case "worker-link.grant.renew":
      case "worker-link.grant.revoke":
      case "worker-link.peer.install":
      case "worker-link.peer.renew":
      case "worker-link.peer.revoke":
      case "worker-link.peer.signal":
        return { accepted: true };
      case "terminal.open":
        await options?.onEvent?.({ type: "terminal.ready" });
        return { status: "detached" };
      case "terminal.detach":
        return { status: "detached" };
      case "explorer.operation":
        return {
          operationId: command.operationId,
          sequence: command.sequence,
          protectedResponse: protectedSurfacePayload,
        };
      case "terminal.input":
      case "terminal.snapshot":
        return {
          operationId: command.operationId,
          sequence: command.sequence,
          protectedResponse: protectedSurfacePayload,
        };
      case "terminal.service.restart":
      case "surface.configure":
        return { accepted: true };
      case "worktree.status":
        return {
          worktree: {
            path: command.worktreePath,
            head: "1".repeat(40),
            branch: "main",
            detached: false,
            isPrimary: true,
            managed: true,
            locked: false,
            lockReason: null,
            prunable: false,
            pruneReason: null,
            missing: false,
          },
          status: {
            branch: "main",
            head: "1".repeat(40),
            upstream: "origin/main",
            ahead: 0,
            behind: 0,
            files: [],
            branches: [],
          },
        };
      case "browser.services.discover":
        return [
          {
            workerId,
            host: "127.0.0.1",
            port: 4_173,
            protocol: "http",
            url: "http://127.0.0.1:4173",
            title: "Preview",
            processName: "vite",
            statusCode: 200,
          },
        ];
      case "project.run-configuration-definitions.list":
        return {
          operation: "list",
          operationId: command.operationId,
          projectId: command.projectId,
          inventory: {
            directory: ".cantrip/run-configurations",
            entries: [],
            diagnostics: [],
          },
          validations: [],
        };
      case "project.script-commands.inspect":
        return protectedRepositoryPayload;
      default:
        throw new Error(`Unexpected placement command ${command.type}.`);
    }
  },
};

let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;
let projectId: string;
let alphaWorktreeId: string;
let betaWorktreeId: string;

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId: "worker-alpha",
    name: "Alpha",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: "0.146.1",
    codexRuntime: unprobedCodexRuntimeReport,
    code: {
      available: true,
      version: "1.109.5",
      upstreamRevision: "4ffe2270acdf711bbefecc3e8c79f4b3631640e5",
      patchset: 1,
      transport: "web-proxy",
      maxSessions: 4,
      reason: null,
    },
    remoteSurfaces: {
      browser: true,
      desktop: true,
      transports: ["websocket"],
      maxSessions: 4,
    },
    startedAt: new Date().toISOString(),
  });
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId: "worker-beta",
    name: "Beta",
    platform: "linux",
    architecture: "x64",
    codexVersion: "0.146.1",
    codexRuntime: unprobedCodexRuntimeReport,
    remoteSurfaces: {
      browser: false,
      desktop: false,
      transports: ["websocket"],
      maxSessions: 1,
    },
    startedAt: new Date().toISOString(),
  });
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId: "worker-alpha",
    ...protectedProjectFields(),
    repositoryBlindIndex: "A".repeat(43),
    repositoryId: "placement-api",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  });
  projectId = project.id;
  for (const workerId of ["worker-alpha", "worker-beta"]) {
    await database.repository.completeGithubProjectSetup(
      LOCAL_USER_ID,
      projectId,
      workerId,
      {
        path: path.join(dataDirectory, workerId),
        displayPath: `ArcaneArts/Cantrip (${workerId})`,
        reused: false,
        updated: false,
        warning: null,
      },
    );
  }
  const worktrees = await database.repository.listProjectWorktrees(
    LOCAL_USER_ID,
    projectId,
  );
  alphaWorktreeId = worktrees.find(
    ({ workerId }) => workerId === "worker-alpha",
  )!.id;
  betaWorktreeId = worktrees.find(
    ({ workerId }) => workerId === "worker-beta",
  )!.id;
  for (const worktree of worktrees) {
    await database.repository.recordProjectWorktreeStatus(
      LOCAL_USER_ID,
      projectId,
      worktree.id,
      {
        worktree: {
          path: worktree.path,
          head: "1".repeat(40),
          branch: "main",
          detached: false,
          isPrimary: true,
          managed: true,
          locked: false,
          lockReason: null,
          prunable: false,
          pruneReason: null,
          missing: false,
        },
        status: {
          branch: "main",
          head: "1".repeat(40),
          upstream: "origin/main",
          ahead: 0,
          behind: 0,
          files: [],
          branches: [],
        },
      },
    );
  }
  app = await buildApp({ config, database, logger: false, workerBridge });
  resolvedServerId = serverBootstrapSchema.parse(
    (await app.inject({ method: "GET", url: "/api/bootstrap" })).json(),
  ).server.id;
});

beforeEach(async () => {
  routedCommands.length = 0;
  connectedWorkers.clear();
  connectedWorkers.add("worker-alpha");
  connectedWorkers.add("worker-beta");
  await database.repository.updateSettings(LOCAL_USER_ID, {
    defaultWorkerId: "worker-alpha",
  });
  await database.repository.updateProjectPreferredWorker(
    LOCAL_USER_ID,
    projectId,
    "worker-beta",
  );
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("project execution placement API", () => {
  it("accepts authenticated bounded WorkerLink telemetry for current generations", async () => {
    const sessionResponse = await app.inject({
      method: "POST",
      url: "/api/workers/worker-alpha/worker-link/sessions",
      payload: { clientInstanceId: "telemetry-client-1" },
    });
    expect(sessionResponse.statusCode).toBe(201);
    const session = workerLinkSessionSchema.parse(sessionResponse.json());
    const payload = {
      routeGeneration: session.routeGeneration,
      samples: [
        {
          occurredAt: "2026-08-26T12:00:00.000Z",
          event: "route-selected",
          route: "local",
          lane: null,
          value: 1,
          latencyMs: 7,
          reason: "none",
        },
      ],
    };

    const accepted = await app.inject({
      method: "POST",
      url: `/api/worker-links/${session.sessionId}/telemetry`,
      payload,
    });
    expect(accepted.statusCode).toBe(204);
    const future = await app.inject({
      method: "POST",
      url: `/api/worker-links/${session.sessionId}/telemetry`,
      payload: { ...payload, routeGeneration: session.routeGeneration + 1 },
    });
    expect(future.statusCode).toBe(409);
    const invalid = await app.inject({
      method: "POST",
      url: `/api/worker-links/${session.sessionId}/telemetry`,
      payload: { ...payload, samples: [] },
    });
    expect(invalid.statusCode).toBe(400);

    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain(
      'cantrip_worker_link_events_total{event="route-selected",route="local",lane="none",reason="none"} 1',
    );
    expect(metrics.body).not.toContain(session.sessionId);
    expect(metrics.body).not.toContain("telemetry-client-1");
  });

  it("authorizes bounded peer signaling and an exact worker mailbox", async () => {
    const sessionResponse = await app.inject({
      method: "POST",
      url: "/api/workers/worker-alpha/worker-link/sessions",
      payload: { clientInstanceId: "peer-client-1" },
    });
    expect(sessionResponse.statusCode).toBe(201);
    const session = workerLinkSessionSchema.parse(sessionResponse.json());
    const peerResponse = await app.inject({
      method: "POST",
      url: `/api/worker-links/${session.sessionId}/peers`,
      payload: { route: "lan", routeGeneration: session.routeGeneration },
    });
    expect(peerResponse.statusCode).toBe(201);
    const peerDescriptor = workerLinkPeerSessionDescriptorSchema.parse(
      peerResponse.json(),
    );
    const peer = peerDescriptor.peerSession;
    expect(routedCommands).toContainEqual({
      workerId: "worker-alpha",
      command: expect.objectContaining({
        type: "worker-link.peer.install",
        peerSession: peer,
      }),
    });

    const offered = await app.inject({
      method: "POST",
      url: `/api/worker-links/${session.sessionId}/peers/${peer.peerSessionId}/signals`,
      payload: {
        signals: [
          {
            peerSessionId: peer.peerSessionId,
            sessionId: session.sessionId,
            routeGeneration: peer.routeGeneration,
            route: peer.route,
            sender: "client",
            signalSequence: 0,
            signal: { type: "offer", sdp: "offer-sdp" },
          },
        ],
      },
    });
    expect(offered.statusCode).toBe(204);
    expect(routedCommands).toContainEqual({
      workerId: "worker-alpha",
      command: expect.objectContaining({
        type: "worker-link.peer.signal",
        envelope: expect.objectContaining({ sender: "client" }),
      }),
    });

    const answer: WorkerNotification = {
      type: "worker-link.peer.signal",
      envelope: {
        peerSessionId: peer.peerSessionId,
        sessionId: session.sessionId,
        routeGeneration: peer.routeGeneration,
        route: peer.route,
        sender: "worker",
        signalSequence: 0,
        signal: { type: "answer", sdp: "answer-sdp" },
      },
    };
    await Promise.all(
      [...(workerNotificationListeners.get("worker-alpha") ?? [])].map(
        (listener) => listener(answer),
      ),
    );
    const mailboxResponse = await app.inject({
      method: "POST",
      url: `/api/worker-links/${session.sessionId}/peers/${peer.peerSessionId}/mailbox`,
      payload: {},
    });
    expect(mailboxResponse.statusCode).toBe(200);
    expect(
      workerLinkPeerMailboxSchema.parse(mailboxResponse.json()),
    ).toMatchObject({
      peerSessionId: peer.peerSessionId,
      signals: [
        expect.objectContaining({
          sender: "worker",
          signal: { type: "answer", sdp: "answer-sdp" },
        }),
      ],
    });

    const spoofed = await app.inject({
      method: "POST",
      url: `/api/worker-links/${session.sessionId}/peers/${peer.peerSessionId}/signals`,
      payload: {
        signals: [
          {
            ...answer.envelope,
            sender: "worker",
            signalSequence: 1,
          },
        ],
      },
    });
    expect(spoofed.statusCode).toBe(400);
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/worker-links/${session.sessionId}/peers/${peer.peerSessionId}`,
    });
    expect(removed.statusCode).toBe(204);
    expect(routedCommands).toContainEqual({
      workerId: "worker-alpha",
      command: expect.objectContaining({
        type: "worker-link.peer.revoke",
        peerSessionId: peer.peerSessionId,
      }),
    });
  });

  it("authorizes a Terminal WorkerLink grant without relaying PTY output", async () => {
    const terminalCreated = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/terminals`,
      payload: {
        ...protectedTerminalFields(),
        target: {
          kind: "worktree",
          projectId,
          worktreeId: alphaWorktreeId,
        },
      },
    });
    expect(terminalCreated.statusCode).toBe(201);
    const terminal = terminalWireSummarySchema.parse(terminalCreated.json());
    const sessionResponse = await app.inject({
      method: "POST",
      url: "/api/workers/worker-alpha/worker-link/sessions",
      payload: { clientInstanceId: "terminal-client-1" },
    });
    expect(sessionResponse.statusCode).toBe(201);
    const session = workerLinkSessionSchema.parse(sessionResponse.json());
    const operationId = randomUUID();

    const grantResponse = await app.inject({
      method: "POST",
      url: `/api/worker-links/${session.sessionId}/terminals/${terminal.id}/grant`,
      payload: { operationId },
    });
    expect(grantResponse.statusCode).toBe(201);
    const grant = workerLinkResourceGrantSchema.parse(grantResponse.json());
    expect(grant.binding).toMatchObject({
      sessionId: session.sessionId,
      resource: {
        kind: "terminal",
        resourceId: terminal.id,
        attachmentId: operationId,
      },
      lanes: ["interactive"],
      maxChannels: 1,
    });
    expect(routedCommands).toContainEqual(
      expect.objectContaining({
        workerId: "worker-alpha",
        command: expect.objectContaining({
          type: "terminal.open",
          terminalId: terminal.id,
          outputMode: "discard",
        }),
      }),
    );
    expect(routedCommands).toContainEqual(
      expect.objectContaining({
        workerId: "worker-alpha",
        command: expect.objectContaining({
          type: "worker-link.grant.install",
          sessionId: session.sessionId,
        }),
      }),
    );

    const renewed = await app.inject({
      method: "POST",
      url: `/api/worker-links/${session.sessionId}/grants/${grant.binding.grantId}/renew`,
      payload: {},
    });
    expect(renewed.statusCode).toBe(200);
    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/worker-links/${session.sessionId}/grants/${grant.binding.grantId}`,
    });
    expect(revoked.statusCode).toBe(204);
  });

  it("serializes logical branch mutation across worker replicas", async () => {
    const alphaChat = await database.repository.createChat(
      LOCAL_USER_ID,
      projectId,
      {
        ...protectedChatFields(),
        worktreeId: alphaWorktreeId,
        worktreeMode: "pinned",
      },
    );
    const betaChat = await database.repository.createChat(
      LOCAL_USER_ID,
      projectId,
      {
        ...protectedChatFields(),
        worktreeId: betaWorktreeId,
        worktreeMode: "pinned",
      },
    );
    expect(alphaChat).not.toBeNull();
    expect(betaChat).not.toBeNull();

    const alphaLane = await database.repository.startChatExecutionLane(
      LOCAL_USER_ID,
      alphaChat!.id,
      "agent",
      "Mutate main on Alpha",
    );
    expect(alphaLane).toMatchObject({
      workerId: "worker-alpha",
      worktreeId: alphaWorktreeId,
    });
    await expect(
      database.repository.startChatExecutionLane(
        LOCAL_USER_ID,
        betaChat!.id,
        "agent",
        "Mutate main on Beta",
      ),
    ).rejects.toThrow(/Logical branch main is already leased/u);

    await database.repository.finishChatExecutionLane(
      alphaChat!.id,
      alphaLane!.executionLaneId,
      "idle",
    );
    const betaLane = await database.repository.startChatExecutionLane(
      LOCAL_USER_ID,
      betaChat!.id,
      "agent",
      "Mutate main after Alpha",
    );
    expect(betaLane).toMatchObject({
      workerId: "worker-beta",
      worktreeId: betaWorktreeId,
    });
    await database.repository.finishChatExecutionLane(
      betaChat!.id,
      betaLane!.executionLaneId,
      "idle",
    );
  });

  it("uses project preference, global default, then a stable compatible fallback", async () => {
    const terminal = await database.repository.resolveProjectExecutionPlacement(
      LOCAL_USER_ID,
      projectId,
      "terminal",
      undefined,
      workerBridge.isConnected.bind(workerBridge),
    );
    expect(terminal).toMatchObject({
      selection: "project-preference",
      placement: {
        workerId: "worker-beta",
        worktreeId: betaWorktreeId,
      },
    });

    const code = await database.repository.resolveProjectExecutionPlacement(
      LOCAL_USER_ID,
      projectId,
      "code",
      undefined,
      workerBridge.isConnected.bind(workerBridge),
    );
    expect(code).toMatchObject({
      selection: "default-worker",
      placement: {
        workerId: "worker-alpha",
        worktreeId: alphaWorktreeId,
      },
    });

    await database.repository.updateSettings(LOCAL_USER_ID, {
      defaultWorkerId: null,
    });
    await database.repository.updateProjectPreferredWorker(
      LOCAL_USER_ID,
      projectId,
      null,
    );
    expect(
      await database.repository.resolveProjectExecutionPlacement(
        LOCAL_USER_ID,
        projectId,
        "explorer",
        undefined,
        workerBridge.isConnected.bind(workerBridge),
      ),
    ).toMatchObject({
      selection: "fallback",
      placement: { workerId: "worker-alpha" },
    });
  });

  it("trusts a live worker connection when its persisted heartbeat is stale", async () => {
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);

    try {
      expect(
        await database.repository.resolveProjectExecutionPlacement(
          LOCAL_USER_ID,
          projectId,
          "code",
          undefined,
          workerBridge.isConnected.bind(workerBridge),
        ),
      ).toMatchObject({
        selection: "default-worker",
        placement: {
          workerId: "worker-alpha",
          worktreeId: alphaWorktreeId,
        },
      });

      await expect(
        database.repository.resolveProjectExecutionPlacement(
          LOCAL_USER_ID,
          projectId,
          "code",
        ),
      ).rejects.toMatchObject<Partial<ExecutionPlacementUnavailableError>>({
        code: "no-compatible-placement",
      });
    } finally {
      dateNow.mockRestore();
    }
  });

  it("creates a Browser target on the current CLI placement when none exists", async () => {
    const request = async (
      command: "target.resolve-browser" | "browser.create",
      arguments_: Record<string, unknown>,
    ) =>
      app.inject({
        method: "POST",
        url: "/api/internal/cli",
        headers: { authorization: `Bearer ${config.workerToken}` },
        payload: {
          command,
          chatContext: null,
          context: {
            codexThreadId: null,
            terminalId: null,
            cwd: path.join(dataDirectory, "worker-alpha"),
          },
          arguments: arguments_,
          requestId: `cli-${command}`,
          workerId: "worker-alpha",
        },
      });

    const resolution = await request("target.resolve-browser", {});
    expect(resolution.statusCode, JSON.stringify(resolution.json())).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(resolution.json()),
    ).toMatchObject({
      target: {
        kind: "worktree",
        projectId,
        worktreeId: alphaWorktreeId,
      },
      data: { stateRevision: null },
    });

    const fields = protectedBrowserFields();
    const created = await request("browser.create", {
      ...fields,
    });
    expect(created.statusCode, JSON.stringify(created.json())).toBe(200);
    const result = cantripCliCommandResultSchema.parse(created.json());
    expect(result).toMatchObject({
      summary: expect.stringContaining("Opened a new Browser tab."),
      target: {
        kind: "surface",
        projectId,
        surfaceKind: "browser",
        surfaceId: fields.id,
      },
      mutated: true,
      data: { workerId: "worker-alpha", stateRevision: 1 },
    });
    expect(
      await database.repository.deleteBrowser(LOCAL_USER_ID, fields.id),
    ).toBe(true);
  });

  it("honors explicit worktrees and never silently moves an invalid target", async () => {
    expect(
      await database.repository.resolveProjectExecutionPlacement(
        LOCAL_USER_ID,
        projectId,
        "terminal",
        { kind: "worktree", projectId, worktreeId: alphaWorktreeId },
        workerBridge.isConnected.bind(workerBridge),
      ),
    ).toMatchObject({
      selection: "explicit",
      placement: {
        workerId: "worker-alpha",
        worktreeId: alphaWorktreeId,
      },
    });

    connectedWorkers.delete("worker-beta");
    await expect(
      database.repository.resolveProjectExecutionPlacement(
        LOCAL_USER_ID,
        projectId,
        "terminal",
        { kind: "worker", projectId, workerId: "worker-beta" },
        workerBridge.isConnected.bind(workerBridge),
      ),
    ).rejects.toMatchObject<Partial<ExecutionPlacementUnavailableError>>({
      code: "worker-offline",
    });
    await expect(
      database.repository.resolveProjectExecutionPlacement(
        LOCAL_USER_ID,
        projectId,
        "browser",
        { kind: "worker", projectId, workerId: "worker-beta" },
        workerBridge.isConnected.bind(workerBridge),
      ),
    ).rejects.toMatchObject<Partial<ExecutionPlacementUnavailableError>>({
      code: "worker-offline",
    });
  });

  it("discovers project scripts on the selected worktree worker", async () => {
    const operationId = randomUUID();
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/script-commands?worktreeId=${betaWorktreeId}&operationId=${operationId}`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(
      protectedScriptCommandListSchema.parse(response.json()),
    ).toMatchObject({ operationId, projectId, worktreeId: betaWorktreeId });
    expect(routedCommands.at(-1)).toMatchObject({
      workerId: "worker-beta",
      command: {
        type: "project.script-commands.inspect",
        sourcePath: path.join(dataDirectory, "worker-beta"),
      },
    });
  });

  it("exposes structured resolution failures and persists surface ownership", async () => {
    const resolved = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/placement/resolve`,
      payload: {
        surfaceKind: "terminal",
        target: {
          kind: "worktree",
          projectId,
          worktreeId: alphaWorktreeId,
        },
      },
    });
    expect(resolved.statusCode).toBe(200);
    expect(
      executionPlacementResolutionSchema.parse(resolved.json()),
    ).toMatchObject({
      selection: "explicit",
      placement: { workerId: "worker-alpha" },
    });

    connectedWorkers.delete("worker-beta");
    const unavailable = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/placement/resolve`,
      payload: {
        surfaceKind: "terminal",
        target: { kind: "worker", projectId, workerId: "worker-beta" },
      },
    });
    expect(unavailable.statusCode).toBe(409);
    expect(unavailable.json()).toMatchObject({ code: "worker-offline" });
    connectedWorkers.add("worker-beta");

    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/browsers`,
      payload: {
        ...protectedBrowserFields(),
        target: { kind: "worker", projectId, workerId: "worker-alpha" },
      },
    });
    expect(created.statusCode).toBe(201);
    const createdBrowser = browserWireSummarySchema.parse(created.json());
    expect(createdBrowser).toMatchObject({
      workerId: "worker-alpha",
    });
    const staleBrowserUpdate = await app.inject({
      method: "PATCH",
      url: `/api/browsers/${createdBrowser.id}`,
      payload: {
        expectedStateRevision: createdBrowser.stateRevision + 1,
        stateProtection: protectedBrowserFields(createdBrowser.id)
          .stateProtection,
      },
    });
    expect(staleBrowserUpdate.statusCode).toBe(409);
    expect(staleBrowserUpdate.json()).toMatchObject({ code: "stale-state" });

    const terminalCreated = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/terminals`,
      payload: {
        ...protectedTerminalFields(),
        target: {
          kind: "worktree",
          projectId,
          worktreeId: alphaWorktreeId,
        },
      },
    });
    expect(terminalCreated.statusCode).toBe(201);
    const terminal = terminalWireSummarySchema.parse(terminalCreated.json());

    const resolvedTarget = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/execution-targets/resolve`,
      payload: {
        target: {
          kind: "surface",
          projectId,
          surfaceKind: "terminal",
          surfaceId: terminal.id,
        },
      },
    });
    expect(resolvedTarget.statusCode).toBe(200);
    expect(
      executionTargetResolutionSchema.parse(resolvedTarget.json()),
    ).toMatchObject({
      availability: "available",
      placement: {
        workerId: "worker-alpha",
        worktreeId: alphaWorktreeId,
        surface: { kind: "terminal", id: terminal.id },
      },
    });

    const catalogResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/execution-targets`,
    });
    expect(catalogResponse.statusCode).toBe(200);
    const catalog = executionTargetWireCatalogSchema.parse(
      catalogResponse.json(),
    );
    expect(catalog.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceKind: "terminal",
          title: null,
          titleProtection: expect.objectContaining({
            classification: { recordKind: "terminal" },
          }),
          placement: expect.objectContaining({ workerId: "worker-alpha" }),
        }),
        expect.objectContaining({
          resourceKind: "browser",
          title: null,
          titleProtection: expect.objectContaining({
            classification: { recordKind: "browser" },
          }),
          placement: expect.objectContaining({ workerId: "worker-alpha" }),
        }),
        expect.objectContaining({
          resourceKind: "worker",
          title: "Alpha",
        }),
        expect.objectContaining({
          resourceKind: "worker",
          title: "Beta",
        }),
      ]),
    );

    connectedWorkers.delete("worker-alpha");
    const offline = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/execution-targets/resolve`,
      payload: {
        target: {
          kind: "surface",
          projectId,
          surfaceKind: "terminal",
          surfaceId: terminal.id,
        },
      },
    });
    expect(offline.statusCode).toBe(409);
    expect(offline.json()).toMatchObject({ code: "worker-offline" });
    const offlineVisible = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/execution-targets/resolve`,
      payload: {
        allowUnavailable: true,
        target: {
          kind: "surface",
          projectId,
          surfaceKind: "terminal",
          surfaceId: terminal.id,
        },
      },
    });
    expect(offlineVisible.statusCode).toBe(200);
    expect(
      executionTargetResolutionSchema.parse(offlineVisible.json()),
    ).toMatchObject({
      availability: "worker-offline",
      worker: { workerId: "worker-alpha", online: false },
    });
    connectedWorkers.add("worker-alpha");

    const wrongProject = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/execution-targets/resolve`,
      payload: {
        target: {
          kind: "surface",
          projectId: "another-project",
          surfaceKind: "terminal",
          surfaceId: terminal.id,
        },
      },
    });
    expect(wrongProject.statusCode).toBe(409);
    expect(wrongProject.json()).toMatchObject({ code: "target-mismatch" });

    const wrongSurfaceKind = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/execution-targets/resolve`,
      payload: {
        target: {
          kind: "surface",
          projectId,
          surfaceKind: "explorer",
          surfaceId: terminal.id,
        },
      },
    });
    expect(wrongSurfaceKind.statusCode).toBe(409);
    expect(wrongSurfaceKind.json()).toMatchObject({ code: "target-not-found" });

    const unsupportedBrowser = await database.repository.createRemoteSurface(
      LOCAL_USER_ID,
      projectId,
      {
        ...protectedBrowserRemoteSurfaceFields(),
        workerId: "worker-beta",
        configuration: {
          kind: "browser",
          profileId: null,
        },
      },
    );
    expect(unsupportedBrowser).not.toBeNull();
    await expect(
      database.repository.resolveExecutionTarget(
        LOCAL_USER_ID,
        projectId,
        {
          kind: "surface",
          projectId,
          surfaceKind: "remote-surface",
          surfaceId: unsupportedBrowser!.id,
        },
        workerBridge.isConnected.bind(workerBridge),
      ),
    ).rejects.toMatchObject<Partial<ExecutionPlacementUnavailableError>>({
      code: "capability-unavailable",
    });
    expect(
      await database.repository.resolveExecutionTarget(
        LOCAL_USER_ID,
        projectId,
        {
          kind: "surface",
          projectId,
          surfaceKind: "remote-surface",
          surfaceId: unsupportedBrowser!.id,
        },
        workerBridge.isConnected.bind(workerBridge),
        true,
      ),
    ).toMatchObject({ availability: "capability-unavailable" });
  });

  it("routes CLI operations to exact cross-worker targets", async () => {
    await database.repository.recordWorker(LOCAL_USER_ID, {
      workerId: "worker-beta",
      name: "Beta",
      platform: "linux",
      architecture: "x64",
      codexVersion: "0.146.1",
      codexRuntime: unprobedCodexRuntimeReport,
      remoteSurfaces: {
        browser: true,
        desktop: false,
        transports: ["websocket"],
        maxSessions: 4,
      },
      startedAt: new Date().toISOString(),
    });
    const explorer = explorerWireSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/explorers`,
          payload: {
            ...protectedExplorerFields(),
            fileMode: "edit",
            target: {
              kind: "worktree",
              projectId,
              worktreeId: betaWorktreeId,
            },
          },
        })
      ).json(),
    );
    expect(explorer.fileMode).toBe("edit");
    const terminal = terminalWireSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/terminals`,
          payload: {
            ...protectedTerminalFields(),
            target: {
              kind: "worktree",
              projectId,
              worktreeId: betaWorktreeId,
            },
          },
        })
      ).json(),
    );
    const browser = browserWireSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/browsers`,
          payload: {
            ...protectedBrowserFields(),
            target: { kind: "worker", projectId, workerId: "worker-beta" },
          },
        })
      ).json(),
    );
    const chat = await database.repository.createChat(
      LOCAL_USER_ID,
      projectId,
      {
        ...protectedChatFields(),
        worktreeId: alphaWorktreeId,
        worktreeMode: "pinned",
      },
    );
    expect(chat).not.toBeNull();
    const lane = await database.repository.startChatExecutionLane(
      LOCAL_USER_ID,
      chat!.id,
      "agent",
      "Read cross-worker targets",
    );
    expect(lane).not.toBeNull();
    const cli = (
      command:
        | "status"
        | "policy.list"
        | "policy.read"
        | "run.list"
        | "target.list"
        | "target.show"
        | "explorer.list"
        | "explorer.read"
        | "explorer.write"
        | "terminal.read"
        | "terminal.send"
        | "terminal.restart"
        | "browser.services"
        | "browser.open"
        | "worktree.create"
        | "worktree.status"
        | "worktree.switch",
      arguments_: Record<string, unknown> = {},
      fromChat = false,
      invokingWorkerId: "worker-alpha" | "worker-beta" = "worker-alpha",
    ) =>
      app.inject({
        method: "POST",
        url: "/api/internal/cli",
        headers: { authorization: `Bearer ${config.workerToken}` },
        payload: {
          command,
          chatContext: fromChat
            ? {
                chatId: chat!.id,
                executionLaneId: lane!.executionLaneId,
              }
            : null,
          context: {
            codexThreadId: null,
            terminalId: null,
            cwd: path.join(dataDirectory, invokingWorkerId),
          },
          arguments: arguments_,
          requestId: command.startsWith("run.")
            ? randomUUID()
            : invokingWorkerId === "worker-alpha"
              ? `cli-${command}`
              : `cli-worker-beta-${command}`,
          workerId: invokingWorkerId,
        },
      });

    const cliStatus = await cli("status");
    expect(cliStatus.statusCode).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(cliStatus.json()).data,
    ).toMatchObject({
      worker: { id: "worker-alpha", online: true },
      context: { projectId, worktreeId: alphaWorktreeId },
    });
    const hiddenPolicy = await database.repository.policies.create(
      LOCAL_USER_ID,
      opaquePolicyCreate("hidden-project-policy"),
    );
    const visiblePolicy = await database.repository.policies.create(
      LOCAL_USER_ID,
      opaquePolicyCreate("visible-project-policy", { mandatory: true }),
    );
    const policyOrder = await database.repository.policies.list(LOCAL_USER_ID);
    await database.repository.policies.reorder(LOCAL_USER_ID, {
      collectionVersion: policyOrder.collectionVersion,
      policyIds: [
        visiblePolicy.id,
        hiddenPolicy.id,
        ...policyOrder.policies
          .filter(({ id }) => id !== visiblePolicy.id && id !== hiddenPolicy.id)
          .map(({ id }) => id),
      ],
    });
    const cliPolicies = await cli("policy.list");
    expect(cliPolicies.statusCode).toBe(200);
    const listedPolicies = cantripCliCommandResultSchema.parse(
      cliPolicies.json(),
    ).data as { policies: Array<{ id: string }> };
    expect(listedPolicies.policies.map(({ id }) => id)).toEqual([
      visiblePolicy.id,
    ]);
    expect(listedPolicies.policies[0]).toMatchObject({
      mandatory: true,
      sources: [{ type: "mandatory" }],
    });
    expect(listedPolicies.policies[0]).toHaveProperty("protectedSummary");
    expect(listedPolicies.policies[0]).not.toHaveProperty("summary");
    const cliPolicy = await cli("policy.read", {
      policyId: visiblePolicy.id,
    });
    expect(cliPolicy.statusCode).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(cliPolicy.json()).data,
    ).toMatchObject({
      policy: {
        id: visiblePolicy.id,
        content: {
          protectedSummary: expect.any(Object),
          protectedBody: expect.any(Object),
        },
      },
    });
    const replacement = opaquePolicyCreate("updated-visible-policy");
    await database.repository.policies.update(LOCAL_USER_ID, visiblePolicy.id, {
      rowVersion: visiblePolicy.rowVersion,
      content: {
        protectedSummary: replacement.content.protectedSummary,
        protectedBody: replacement.content.protectedBody,
      },
    });
    const updatedCliPolicy = await cli("policy.read", {
      policyId: visiblePolicy.id,
    });
    expect(
      cantripCliCommandResultSchema.parse(updatedCliPolicy.json()).data,
    ).toMatchObject({
      policy: {
        content: {
          protectedBody: replacement.content.protectedBody,
        },
      },
    });
    const cliRunList = await cli("run.list");
    expect(cliRunList.statusCode).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(cliRunList.json()).data,
    ).toMatchObject({
      operation: "list",
      projectId,
      inventory: { entries: [] },
    });
    expect(routedCommands).toContainEqual(
      expect.objectContaining({
        workerId: "worker-alpha",
        command: expect.objectContaining({
          type: "project.run-configuration-definitions.list",
          sourcePath: path.join(dataDirectory, "worker-alpha"),
        }),
      }),
    );
    const betaRunList = await cli("run.list", {}, false, "worker-beta");
    expect(betaRunList.statusCode).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(betaRunList.json()).data,
    ).toMatchObject({ projectId, inventory: { entries: [] } });
    expect(routedCommands).toContainEqual(
      expect.objectContaining({
        workerId: "worker-alpha",
        command: expect.objectContaining({
          type: "project.run-configuration-definitions.list",
          sourcePath: path.join(dataDirectory, "worker-alpha"),
        }),
      }),
    );
    const hiddenPolicyRead = await cli("policy.read", {
      policyId: hiddenPolicy.id,
    });
    expect(hiddenPolicyRead.statusCode).toBe(404);
    const cliCurrentTarget = await cli("target.show");
    expect(cliCurrentTarget.statusCode).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(cliCurrentTarget.json()),
    ).toMatchObject({
      target: { kind: "worktree", worktreeId: alphaWorktreeId },
    });
    const cliTargets = await cli("target.list", { kind: "terminal" });
    expect(cliTargets.statusCode).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(cliTargets.json()).data,
    ).toMatchObject({
      targets: expect.arrayContaining([
        expect.objectContaining({
          title: null,
          titleProtection: expect.objectContaining({
            classification: { recordKind: "terminal" },
          }),
        }),
      ]),
    });
    const cliTerminal = await cli("terminal.read", {
      ...protectedSurfaceArguments(terminal.id),
    });
    expect(cliTerminal.statusCode, JSON.stringify(cliTerminal.json())).toBe(
      200,
    );
    expect(
      cantripCliCommandResultSchema.parse(cliTerminal.json()).data,
    ).toMatchObject({ protectedResponse: protectedSurfacePayload });
    const cliExplorerList = await cli("explorer.list", {
      ...protectedSurfaceArguments(explorer.id),
    });
    expect(cliExplorerList.statusCode).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(cliExplorerList.json()).data,
    ).toMatchObject({ protectedResponse: protectedSurfacePayload });
    const cliExplorerRead = await cli("explorer.read", {
      ...protectedSurfaceArguments(explorer.id),
    });
    expect(cliExplorerRead.statusCode).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(cliExplorerRead.json()).data,
    ).toMatchObject({ protectedResponse: protectedSurfacePayload });
    const cliBrowserServices = await cli("browser.services", {
      target: browser.id,
    });
    expect(cliBrowserServices.statusCode).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(cliBrowserServices.json()).data,
    ).toEqual([
      expect.objectContaining({ workerId: "worker-beta", port: 4_173 }),
    ]);
    const cliWorktreeStatus = await cli("worktree.status", {
      worktree: betaWorktreeId,
    });
    expect(cliWorktreeStatus.statusCode).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(cliWorktreeStatus.json()),
    ).toMatchObject({ worktreeId: betaWorktreeId });
    expect(routedCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workerId: "worker-beta",
          command: expect.objectContaining({ type: "explorer.operation" }),
        }),
        expect.objectContaining({
          workerId: "worker-beta",
          command: expect.objectContaining({ type: "terminal.snapshot" }),
        }),
        expect.objectContaining({
          workerId: "worker-beta",
          command: expect.objectContaining({
            type: "browser.services.discover",
          }),
        }),
      ]),
    );
    const worktreesBeforeRejectedSwitch =
      await database.repository.listProjectWorktrees(LOCAL_USER_ID, projectId);
    const rejectedTerminalSwitch = await cli("worktree.create", {
      name: "Must not be created",
      intent: "newBranch",
      switch: true,
    });
    expect(rejectedTerminalSwitch.statusCode).toBe(409);
    expect(rejectedTerminalSwitch.json()).toMatchObject({ code: "conflict" });
    expect(
      await database.repository.listProjectWorktrees(LOCAL_USER_ID, projectId),
    ).toHaveLength(worktreesBeforeRejectedSwitch.length);

    await database.repository.updateTerminalService(
      LOCAL_USER_ID,
      terminal.id,
      {
        enabled: true,
        stateProtection: protectedTerminalFields(terminal.id).stateProtection,
      },
    );
    const cliWrite = await cli("explorer.write", {
      ...protectedSurfaceArguments(explorer.id),
    });
    expect(cliWrite.statusCode).toBe(200);
    expect(cantripCliCommandResultSchema.parse(cliWrite.json())).toMatchObject({
      target: {
        kind: "surface",
        surfaceKind: "explorer",
        surfaceId: explorer.id,
      },
      mutated: true,
      data: { protectedResponse: protectedSurfacePayload },
    });
    const cliInput = await cli("terminal.send", {
      ...protectedSurfaceArguments(terminal.id),
    });
    expect(cliInput.statusCode).toBe(200);
    expect(cantripCliCommandResultSchema.parse(cliInput.json()).mutated).toBe(
      true,
    );
    const cliRestart = await cli("terminal.restart", {
      target: terminal.id,
    });
    expect(cliRestart.statusCode).toBe(200);
    const cliNavigate = await cli("browser.open", {
      target: browser.id,
      expectedStateRevision: browser.stateRevision,
      stateProtection: protectedBrowserFields(browser.id).stateProtection,
    });
    expect(cliNavigate.statusCode).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(cliNavigate.json()),
    ).toMatchObject({
      target: {
        kind: "surface",
        surfaceKind: "browser",
        surfaceId: browser.id,
      },
      mutated: true,
      data: { stateRevision: browser.stateRevision + 1 },
    });
    expect(JSON.stringify(cliNavigate.json())).not.toContain("from-cli");
    expect(routedCommands).toEqual(
      expect.arrayContaining([
        {
          workerId: "worker-beta",
          command: expect.objectContaining({
            type: "explorer.operation",
            protectedRequest: protectedSurfacePayload,
          }),
        },
        {
          workerId: "worker-beta",
          command: expect.objectContaining({
            type: "terminal.input",
            terminalId: terminal.id,
            protectedData: protectedSurfacePayload,
          }),
        },
        {
          workerId: "worker-beta",
          command: expect.objectContaining({
            type: "terminal.service.restart",
            terminalId: terminal.id,
          }),
        },
      ]),
    );
    const mutationAudits = await database.repository.listAuditEvents(
      { limit: 100 },
      LOCAL_USER_ID,
    );
    expect(mutationAudits.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "cli.command.mutated",
          result: "succeeded",
          resource: { type: "cli-command", id: "cli-explorer.write" },
        }),
        expect.objectContaining({
          action: "cli.command.mutated",
          result: "succeeded",
          resource: { type: "cli-command", id: "cli-browser.open" },
        }),
      ]),
    );

    const unauthorizedCli = await app.inject({
      method: "POST",
      url: "/api/internal/cli",
      payload: {
        command: "status",
        context: { codexThreadId: null, terminalId: null, cwd: null },
        arguments: {},
        requestId: "unauthorized-cli",
        workerId: "worker-alpha",
      },
    });
    expect(unauthorizedCli.statusCode).toBe(401);

    for (const obsoletePath of [
      "/api/internal/agent-tools/worktree",
      "/api/internal/agent-tools/execution",
    ]) {
      const removed = await app.inject({
        method: "POST",
        url: obsoletePath,
        headers: { authorization: `Bearer ${config.workerToken}` },
        payload: {},
      });
      expect(removed.statusCode).toBe(404);
    }

    await database.repository.finishChatExecutionLane(
      chat!.id,
      lane!.executionLaneId,
      "idle",
    );
    const stale = await cli(
      "worktree.switch",
      { worktree: betaWorktreeId },
      true,
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toContain("active chat lane");
  });

  it("atomically promotes an existing sidebar Explorer into the tab layout", async () => {
    const sidebarFields = protectedExplorerFields();
    const sidebarResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/explorers`,
      payload: {
        ...sidebarFields,
        attachToTabLayout: false,
        target: {
          kind: "worktree",
          projectId,
          worktreeId: alphaWorktreeId,
        },
      },
    });
    expect(sidebarResponse.statusCode, sidebarResponse.body).toBe(201);
    const sidebar = explorerWireSummarySchema.parse(sidebarResponse.json());

    const anchorResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/explorers`,
      payload: {
        ...protectedExplorerFields(),
        target: {
          kind: "worktree",
          projectId,
          worktreeId: alphaWorktreeId,
        },
      },
    });
    expect(anchorResponse.statusCode, anchorResponse.body).toBe(201);
    const anchor = explorerWireSummarySchema.parse(anchorResponse.json());
    let layout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/tab-groups`,
        })
      ).json(),
    );
    const groupId = layout.groups.find(({ members }) =>
      members.some(({ tabId }) => tabId === anchor.id),
    )!.id;
    expect(
      layout.groups
        .flatMap(({ members }) => members)
        .some(({ tabId }) => tabId === sidebar.id),
    ).toBe(false);

    const pinnedFields = protectedExplorerFields(sidebar.id);
    const pin = () =>
      app.inject({
        method: "POST",
        url: `/api/explorers/${sidebar.id}/pin`,
        payload: {
          fileMode: "edit",
          stateProtection: pinnedFields.stateProtection,
          tabGroupId: groupId,
          titleProtection: pinnedFields.titleProtection,
        },
      });
    const pinnedResponse = await pin();
    expect(pinnedResponse.statusCode, pinnedResponse.body).toBe(200);
    expect(
      explorerWireSummarySchema.parse(pinnedResponse.json()),
    ).toMatchObject({
      id: sidebar.id,
      fileMode: "edit",
      stateProtection: pinnedFields.stateProtection,
      titleProtection: pinnedFields.titleProtection,
    });

    const repeatedResponse = await pin();
    expect(repeatedResponse.statusCode, repeatedResponse.body).toBe(200);
    const conflictingFields = protectedExplorerFields(sidebar.id);
    const conflictingResponse = await app.inject({
      method: "POST",
      url: `/api/explorers/${sidebar.id}/pin`,
      payload: {
        fileMode: "visual",
        stateProtection: conflictingFields.stateProtection,
        tabGroupId: groupId,
        titleProtection: conflictingFields.titleProtection,
      },
    });
    expect(conflictingResponse.statusCode, conflictingResponse.body).toBe(200);
    expect(
      explorerWireSummarySchema.parse(conflictingResponse.json()),
    ).toMatchObject({
      fileMode: "edit",
      stateProtection: pinnedFields.stateProtection,
      titleProtection: pinnedFields.titleProtection,
    });
    layout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/tab-groups`,
        })
      ).json(),
    );
    expect(
      layout.groups
        .flatMap(({ members }) => members)
        .filter(
          ({ tabId, tabKind }) =>
            tabId === sidebar.id && tabKind === "explorer",
        ),
    ).toHaveLength(1);
    expect(
      layout.groups
        .find(({ id }) => id === groupId)
        ?.members.some(({ tabId }) => tabId === sidebar.id),
    ).toBe(true);
  });

  it("keeps custom tab-group labels opaque through rename, reorder, split, and merge", async () => {
    const terminal = terminalWireSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/terminals`,
          payload: {
            ...protectedTerminalFields(),
            target: {
              kind: "worktree",
              projectId,
              worktreeId: alphaWorktreeId,
            },
          },
        })
      ).json(),
    );
    let layout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/tab-groups`,
        })
      ).json(),
    );
    const groupId = layout.groups.find(({ members }) =>
      members.some(({ tabId }) => tabId === terminal.id),
    )!.id;
    const explorer = explorerWireSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/explorers`,
          payload: {
            ...protectedExplorerFields(),
            tabGroupId: groupId,
            target: {
              kind: "worktree",
              projectId,
              worktreeId: alphaWorktreeId,
            },
          },
        })
      ).json(),
    );
    layout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/tab-groups`,
        })
      ).json(),
    );
    const renameRevision = layout.revision;
    const titleProtection = protectedDisplayLabelFields(
      "tab-group",
      groupId,
    ).titleProtection;
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/tab-groups/${groupId}`,
      payload: { revision: renameRevision, titleProtection },
    });
    expect(renamed.statusCode).toBe(200);
    expect(
      (
        renamed.json() as { groups: Array<Record<string, unknown>> }
      ).groups.find(({ id }) => id === groupId),
    ).not.toHaveProperty("title");
    layout = projectTabLayoutWireSummarySchema.parse(renamed.json());
    expect(JSON.stringify(renamed.json())).not.toContain(
      "Cycle 5 private group",
    );
    expect(layout.groups.find(({ id }) => id === groupId)).toMatchObject({
      titleProtection: {
        classification: { recordKind: "tab-group" },
      },
      members: expect.arrayContaining([
        expect.objectContaining({ tabId: terminal.id, tabKind: "terminal" }),
        expect.objectContaining({ tabId: explorer.id, tabKind: "explorer" }),
      ]),
    });

    const stale = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/tab-groups/${groupId}`,
      payload: { revision: renameRevision, titleProtection },
    });
    expect(stale.statusCode).toBe(409);

    const memberKeys = layout.groups
      .find(({ id }) => id === groupId)!
      .members.map(({ tabKey }) => tabKey)
      .reverse();
    layout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/projects/${projectId}/tab-groups/${groupId}/members/order`,
          payload: { revision: layout.revision, tabKeys: memberKeys },
        })
      ).json(),
    );
    expect(
      layout.groups
        .find(({ id }) => id === groupId)!
        .members.map(({ tabKey }) => tabKey),
    ).toEqual(memberKeys);

    layout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/projects/${projectId}/tab-groups/member`,
          payload: {
            revision: layout.revision,
            tabKey: `explorer:${explorer.id}`,
            targetGroupId: null,
            targetMemberPosition: 0,
            targetGroupPosition: layout.groups.length,
          },
        })
      ).json(),
    );
    expect(
      layout.groups.find(({ id }) => id === groupId)?.titleProtection,
    ).toBeNull();
    const splitGroup = layout.groups.find(({ members }) =>
      members.some(({ tabId }) => tabId === explorer.id),
    )!;
    expect(splitGroup.titleProtection).toBeNull();

    layout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/projects/${projectId}/tab-groups/member`,
          payload: {
            revision: layout.revision,
            tabKey: `explorer:${explorer.id}`,
            targetGroupId: groupId,
            targetMemberPosition: 1,
          },
        })
      ).json(),
    );
    expect(layout.groups.some(({ id }) => id === splitGroup.id)).toBe(false);
    expect(
      layout.groups.find(({ id }) => id === groupId)?.members,
    ).toHaveLength(2);

    const reversedGroups = layout.groups.map(({ id }) => id).reverse();
    const reordered = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/tab-groups/order`,
      payload: { revision: layout.revision, groupIds: reversedGroups },
    });
    expect(reordered.statusCode).toBe(200);
    expect(
      projectTabLayoutWireSummarySchema
        .parse(reordered.json())
        .groups.map(({ id }) => id),
    ).toEqual(reversedGroups);
  });
});
