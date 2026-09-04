import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  PROJECT_BUILT_IN_SURFACE_DEFINITION_IDS,
  browserWireSummarySchema,
  cantripCliCommandResultSchema,
  chatWireListSchema,
  chatWireSummarySchema,
  directAttachmentTicketSchema,
  explorerWireSummarySchema,
  executionPlacementResolutionSchema,
  executionTargetWireCatalogSchema,
  executionTargetResolutionSchema,
  legacyProjectTabLayoutWireSummarySchema,
  projectTabLayoutWireSummarySchema,
  projectSurfaceLauncherListSchema,
  projectSurfaceLauncherSchema,
  projectSurfaceViewCloseResultSchema,
  projectSurfaceViewOpenResultSchema,
  projectSurfaceViewId,
  protectedScriptCommandListSchema,
  remoteDesktopWireSummarySchema,
  serverBootstrapSchema,
  terminalWireSummarySchema,
  unprobedCodexRuntimeReport,
  workerLinkPeerMailboxSchema,
  workerLinkPeerSessionDescriptorSchema,
  workerLinkResourceGrantSchema,
  workerLinkSessionSchema,
  type WorkerCommand,
  type WorkerNotification,
  type ProjectCenterLayoutNode,
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
  protectedRemoteDesktopFields,
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
      case "direct.capability.prepare":
        return {
          accepted: true,
          capabilityId: command.binding.capabilityId,
        };
      case "direct.capability.renew":
        return { renewed: true, leaseExpiresAt: command.leaseExpiresAt };
      case "direct.capability.revoke":
        return { revoked: true };
      case "terminal.open":
        await options?.onEvent?.({ type: "terminal.ready" });
        return { status: "detached" };
      case "terminal.detach":
        return { status: "detached" };
      case "surface.attach":
        return { accepted: true, transport: "websocket" };
      case "surface.desktop.probe":
        return { available: true, message: null };
      case "surface.detach":
      case "surface.close":
        return { accepted: true };
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
    directBroker: {
      available: true,
      leaseRenewal: true,
      protocol: "ws-v1",
      loopbackHost: "127.0.0.1",
      loopbackPort: 43_123,
      instanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      publicKey: "a".repeat(43),
      fingerprint: "b".repeat(64),
    },
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
    workspaceLayoutProfile: "hybrid",
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

  it("activates an exact LOCAL capability before accepting lease heartbeats", async () => {
    const sessionResponse = await app.inject({
      method: "POST",
      url: "/api/workers/worker-alpha/worker-link/sessions",
      payload: { clientInstanceId: "local-capability-client-1" },
    });
    expect(sessionResponse.statusCode).toBe(201);
    const session = workerLinkSessionSchema.parse(sessionResponse.json());
    const ticketResponse = await app.inject({
      method: "POST",
      url: `/api/worker-links/${session.sessionId}/direct`,
      payload: {},
    });
    expect(ticketResponse.statusCode, ticketResponse.body).toBe(201);
    const ticket = directAttachmentTicketSchema.parse(ticketResponse.json());
    expect(ticket.binding).toMatchObject({
      attachmentId: session.sessionId,
      resourceId: session.sessionId,
      resourceKind: "worker-link",
      workerId: "worker-alpha",
    });

    const heartbeat = {
      bytesFromLocal: 0,
      bytesToLocal: 0,
      connectionsClosed: 0,
      connectionsOpened: 0,
    };
    const beforeActivation = await app.inject({
      method: "POST",
      url: `/api/direct-attachments/${ticket.binding.capabilityId}/telemetry`,
      payload: heartbeat,
    });
    expect(beforeActivation.statusCode).toBe(409);

    const activated = await app.inject({
      method: "POST",
      url: `/api/worker-links/${session.sessionId}/direct-activate`,
      payload: { capabilityId: ticket.binding.capabilityId },
    });
    expect(activated.statusCode).toBe(204);
    for (let heartbeatIndex = 0; heartbeatIndex < 3; heartbeatIndex += 1) {
      const renewed = await app.inject({
        method: "POST",
        url: `/api/direct-attachments/${ticket.binding.capabilityId}/telemetry`,
        payload: heartbeat,
      });
      expect(renewed.statusCode).toBe(204);
    }
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

  it("authorizes exact WorkerLink observation subscriptions", async () => {
    const sessionResponse = await app.inject({
      method: "POST",
      url: "/api/workers/worker-alpha/worker-link/sessions",
      payload: { clientInstanceId: "observation-client-1" },
    });
    expect(sessionResponse.statusCode).toBe(201);
    const session = workerLinkSessionSchema.parse(sessionResponse.json());

    const response = await app.inject({
      method: "POST",
      url: `/api/worker-links/${session.sessionId}/observations/grant`,
      payload: {
        topics: ["chat-progress", "filesystem", "worktree", "runtime"],
      },
    });
    expect(response.statusCode, JSON.stringify(response.json())).toBe(201);
    const grant = workerLinkResourceGrantSchema.parse(response.json());
    expect(grant.binding).toMatchObject({
      sessionId: session.sessionId,
      resource: {
        kind: "observations",
        resourceId: "worker-alpha",
        attachmentId: expect.any(String),
      },
      lanes: ["events"],
      operations: ["events:subscribe"],
      maxChannels: 1,
    });
    expect(routedCommands).toContainEqual({
      workerId: "worker-alpha",
      command: expect.objectContaining({
        type: "worker-link.grant.install",
        sessionId: session.sessionId,
        grant: expect.objectContaining({
          binding: expect.objectContaining({
            grantId: grant.binding.grantId,
          }),
          observation: {
            subscriptionId: grant.binding.resource.attachmentId,
            topics: ["chat-progress", "filesystem", "worktree", "runtime"],
          },
        }),
      }),
    });

    const invalid = await app.inject({
      method: "POST",
      url: `/api/worker-links/${session.sessionId}/observations/grant`,
      payload: { topics: ["filesystem", "filesystem"] },
    });
    expect(invalid.statusCode).toBe(400);
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

  it("authorizes Browser control and disposable frames on separate WorkerLink lanes", async () => {
    const browserResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/browsers`,
      payload: {
        ...protectedBrowserFields(),
        target: { kind: "worker", projectId, workerId: "worker-alpha" },
      },
    });
    expect(browserResponse.statusCode).toBe(201);
    const browser = browserWireSummarySchema.parse(browserResponse.json());
    const sessionResponse = await app.inject({
      method: "POST",
      url: "/api/workers/worker-alpha/worker-link/sessions",
      payload: { clientInstanceId: "browser-surface-client-1" },
    });
    expect(sessionResponse.statusCode).toBe(201);
    const session = workerLinkSessionSchema.parse(sessionResponse.json());

    const grantResponse = await app.inject({
      method: "POST",
      url: `/api/worker-links/${session.sessionId}/remote-surfaces/${browser.id}/grant`,
      payload: {
        viewport: { width: 1_280, height: 720, devicePixelRatio: 2 },
      },
    });
    expect(grantResponse.statusCode, JSON.stringify(grantResponse.json())).toBe(
      201,
    );
    const grant = workerLinkResourceGrantSchema.parse(grantResponse.json());
    expect(grant.binding).toMatchObject({
      sessionId: session.sessionId,
      resource: {
        kind: "browser",
        resourceId: browser.id,
        attachmentId: expect.any(String),
      },
      lanes: ["interactive", "realtime"],
      operations: ["stream:open", "stream:read", "stream:write"],
      maxChannels: 2,
    });
    expect(routedCommands).toContainEqual({
      workerId: "worker-alpha",
      command: expect.objectContaining({
        type: "surface.attach",
        surfaceId: browser.id,
        attachmentId: grant.binding.resource.attachmentId,
        preferredTransport: "websocket",
        webrtc: null,
        viewport: { width: 1_280, height: 720, devicePixelRatio: 2 },
      }),
    });
    expect(routedCommands).toContainEqual({
      workerId: "worker-alpha",
      command: expect.objectContaining({
        type: "worker-link.grant.install",
        sessionId: session.sessionId,
        grant: expect.objectContaining({
          binding: expect.objectContaining({
            grantId: grant.binding.grantId,
          }),
        }),
      }),
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/browsers/${browser.id}`,
    });
    expect(deleted.statusCode).toBe(204);
    expect(routedCommands).toContainEqual({
      workerId: "worker-alpha",
      command: expect.objectContaining({
        type: "worker-link.grant.revoke",
        sessionId: session.sessionId,
        grantId: grant.binding.grantId,
      }),
    });
  });

  it("authorizes Remote Desktop input and disposable frames through WorkerLink", async () => {
    const desktopResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/remote-desktops`,
      payload: {
        ...protectedRemoteDesktopFields(),
        target: { kind: "worker", projectId, workerId: "worker-alpha" },
      },
    });
    expect(desktopResponse.statusCode).toBe(201);
    const desktop = remoteDesktopWireSummarySchema.parse(
      desktopResponse.json(),
    );
    const sessionResponse = await app.inject({
      method: "POST",
      url: "/api/workers/worker-alpha/worker-link/sessions",
      payload: { clientInstanceId: "desktop-surface-client-1" },
    });
    expect(sessionResponse.statusCode).toBe(201);
    const session = workerLinkSessionSchema.parse(sessionResponse.json());

    const grantResponse = await app.inject({
      method: "POST",
      url: `/api/worker-links/${session.sessionId}/remote-surfaces/${desktop.id}/grant`,
      payload: {
        viewport: { width: 1_440, height: 900, devicePixelRatio: 2 },
      },
    });
    expect(grantResponse.statusCode, JSON.stringify(grantResponse.json())).toBe(
      201,
    );
    const grant = workerLinkResourceGrantSchema.parse(grantResponse.json());
    expect(grant.binding).toMatchObject({
      sessionId: session.sessionId,
      resource: {
        kind: "remote-desktop",
        resourceId: desktop.id,
        attachmentId: expect.any(String),
      },
      lanes: ["interactive", "realtime"],
      operations: ["stream:open", "stream:read", "stream:write"],
      maxChannels: 2,
    });
    expect(routedCommands).toContainEqual({
      workerId: "worker-alpha",
      command: expect.objectContaining({
        type: "surface.attach",
        surfaceId: desktop.id,
        attachmentId: grant.binding.resource.attachmentId,
        configuration: { kind: "desktop" },
        stateResource: "remote-desktop-row",
        preferredTransport: "websocket",
        webrtc: null,
        viewport: { width: 1_440, height: 900, devicePixelRatio: 2 },
        desktopStream: { targetFps: 30, quality: "adaptive" },
      }),
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/project-views/${desktop.id}`,
    });
    expect(deleted.statusCode).toBe(204);
    expect(routedCommands).toContainEqual({
      workerId: "worker-alpha",
      command: expect.objectContaining({
        type: "worker-link.grant.revoke",
        sessionId: session.sessionId,
        grantId: grant.binding.grantId,
      }),
    });
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

    const fullCatalog = vi.spyOn(
      database.repository,
      "listProjectExecutionTargets",
    );
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
    expect(fullCatalog).not.toHaveBeenCalled();

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
    fullCatalog.mockRestore();
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
    const fullCatalog = vi.spyOn(
      database.repository,
      "listProjectExecutionTargets",
    );
    const cliCurrentTarget = await cli("target.show");
    expect(cliCurrentTarget.statusCode).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(cliCurrentTarget.json()),
    ).toMatchObject({
      target: { kind: "worktree", worktreeId: alphaWorktreeId },
    });
    expect(fullCatalog).not.toHaveBeenCalled();
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
    expect(fullCatalog).toHaveBeenCalledTimes(1);
    fullCatalog.mockClear();
    const cliExactTarget = await cli("target.show", { target: terminal.id });
    expect(cliExactTarget.statusCode).toBe(200);
    expect(
      cantripCliCommandResultSchema.parse(cliExactTarget.json()),
    ).toMatchObject({
      target: {
        kind: "surface",
        surfaceKind: "terminal",
        surfaceId: terminal.id,
      },
    });
    expect(fullCatalog).not.toHaveBeenCalled();
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
    expect(fullCatalog).not.toHaveBeenCalled();
    fullCatalog.mockRestore();
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

  it("revalidates a focused Explorer identity across concurrent move and delete", async () => {
    const invoke = (explorerId: string, requestId: string) =>
      app.inject({
        method: "POST",
        url: "/api/internal/cli",
        headers: { authorization: `Bearer ${config.workerToken}` },
        payload: {
          command: "explorer.list",
          chatContext: null,
          context: {
            codexThreadId: null,
            terminalId: null,
            cwd: path.join(dataDirectory, "worker-alpha"),
          },
          arguments: protectedSurfaceArguments(explorerId),
          requestId,
          workerId: "worker-alpha",
        },
      });
    const create = async () => {
      const fields = protectedExplorerFields();
      const response = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/explorers`,
        payload: {
          ...fields,
          target: {
            kind: "worktree",
            projectId,
            worktreeId: alphaWorktreeId,
          },
        },
      });
      expect(response.statusCode, response.body).toBe(201);
      return {
        fields,
        explorer: explorerWireSummarySchema.parse(response.json()),
      };
    };

    const moved = await create();
    const resolveSelector =
      database.repository.resolveExecutionTargetSelector.bind(
        database.repository,
      );
    const moveAfterSelection = vi.spyOn(
      database.repository,
      "resolveExecutionTargetSelector",
    );
    moveAfterSelection.mockImplementationOnce(async (...arguments_) => {
      const selected = await resolveSelector(...arguments_);
      await database.repository.updateExplorerWorktree(
        LOCAL_USER_ID,
        moved.explorer.id,
        {
          worktreeId: betaWorktreeId,
          stateProtection: protectedExplorerFields(moved.explorer.id)
            .stateProtection,
        },
      );
      return selected;
    });
    const movedResult = await invoke(
      moved.explorer.id,
      "cli-focused-explorer-moved",
    );
    moveAfterSelection.mockRestore();
    expect(movedResult.statusCode, movedResult.body).toBe(200);
    expect(routedCommands.at(-1)).toMatchObject({
      workerId: "worker-beta",
      command: { type: "explorer.operation", explorerId: moved.explorer.id },
    });

    const deleted = await create();
    const commandsBeforeDelete = routedCommands.length;
    const deleteAfterSelection = vi.spyOn(
      database.repository,
      "resolveExecutionTargetSelector",
    );
    deleteAfterSelection.mockImplementationOnce(async (...arguments_) => {
      const selected = await resolveSelector(...arguments_);
      await database.repository.deleteExplorer(
        LOCAL_USER_ID,
        deleted.explorer.id,
      );
      return selected;
    });
    const deletedResult = await invoke(
      deleted.explorer.id,
      "cli-focused-explorer-deleted",
    );
    deleteAfterSelection.mockRestore();
    expect(deletedResult.statusCode).toBe(404);
    expect(routedCommands).toHaveLength(commandsBeforeDelete);

    await database.repository.deleteExplorer(LOCAL_USER_ID, moved.explorer.id);
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
          url: `/api/projects/${projectId}/panes`,
        })
      ).json(),
    );
    const groupId = layout.panes.find(({ members }) =>
      members.some(({ tabId }) => tabId === anchor.id),
    )!.id;
    const legacyLayout = legacyProjectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/tab-groups`,
        })
      ).json(),
    );
    expect(
      legacyLayout.groups
        .flatMap(({ members }) => members)
        .every((member) => "groupId" in member && !("paneId" in member)),
    ).toBe(true);
    expect(
      layout.panes
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
          url: `/api/projects/${projectId}/panes`,
        })
      ).json(),
    );
    expect(
      layout.panes
        .flatMap(({ members }) => members)
        .filter(
          ({ tabId, tabKind }) =>
            tabId === sidebar.id && tabKind === "explorer",
        ),
    ).toHaveLength(1);
    expect(
      layout.panes
        .find(({ id }) => id === groupId)
        ?.members.some(({ tabId }) => tabId === sidebar.id),
    ).toBe(true);
  });

  it("closes and reopens a surface view without destroying its Chat resource", async () => {
    const chatResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/chats`,
      payload: {
        ...protectedChatFields(),
        target: {
          kind: "worktree",
          projectId,
          worktreeId: alphaWorktreeId,
        },
      },
    });
    expect(chatResponse.statusCode, chatResponse.body).toBe(201);
    const chat = chatWireSummarySchema.parse(chatResponse.json());
    const viewId = `chat:${chat.id}`;
    let layout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/panes`,
        })
      ).json(),
    );
    expect(
      layout.panes
        .flatMap(({ members }) => members)
        .filter(({ tabKey }) => tabKey === viewId),
    ).toHaveLength(1);

    const closeRevision = layout.revision;
    const closeResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/panes/member/close`,
      payload: { revision: closeRevision, viewId },
    });
    expect(closeResponse.statusCode, closeResponse.body).toBe(200);
    const closed = projectSurfaceViewCloseResultSchema.parse(
      closeResponse.json(),
    );
    expect(closed).toMatchObject({ disposition: "closed", viewId });
    expect(closed.layout.revision).toBe(closeRevision + 1);
    expect(
      closed.layout.panes
        .flatMap(({ members }) => members)
        .some(({ tabKey }) => tabKey === viewId),
    ).toBe(false);
    expect(
      chatWireListSchema.parse(
        (
          await app.inject({
            method: "GET",
            url: `/api/projects/${projectId}/chats`,
          })
        ).json(),
      ),
    ).toContainEqual(expect.objectContaining({ id: chat.id }));

    const repeatedCloseResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/panes/member/close`,
      payload: { revision: closeRevision, viewId },
    });
    expect(repeatedCloseResponse.statusCode, repeatedCloseResponse.body).toBe(
      200,
    );
    const repeatedClose = projectSurfaceViewCloseResultSchema.parse(
      repeatedCloseResponse.json(),
    );
    expect(repeatedClose).toMatchObject({
      disposition: "already-closed",
      viewId,
    });
    expect(repeatedClose.layout.revision).toBe(closed.layout.revision);

    const staleOpen = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/panes/member/open`,
      payload: {
        revision: closeRevision,
        surfaceRef: {
          kind: "entity",
          definitionId: "project.agent",
          resourceId: chat.id,
        },
      },
    });
    expect(staleOpen.statusCode).toBe(409);

    const openRequest = () =>
      app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/panes/member/open`,
        payload: {
          revision: repeatedClose.layout.revision,
          surfaceRef: {
            kind: "entity",
            definitionId: "project.agent",
            resourceId: chat.id,
          },
        },
      });
    const concurrentOpenResponses = await Promise.all([
      openRequest(),
      openRequest(),
    ]);
    expect(
      concurrentOpenResponses.every(({ statusCode }) =>
        [200, 409].includes(statusCode),
      ),
    ).toBe(true);
    const successfulOpens = concurrentOpenResponses
      .filter(({ statusCode }) => statusCode === 200)
      .map((response) =>
        projectSurfaceViewOpenResultSchema.parse(response.json()),
      );
    expect(
      successfulOpens.filter(({ disposition }) => disposition === "opened"),
    ).toHaveLength(1);
    const openResponse = concurrentOpenResponses.find(
      (response) =>
        response.statusCode === 200 &&
        projectSurfaceViewOpenResultSchema.parse(response.json())
          .disposition === "opened",
    )!;
    expect(openResponse.statusCode, openResponse.body).toBe(200);
    const opened = projectSurfaceViewOpenResultSchema.parse(
      openResponse.json(),
    );
    expect(opened).toMatchObject({ disposition: "opened", viewId });
    expect(opened.layout.revision).toBe(repeatedClose.layout.revision + 1);
    expect(
      opened.layout.panes
        .flatMap(({ members }) => members)
        .filter(({ tabKey }) => tabKey === viewId),
    ).toHaveLength(1);

    const focusedResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/panes/member/open`,
      payload: {
        revision: repeatedClose.layout.revision,
        surfaceRef: {
          kind: "entity",
          definitionId: "project.agent",
          resourceId: chat.id,
        },
      },
    });
    expect(focusedResponse.statusCode, focusedResponse.body).toBe(200);
    const focused = projectSurfaceViewOpenResultSchema.parse(
      focusedResponse.json(),
    );
    expect(focused).toMatchObject({ disposition: "focused", viewId });
    expect(focused.layout.revision).toBe(opened.layout.revision);

    const staleClose = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/panes/member/close`,
      payload: { revision: repeatedClose.layout.revision, viewId },
    });
    expect(staleClose.statusCode).toBe(409);
    layout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/panes`,
        })
      ).json(),
    );
    expect(
      layout.panes
        .flatMap(({ members }) => members)
        .filter(({ tabKey }) => tabKey === viewId),
    ).toHaveLength(1);
  });

  it("opens each built-in singleton once per project and persists launcher pins outside layout revisions", async () => {
    const createProject = async (
      repositoryBlindIndex: string,
      repositorySuffix: string,
    ) =>
      database.repository.createGithubProject(LOCAL_USER_ID, {
        workerId: "worker-alpha",
        ...protectedProjectFields(),
        repositoryBlindIndex,
        repositoryId: `placement-builtins-${repositorySuffix}`,
        nameWithOwner: `ArcaneArts/Cantrip-${repositorySuffix}`,
        url: `https://github.com/ArcaneArts/Cantrip-${repositorySuffix}`,
      });
    const firstProject = await createProject("B".repeat(43), "first");
    const secondProject = await createProject("C".repeat(43), "second");

    let firstLayout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${firstProject.id}/panes`,
        })
      ).json(),
    );
    const openedViewIds: string[] = [];
    for (const definitionId of PROJECT_BUILT_IN_SURFACE_DEFINITION_IDS) {
      const openResponse = await app.inject({
        method: "POST",
        url: `/api/projects/${firstProject.id}/panes/member/open`,
        payload: {
          revision: firstLayout.revision,
          surfaceRef: { kind: "builtin", definitionId },
        },
      });
      expect(openResponse.statusCode, openResponse.body).toBe(200);
      const opened = projectSurfaceViewOpenResultSchema.parse(
        openResponse.json(),
      );
      const expectedViewId = projectSurfaceViewId({
        projectId: firstProject.id,
        resource: { kind: "builtin", definitionId },
      });
      expect(opened).toMatchObject({
        disposition: "opened",
        viewId: expectedViewId,
      });
      expect(opened.layout.revision).toBe(firstLayout.revision + 1);
      firstLayout = opened.layout;
      openedViewIds.push(opened.viewId);
    }
    expect(new Set(openedViewIds).size).toBe(
      PROJECT_BUILT_IN_SURFACE_DEFINITION_IDS.length,
    );
    expect(
      firstLayout.panes
        .flatMap(({ members }) => members)
        .filter(({ tabKind }) => tabKind === "builtin"),
    ).toHaveLength(PROJECT_BUILT_IN_SURFACE_DEFINITION_IDS.length);

    const revisionAfterOpening = firstLayout.revision;
    for (const definitionId of PROJECT_BUILT_IN_SURFACE_DEFINITION_IDS) {
      const focusResponse = await app.inject({
        method: "POST",
        url: `/api/projects/${firstProject.id}/panes/member/open`,
        payload: {
          revision: revisionAfterOpening,
          surfaceRef: { kind: "builtin", definitionId },
        },
      });
      expect(focusResponse.statusCode, focusResponse.body).toBe(200);
      expect(
        projectSurfaceViewOpenResultSchema.parse(focusResponse.json()),
      ).toMatchObject({
        disposition: "focused",
        viewId: projectSurfaceViewId({
          projectId: firstProject.id,
          resource: { kind: "builtin", definitionId },
        }),
        layout: { revision: revisionAfterOpening },
      });
    }

    const secondLayout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${secondProject.id}/panes`,
        })
      ).json(),
    );
    const secondOpenResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${secondProject.id}/panes/member/open`,
      payload: {
        revision: secondLayout.revision,
        surfaceRef: { kind: "builtin", definitionId: "project.overview" },
      },
    });
    expect(secondOpenResponse.statusCode, secondOpenResponse.body).toBe(200);
    const secondOpened = projectSurfaceViewOpenResultSchema.parse(
      secondOpenResponse.json(),
    );
    expect(secondOpened).toMatchObject({
      disposition: "opened",
      viewId: projectSurfaceViewId({
        projectId: secondProject.id,
        resource: {
          kind: "builtin",
          definitionId: "project.overview",
        },
      }),
    });
    expect(secondOpened.viewId).not.toBe(
      projectSurfaceViewId({
        projectId: firstProject.id,
        resource: {
          kind: "builtin",
          definitionId: "project.overview",
        },
      }),
    );

    const launcherListResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${firstProject.id}/surface-launchers`,
    });
    expect(launcherListResponse.statusCode, launcherListResponse.body).toBe(
      200,
    );
    const launchers = projectSurfaceLauncherListSchema.parse(
      launcherListResponse.json(),
    );
    expect(
      launchers.find(
        ({ location, target }) =>
          location === "project-navigator" &&
          target.kind === "definition" &&
          target.definitionId === "project.overview",
      ),
    ).toMatchObject({ pinned: true });
    expect(
      launchers.find(
        ({ location, target }) =>
          location === "bottom-rail" &&
          target.kind === "definition" &&
          target.definitionId === "project.terminal",
      ),
    ).toBeUndefined();
    expect(
      launchers.find(
        ({ location, target }) =>
          location === "right-rail" &&
          target.kind === "definition" &&
          target.definitionId === "project.browser",
      ),
    ).toBeUndefined();
    expect(
      launchers.find(
        ({ location, target }) =>
          location === "right-rail" &&
          target.kind === "definition" &&
          target.definitionId === "project.remote-desktop",
      ),
    ).toBeUndefined();

    const pinResponse = await app.inject({
      method: "PATCH",
      url: `/api/projects/${firstProject.id}/surface-launchers`,
      payload: {
        definitionId: "project.overview",
        location: "project-navigator",
        pinned: false,
      },
    });
    expect(pinResponse.statusCode, pinResponse.body).toBe(200);
    expect(
      projectSurfaceLauncherSchema.parse(pinResponse.json()),
    ).toMatchObject({
      projectId: firstProject.id,
      location: "project-navigator",
      target: {
        kind: "definition",
        definitionId: "project.overview",
      },
      pinned: false,
    });
    const layoutAfterPin = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${firstProject.id}/panes`,
        })
      ).json(),
    );
    expect(layoutAfterPin.revision).toBe(revisionAfterOpening);

    const persistedLaunchers = projectSurfaceLauncherListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${firstProject.id}/surface-launchers`,
        })
      ).json(),
    );
    expect(
      persistedLaunchers.find(
        ({ location, target }) =>
          location === "project-navigator" &&
          target.kind === "definition" &&
          target.definitionId === "project.overview",
      ),
    ).toMatchObject({ pinned: false });
  });

  it("rejects legacy History and Issues ProjectView creation", async () => {
    const fields = protectedDisplayLabelFields("project-view");
    for (const kind of ["history", "issues"] as const) {
      const response = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/views`,
        payload: {
          id: fields.id,
          kind,
          titleProtection: fields.titleProtection,
        },
      });
      expect(response.statusCode, response.body).toBe(400);
    }
  });

  it("serializes reopen against resource deletion without orphaning the layout", async () => {
    const chatResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/chats`,
      payload: {
        ...protectedChatFields(),
        target: {
          kind: "worktree",
          projectId,
          worktreeId: alphaWorktreeId,
        },
      },
    });
    expect(chatResponse.statusCode, chatResponse.body).toBe(201);
    const chat = chatWireSummarySchema.parse(chatResponse.json());
    const viewId = `chat:${chat.id}`;
    let layout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/panes`,
        })
      ).json(),
    );
    const closed = projectSurfaceViewCloseResultSchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/panes/member/close`,
          payload: { revision: layout.revision, viewId },
        })
      ).json(),
    );

    const [reopen, deleted] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/panes/member/open`,
        payload: {
          revision: closed.layout.revision,
          surfaceRef: {
            kind: "entity",
            definitionId: "project.agent",
            resourceId: chat.id,
          },
        },
      }),
      app.inject({ method: "DELETE", url: `/api/chats/${chat.id}` }),
    ]);
    expect([200, 400]).toContain(reopen.statusCode);
    expect(deleted.statusCode, deleted.body).toBe(204);

    const layoutResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/panes`,
    });
    expect(layoutResponse.statusCode, layoutResponse.body).toBe(200);
    layout = projectTabLayoutWireSummarySchema.parse(layoutResponse.json());
    expect(
      layout.panes
        .flatMap(({ members }) => members)
        .some(({ tabKey }) => tabKey === viewId),
    ).toBe(false);
  });

  it("keeps pane labels opaque while moving mixed kinds across center panes", async () => {
    const terminal = terminalWireSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/terminals`,
          payload: {
            ...protectedTerminalFields(),
            targetRegion: "center",
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
          url: `/api/projects/${projectId}/panes`,
        })
      ).json(),
    );
    const paneId = layout.panes.find(({ members }) =>
      members.some(({ tabId }) => tabId === terminal.id),
    )!.id;
    const explorer = explorerWireSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/explorers`,
          payload: {
            ...protectedExplorerFields(),
            paneId,
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
          url: `/api/projects/${projectId}/panes`,
        })
      ).json(),
    );
    const renameRevision = layout.revision;
    const titleProtection = protectedDisplayLabelFields(
      "tab-group",
      paneId,
    ).titleProtection;
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/panes/${paneId}`,
      payload: { revision: renameRevision, titleProtection },
    });
    expect(renamed.statusCode).toBe(200);
    expect(
      (renamed.json() as { panes: Array<Record<string, unknown>> }).panes.find(
        ({ id }) => id === paneId,
      ),
    ).not.toHaveProperty("title");
    layout = projectTabLayoutWireSummarySchema.parse(renamed.json());
    expect(JSON.stringify(renamed.json())).not.toContain(
      "Cycle 5 private group",
    );
    expect(layout.panes.find(({ id }) => id === paneId)).toMatchObject({
      region: "center",
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
      url: `/api/projects/${projectId}/panes/${paneId}`,
      payload: { revision: renameRevision, titleProtection },
    });
    expect(stale.statusCode).toBe(409);

    const memberKeys = layout.panes
      .find(({ id }) => id === paneId)!
      .members.map(({ tabKey }) => tabKey)
      .reverse();
    layout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/projects/${projectId}/panes/${paneId}/members/order`,
          payload: { revision: layout.revision, tabKeys: memberKeys },
        })
      ).json(),
    );
    expect(
      layout.panes
        .find(({ id }) => id === paneId)!
        .members.map(({ tabKey }) => tabKey),
    ).toEqual(memberKeys);

    const concurrentMoves = await Promise.all([
      app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}/panes/member`,
        payload: {
          revision: layout.revision,
          tabKey: `explorer:${explorer.id}`,
          targetPaneId: null,
          targetMemberPosition: 0,
          targetPanePosition: layout.panes.length,
        },
      }),
      app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}/panes/member`,
        payload: {
          revision: layout.revision,
          tabKey: `explorer:${explorer.id}`,
          targetPaneId: null,
          targetMemberPosition: 0,
          targetPanePosition: layout.panes.length,
        },
      }),
    ]);
    expect(concurrentMoves.map(({ statusCode }) => statusCode).sort()).toEqual([
      200, 409,
    ]);
    layout = projectTabLayoutWireSummarySchema.parse(
      concurrentMoves.find(({ statusCode }) => statusCode === 200)!.json(),
    );
    expect(
      layout.panes.find(({ id }) => id === paneId)?.titleProtection,
    ).toBeNull();
    const splitGroup = layout.panes.find(({ members }) =>
      members.some(({ tabId }) => tabId === explorer.id),
    )!;
    expect(splitGroup.titleProtection).toBeNull();

    layout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/projects/${projectId}/panes/member`,
          payload: {
            revision: layout.revision,
            tabKey: `explorer:${explorer.id}`,
            targetPaneId: paneId,
            targetMemberPosition: 1,
          },
        })
      ).json(),
    );
    expect(layout.panes.some(({ id }) => id === splitGroup.id)).toBe(false);
    expect(layout.panes.find(({ id }) => id === paneId)?.members).toHaveLength(
      2,
    );

    const reversedGroups = layout.panes
      .filter(({ region }) => region === "center")
      .map(({ id }) => id)
      .reverse();
    const reordered = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/panes/order`,
      payload: {
        revision: layout.revision,
        region: "center",
        paneIds: reversedGroups,
      },
    });
    expect(reordered.statusCode).toBe(200);
    expect(
      projectTabLayoutWireSummarySchema
        .parse(reordered.json())
        .panes.filter(({ region }) => region === "center")
        .map(({ id }) => id),
    ).toEqual(reversedGroups);
  });

  it("splits and resizes center panes with revision-safe durable topology", async () => {
    const leafIds = (root: ProjectCenterLayoutNode | null): string[] =>
      root === null
        ? []
        : root.kind === "pane"
          ? [root.paneId]
          : [...leafIds(root.first), ...leafIds(root.second)];
    const containingSplitId = (
      root: ProjectCenterLayoutNode,
      paneId: string,
    ): string | null => {
      if (root.kind === "pane") return null;
      if (leafIds(root.first).includes(paneId)) {
        return root.first.kind === "pane" && root.first.paneId === paneId
          ? root.id
          : (containingSplitId(root.first, paneId) ?? root.id);
      }
      return root.second.kind === "pane" && root.second.paneId === paneId
        ? root.id
        : (containingSplitId(root.second, paneId) ?? root.id);
    };

    const targetBrowserResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/browsers`,
      payload: {
        ...protectedBrowserFields(),
        target: { kind: "worker", projectId, workerId: "worker-alpha" },
        targetRegion: "center",
      },
    });
    expect(targetBrowserResponse.statusCode, targetBrowserResponse.body).toBe(
      201,
    );
    const targetBrowser = browserWireSummarySchema.parse(
      targetBrowserResponse.json(),
    );
    const browserResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/browsers`,
      payload: {
        ...protectedBrowserFields(),
        target: { kind: "worker", projectId, workerId: "worker-alpha" },
        targetRegion: "center",
      },
    });
    expect(browserResponse.statusCode, browserResponse.body).toBe(201);
    const browser = browserWireSummarySchema.parse(browserResponse.json());
    let layout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/panes`,
        })
      ).json(),
    );
    const sourcePane = layout.panes.find(({ members }) =>
      members.some(({ tabKey }) => tabKey === `browser:${browser.id}`),
    )!;
    const targetPane = layout.panes.find(({ members }) =>
      members.some(({ tabKey }) => tabKey === `browser:${targetBrowser.id}`),
    )!;

    const invalidSelfSplit = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/panes/member/split`,
      payload: {
        revision: layout.revision,
        tabKey: `browser:${browser.id}`,
        targetPaneId: sourcePane.id,
        edge: "right",
      },
    });
    expect(invalidSelfSplit.statusCode).toBe(400);

    const splitRevision = layout.revision;
    const splitResponse = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/panes/member/split`,
      payload: {
        revision: splitRevision,
        tabKey: `browser:${browser.id}`,
        targetPaneId: targetPane.id,
        edge: "left",
        fraction: 0.4,
      },
    });
    expect(splitResponse.statusCode, splitResponse.body).toBe(200);
    layout = projectTabLayoutWireSummarySchema.parse(splitResponse.json());
    expect(layout.panes.some(({ id }) => id === sourcePane.id)).toBe(false);
    const splitPane = layout.panes.find(({ members }) =>
      members.some(({ tabKey }) => tabKey === `browser:${browser.id}`),
    )!;
    expect(splitPane.region).toBe("center");
    expect(layout.centerRoot).not.toBeNull();
    expect(leafIds(layout.centerRoot ?? null)).toEqual(
      layout.panes
        .filter(({ region }) => region === "center")
        .map(({ id }) => id),
    );
    const splitId = containingSplitId(layout.centerRoot!, splitPane.id)!;

    const resized = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/panes/splits/${splitId}`,
      payload: { revision: layout.revision, fraction: 0.65 },
    });
    expect(resized.statusCode, resized.body).toBe(200);
    const resizedLayout = projectTabLayoutWireSummarySchema.parse(
      resized.json(),
    );
    expect(JSON.stringify(resizedLayout.centerRoot)).toContain(
      '"fraction":0.65',
    );

    const staleResize = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/panes/splits/${splitId}`,
      payload: { revision: layout.revision, fraction: 0.7 },
    });
    expect(staleResize.statusCode).toBe(409);
    const missingResize = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/panes/splits/missing-split`,
      payload: { revision: resizedLayout.revision, fraction: 0.7 },
    });
    expect(missingResize.statusCode).toBe(400);

    const closed = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/panes/member/close`,
      payload: {
        revision: resizedLayout.revision,
        viewId: `browser:${browser.id}`,
      },
    });
    expect(closed.statusCode, closed.body).toBe(200);
    const closedLayout = projectSurfaceViewCloseResultSchema.parse(
      closed.json(),
    ).layout;
    expect(closedLayout.panes.some(({ id }) => id === splitPane.id)).toBe(
      false,
    );
    expect(leafIds(closedLayout.centerRoot ?? null)).toEqual(
      closedLayout.panes
        .filter(({ region }) => region === "center")
        .map(({ id }) => id),
    );
    const targetClosed = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/panes/member/close`,
      payload: {
        revision: closedLayout.revision,
        viewId: `browser:${targetBrowser.id}`,
      },
    });
    expect(targetClosed.statusCode, targetClosed.body).toBe(200);
  });

  it("applies layout profiles only to first-open placements", async () => {
    const layoutBefore = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/panes`,
        })
      ).json(),
    );
    const profileUpdate = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { workspaceLayoutProfile: "agent" },
    });
    expect(profileUpdate.statusCode, profileUpdate.body).toBe(200);
    const unchangedLayout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/panes`,
        })
      ).json(),
    );
    expect(unchangedLayout).toEqual(layoutBefore);

    const agentBrowserResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/browsers`,
      payload: {
        ...protectedBrowserFields(),
        target: { kind: "worker", projectId, workerId: "worker-alpha" },
      },
    });
    expect(agentBrowserResponse.statusCode, agentBrowserResponse.body).toBe(
      201,
    );
    const agentBrowser = browserWireSummarySchema.parse(
      agentBrowserResponse.json(),
    );
    let layout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/panes`,
        })
      ).json(),
    );
    const agentBrowserPane = layout.panes.find(({ members }) =>
      members.some(({ tabId }) => tabId === agentBrowser.id),
    )!;
    expect(agentBrowserPane.region).toBe("center");

    const focused = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/panes/member/open`,
      payload: {
        revision: layout.revision,
        surfaceRef: {
          kind: "entity",
          definitionId: "project.browser",
          resourceId: agentBrowser.id,
        },
        targetRegion: "bottom",
      },
    });
    expect(focused.statusCode, focused.body).toBe(200);
    expect(
      projectSurfaceViewOpenResultSchema.parse(focused.json()),
    ).toMatchObject({
      disposition: "focused",
      paneId: agentBrowserPane.id,
      layout: { revision: layout.revision },
    });

    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { workspaceLayoutProfile: "ide" },
        })
      ).statusCode,
    ).toBe(200);
    const ideChatResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/chats`,
      payload: {
        ...protectedChatFields(),
        target: { kind: "worktree", projectId, worktreeId: alphaWorktreeId },
      },
    });
    expect(ideChatResponse.statusCode, ideChatResponse.body).toBe(201);
    const ideChat = chatWireSummarySchema.parse(ideChatResponse.json());
    layout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/panes`,
        })
      ).json(),
    );
    expect(
      layout.panes.find(({ members }) =>
        members.some(({ tabId }) => tabId === ideChat.id),
      )?.region,
    ).toBe("right");

    const explicitBrowserResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/browsers`,
      payload: {
        ...protectedBrowserFields(),
        target: { kind: "worker", projectId, workerId: "worker-alpha" },
        targetRegion: "bottom",
      },
    });
    expect(
      explicitBrowserResponse.statusCode,
      explicitBrowserResponse.body,
    ).toBe(201);
    const explicitBrowser = browserWireSummarySchema.parse(
      explicitBrowserResponse.json(),
    );
    layout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/panes`,
        })
      ).json(),
    );
    expect(
      layout.panes.find(({ members }) =>
        members.some(({ tabId }) => tabId === explicitBrowser.id),
      )?.region,
    ).toBe("bottom");

    const rawDetached = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/browsers`,
      payload: {
        ...protectedBrowserFields(),
        target: { kind: "worker", projectId, workerId: "worker-alpha" },
        targetRegion: "detached",
      },
    });
    expect(rawDetached.statusCode, rawDetached.body).toBe(400);
  });

  it("places surfaces in singleton docks and keeps legacy pane ordering compatible", async () => {
    let layout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/panes`,
        })
      ).json(),
    );
    const dockViewIds = layout.panes
      .filter(({ region }) => region === "right" || region === "bottom")
      .flatMap(({ members }) => members.map(({ tabKey }) => tabKey));
    for (const viewId of dockViewIds) {
      const closed = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/panes/member/close`,
        payload: { revision: layout.revision, viewId },
      });
      expect(closed.statusCode, closed.body).toBe(200);
      layout = projectSurfaceViewCloseResultSchema.parse(closed.json()).layout;
    }
    expect(
      layout.panes.filter(
        ({ region }) => region === "right" || region === "bottom",
      ),
    ).toHaveLength(0);

    const concurrentBrowsers = await Promise.all(
      Array.from({ length: 2 }, () =>
        app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/browsers`,
          payload: {
            ...protectedBrowserFields(),
            target: { kind: "worker", projectId, workerId: "worker-alpha" },
          },
        }),
      ),
    );
    expect(concurrentBrowsers.map(({ statusCode }) => statusCode)).toEqual([
      201, 201,
    ]);
    const concurrentBrowserIds = concurrentBrowsers.map(
      (response) => browserWireSummarySchema.parse(response.json()).id,
    );
    layout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/panes`,
        })
      ).json(),
    );
    expect(
      layout.panes.filter(({ region }) => region === "right"),
    ).toHaveLength(1);
    for (const browserId of concurrentBrowserIds) {
      const closed = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/panes/member/close`,
        payload: { revision: layout.revision, viewId: `browser:${browserId}` },
      });
      expect(closed.statusCode, closed.body).toBe(200);
      layout = projectSurfaceViewCloseResultSchema.parse(closed.json()).layout;
    }
    expect(
      layout.panes.filter(({ region }) => region === "right"),
    ).toHaveLength(0);

    const centeredBrowser = browserWireSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/browsers`,
          payload: {
            ...protectedBrowserFields(),
            target: { kind: "worker", projectId, workerId: "worker-alpha" },
            targetRegion: "center",
          },
        })
      ).json(),
    );
    layout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/panes`,
        })
      ).json(),
    );
    const centeredPane = layout.panes.find(({ members }) =>
      members.some(({ tabId }) => tabId === centeredBrowser.id),
    )!;
    expect(centeredPane).toMatchObject({ region: "center" });

    const moveRevision = layout.revision;
    const moved = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/panes/member`,
      payload: {
        revision: moveRevision,
        tabKey: `browser:${centeredBrowser.id}`,
        targetPaneId: null,
        targetRegion: "right",
        targetMemberPosition: 0,
      },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    layout = projectTabLayoutWireSummarySchema.parse(moved.json());
    expect(layout.panes.find(({ id }) => id === centeredPane.id)).toMatchObject(
      { region: "right" },
    );
    expect(
      layout.panes.filter(({ region }) => region === "right"),
    ).toHaveLength(1);
    const staleMove = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/panes/member`,
      payload: {
        revision: moveRevision,
        tabKey: `browser:${centeredBrowser.id}`,
        targetPaneId: null,
        targetRegion: "right",
        targetMemberPosition: 0,
      },
    });
    expect(staleMove.statusCode).toBe(409);

    const secondBrowser = browserWireSummarySchema.parse(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/browsers`,
          payload: {
            ...protectedBrowserFields(),
            target: { kind: "worker", projectId, workerId: "worker-alpha" },
          },
        })
      ).json(),
    );
    layout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/panes`,
        })
      ).json(),
    );
    const rightPane = layout.panes.find(({ region }) => region === "right")!;
    expect(rightPane.id).toBe(centeredPane.id);
    expect(rightPane.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tabId: centeredBrowser.id }),
        expect.objectContaining({ tabId: secondBrowser.id }),
      ]),
    );

    const focused = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/panes/member/open`,
      payload: {
        revision: layout.revision,
        surfaceRef: {
          kind: "entity",
          definitionId: "project.browser",
          resourceId: centeredBrowser.id,
        },
        targetRegion: "bottom",
      },
    });
    expect(focused.statusCode, focused.body).toBe(200);
    const focusedResult = projectSurfaceViewOpenResultSchema.parse(
      focused.json(),
    );
    expect(focusedResult).toMatchObject({
      disposition: "focused",
      paneId: rightPane.id,
    });
    expect(focusedResult.layout.revision).toBe(layout.revision);
    expect(
      focusedResult.layout.panes.filter(({ region }) => region === "bottom"),
    ).toHaveLength(0);

    const terminals = [];
    for (let index = 0; index < 2; index += 1) {
      const response = await app.inject({
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
      expect(response.statusCode, response.body).toBe(201);
      terminals.push(terminalWireSummarySchema.parse(response.json()));
    }
    layout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/panes`,
        })
      ).json(),
    );
    const bottomPanes = layout.panes.filter(
      ({ region }) => region === "bottom",
    );
    expect(bottomPanes).toHaveLength(1);
    expect(bottomPanes[0]!.members.map(({ tabId }) => tabId)).toEqual(
      expect.arrayContaining(terminals.map(({ id }) => id)),
    );
    const dockedExplorer = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/explorers`,
      payload: {
        ...protectedExplorerFields(),
        targetRegion: "center",
        target: {
          kind: "worktree",
          projectId,
          worktreeId: alphaWorktreeId,
        },
      },
    });
    expect(dockedExplorer.statusCode, dockedExplorer.body).toBe(201);
    const dockedExplorerId = explorerWireSummarySchema.parse(
      dockedExplorer.json(),
    ).id;
    layout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/panes`,
        })
      ).json(),
    );
    const explorerPane = layout.panes.find(({ members }) =>
      members.some(({ tabId }) => tabId === dockedExplorerId),
    )!;
    expect(explorerPane.region).toBe("center");
    const movedExplorer = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/panes/member`,
      payload: {
        revision: layout.revision,
        tabKey: `explorer:${dockedExplorerId}`,
        targetPaneId: null,
        targetRegion: "bottom",
        targetMemberPosition: 0,
      },
    });
    expect(movedExplorer.statusCode, movedExplorer.body).toBe(200);
    layout = projectTabLayoutWireSummarySchema.parse(movedExplorer.json());
    expect(
      layout.panes
        .filter(({ region }) => region === "bottom")
        .flatMap(({ members }) => members)
        .some(({ tabId }) => tabId === dockedExplorerId),
    ).toBe(true);

    const joinedBottom = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/panes/member`,
      payload: {
        revision: layout.revision,
        tabKey: `browser:${centeredBrowser.id}`,
        targetPaneId: null,
        targetRegion: "bottom",
        targetMemberPosition: 1,
      },
    });
    expect(joinedBottom.statusCode, joinedBottom.body).toBe(200);
    layout = projectTabLayoutWireSummarySchema.parse(joinedBottom.json());
    expect(
      layout.panes.filter(({ region }) => region === "right"),
    ).toHaveLength(1);
    expect(
      layout.panes.filter(({ region }) => region === "bottom"),
    ).toHaveLength(1);
    expect(
      layout.panes
        .flatMap(({ members }) => members)
        .filter(({ tabKey }) => tabKey === `browser:${centeredBrowser.id}`),
    ).toHaveLength(1);

    const legacy = legacyProjectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/tab-groups`,
        })
      ).json(),
    );
    const reversedLegacyIds = legacy.groups.map(({ id }) => id).reverse();
    const reorderedLegacy = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/tab-groups/order`,
      payload: {
        revision: legacy.revision,
        groupIds: reversedLegacyIds,
      },
    });
    expect(reorderedLegacy.statusCode, reorderedLegacy.body).toBe(200);
    const reorderedLayout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/panes`,
        })
      ).json(),
    );
    for (const region of ["center", "right", "bottom"] as const) {
      const expectedIds = reversedLegacyIds.filter((id) =>
        layout.panes.some((pane) => pane.id === id && pane.region === region),
      );
      expect(
        reorderedLayout.panes
          .filter((pane) => pane.region === region)
          .map(({ id }) => id),
      ).toEqual(expectedIds);
    }
  });

  it("persists independent dock presentation preferences across moves and close/reopen", async () => {
    const createBrowser = async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/browsers`,
        payload: {
          ...protectedBrowserFields(),
          target: { kind: "worker", projectId, workerId: "worker-alpha" },
          targetRegion: "right",
        },
      });
      expect(response.statusCode, response.body).toBe(201);
      return browserWireSummarySchema.parse(response.json());
    };
    const primaryBrowser = await createBrowser();
    const peerBrowser = await createBrowser();
    const primaryTabKey = `browser:${primaryBrowser.id}`;
    const memberIn = (
      layout: ReturnType<typeof projectTabLayoutWireSummarySchema.parse>,
      region: "center" | "right" | "bottom",
      tabKey: string,
    ) =>
      layout.panes
        .filter((pane) => pane.region === region)
        .flatMap((pane) => pane.members)
        .find((member) => member.tabKey === tabKey);

    let layout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/panes`,
        })
      ).json(),
    );
    expect(memberIn(layout, "right", primaryTabKey)?.dockPresentation).toEqual({
      preferredMode: "split",
      splitFraction: 0.32,
      restoreFraction: 0.32,
    });
    expect(
      memberIn(layout, "right", `browser:${peerBrowser.id}`)?.dockPresentation,
    ).toMatchObject({ preferredMode: "split", splitFraction: 0.32 });

    const rightUpdateRevision = layout.revision;
    const rightUpdate = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/panes/member/presentation`,
      payload: {
        revision: rightUpdateRevision,
        tabKey: primaryTabKey,
        preferredMode: "full",
        splitFraction: 0.41,
        restoreFraction: 0.36,
      },
    });
    expect(rightUpdate.statusCode, rightUpdate.body).toBe(200);
    layout = projectTabLayoutWireSummarySchema.parse(rightUpdate.json());
    expect(memberIn(layout, "right", primaryTabKey)?.dockPresentation).toEqual({
      preferredMode: "full",
      splitFraction: 0.41,
      restoreFraction: 0.36,
    });
    expect(
      memberIn(layout, "right", `browser:${peerBrowser.id}`)?.dockPresentation,
    ).toMatchObject({ preferredMode: "split", splitFraction: 0.32 });

    const staleUpdate = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/panes/member/presentation`,
      payload: {
        revision: rightUpdateRevision,
        tabKey: primaryTabKey,
        preferredMode: "split",
        splitFraction: 0.5,
        restoreFraction: 0.5,
      },
    });
    expect(staleUpdate.statusCode).toBe(409);
    const invalidFraction = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/panes/member/presentation`,
      payload: {
        revision: layout.revision,
        tabKey: primaryTabKey,
        preferredMode: "split",
        splitFraction: 0.01,
        restoreFraction: 0.5,
      },
    });
    expect(invalidFraction.statusCode).toBe(400);

    layout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/projects/${projectId}/panes/member`,
          payload: {
            revision: layout.revision,
            tabKey: primaryTabKey,
            targetPaneId: null,
            targetRegion: "bottom",
            targetMemberPosition: 0,
          },
        })
      ).json(),
    );
    expect(memberIn(layout, "bottom", primaryTabKey)?.dockPresentation).toEqual(
      {
        preferredMode: "split",
        splitFraction: 0.32,
        restoreFraction: 0.32,
      },
    );
    const bottomUpdate = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/panes/member/presentation`,
      payload: {
        revision: layout.revision,
        tabKey: primaryTabKey,
        preferredMode: "closed",
        splitFraction: 0.28,
        restoreFraction: 0.26,
      },
    });
    expect(bottomUpdate.statusCode, bottomUpdate.body).toBe(200);
    layout = projectTabLayoutWireSummarySchema.parse(bottomUpdate.json());

    const movedRight = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/panes/member`,
      payload: {
        revision: layout.revision,
        tabKey: primaryTabKey,
        targetPaneId: null,
        targetRegion: "right",
        targetMemberPosition: 0,
      },
    });
    expect(movedRight.statusCode, movedRight.body).toBe(200);
    layout = projectTabLayoutWireSummarySchema.parse(movedRight.json());
    expect(memberIn(layout, "right", primaryTabKey)?.dockPresentation).toEqual({
      preferredMode: "full",
      splitFraction: 0.41,
      restoreFraction: 0.36,
    });

    const closed = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/panes/member/close`,
      payload: { revision: layout.revision, viewId: primaryTabKey },
    });
    expect(closed.statusCode, closed.body).toBe(200);
    layout = projectSurfaceViewCloseResultSchema.parse(closed.json()).layout;
    expect(
      layout.panes
        .flatMap((pane) => pane.members)
        .some(({ tabKey }) => tabKey === primaryTabKey),
    ).toBe(false);

    const reopened = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/panes/member/open`,
      payload: {
        revision: layout.revision,
        surfaceRef: {
          kind: "entity",
          definitionId: "project.browser",
          resourceId: primaryBrowser.id,
        },
        targetRegion: "right",
      },
    });
    expect(reopened.statusCode, reopened.body).toBe(200);
    layout = projectSurfaceViewOpenResultSchema.parse(reopened.json()).layout;
    expect(memberIn(layout, "right", primaryTabKey)?.dockPresentation).toEqual({
      preferredMode: "full",
      splitFraction: 0.41,
      restoreFraction: 0.36,
    });

    layout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/projects/${projectId}/panes/member`,
          payload: {
            revision: layout.revision,
            tabKey: primaryTabKey,
            targetPaneId: null,
            targetRegion: "bottom",
            targetMemberPosition: 0,
          },
        })
      ).json(),
    );
    expect(memberIn(layout, "bottom", primaryTabKey)?.dockPresentation).toEqual(
      {
        preferredMode: "closed",
        splitFraction: 0.28,
        restoreFraction: 0.26,
      },
    );

    layout = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/projects/${projectId}/panes/member`,
          payload: {
            revision: layout.revision,
            tabKey: primaryTabKey,
            targetPaneId: null,
            targetRegion: "center",
            targetMemberPosition: 0,
            targetPanePosition: 0,
          },
        })
      ).json(),
    );
    expect(
      memberIn(layout, "center", primaryTabKey)?.dockPresentation,
    ).toBeNull();
    const centerRevision = layout.revision;
    const centerUpdate = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/panes/member/presentation`,
      payload: {
        revision: centerRevision,
        tabKey: primaryTabKey,
        preferredMode: "split",
        splitFraction: 0.4,
        restoreFraction: 0.4,
      },
    });
    expect(centerUpdate.statusCode).toBe(400);
    const afterRejectedCenterUpdate = projectTabLayoutWireSummarySchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/panes`,
        })
      ).json(),
    );
    expect(afterRejectedCenterUpdate.revision).toBe(centerRevision);
  });
});
