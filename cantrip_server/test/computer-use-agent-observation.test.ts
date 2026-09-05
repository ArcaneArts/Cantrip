import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Client,
  StdioClientTransport,
} from "../../cantrip_worker/test/support/cua-mcp-test-client.js";
import {
  decryptChatMessageProtectedContent,
  decryptTaskMessageProtectedContent,
  encryptInteractionResponseContent,
} from "../../packages/crypto/src/index.js";
import { EncryptedChatEventSealer } from "../../cantrip_worker/src/chat-message-encryption.js";
import { EncryptedTaskEventSealer } from "../../cantrip_worker/src/task-operation.js";
import type { WorkerEncryptionService } from "../../cantrip_worker/src/worker-encryption.js";
import { agentActivitySchema } from "@cantrip/protocol";
import type { CuaAgentAuthority } from "@cantrip/protocol/computer-use-agent";
import type { CuaSnapshot } from "@cantrip/protocol/computer-use";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createComputerUseClient,
  type ComputerUseClient,
  type ComputerUseClientDependencies,
} from "../../cantrip_app/src/lib/computer-use-client";
import { finalizeCuaAgentTurn } from "../../cantrip_worker/src/computer-use/turn-finalization.js";
import { CuaAgentCoordinator } from "../../cantrip_worker/src/computer-use/agent.js";
import { CuaApprovalManager } from "../../cantrip_worker/src/computer-use/approvals.js";
import {
  CuaAgentApprovalEvents,
  type CuaAgentApprovalEvent,
} from "../../cantrip_worker/src/computer-use/agent-approval-events.js";
import { CantripMcpBroker } from "../../cantrip_worker/src/mcp/broker.js";
import { computerUsePreviewAuthority } from "../src/app/routes/computer-use-preview.js";
import { createComputerUsePreviewFixture } from "./support/computer-use-preview-fixture.js";

vi.mock("../../cantrip_app/src/lib/api-client", () => ({
  request: () => {
    throw new Error("Unbound request");
  },
}));
vi.mock("../../cantrip_app/src/lib/client-encryption", () => ({
  clientEncryption: {},
}));
vi.mock("../../cantrip_app/src/lib/client-session", () => ({
  clientSessionIdentityMatches: () => false,
  getClientSessionIdentitySnapshot: () => null,
  onClientSessionIdentityChanged: () => () => {},
}));
vi.mock("../../cantrip_app/src/lib/server-connections", () => ({
  getActiveServerUrl: () => {
    throw new Error("Unbound server");
  },
}));

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  let failure: unknown;
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
});
type Fixture = ReturnType<typeof createComputerUsePreviewFixture>;
function viewer(f: Fixture) {
  const { ownerId, serverId, chatId, componentKey } = f.credentials;
  const identity = {
    accountId: null,
    connectionId: "fixture",
    generation: 1,
    incarnationId: "fixture",
    serverId,
    serverUrl: "http://fixture.invalid",
    userId: ownerId,
  };
  const request: NonNullable<ComputerUseClientDependencies["request"]> = async <
    T,
  >(
    url: string,
    init?: RequestInit,
  ) => {
    if (init?.signal?.aborted) throw new Error("Cancelled fixture request.");
    const address = new URL(url);
    f.wire.push(String(init?.body ?? ""));
    const response = await f.app.inject({
      method: "POST",
      url: address.pathname + address.search,
      payload: JSON.parse(String(init?.body ?? "{}")),
    });
    f.wire.push(response.body);
    if (response.statusCode !== 200)
      throw new Error(`Fixture HTTP ${response.statusCode}`);
    return response.json() as T;
  };
  const client = createComputerUseClient(chatId, {
    request,
    sessionIdentity: () => identity,
    identityMatches: (input) =>
      JSON.stringify(input) === JSON.stringify(identity),
    onIdentityChanged: () => () => {},
    serverUrl: () => identity.serverUrl,
    encryption: {
      getSnapshot: () => ({
        clientId: "fixture",
        identity: { ownerId, serverId },
        masterKeyRevision: 1,
        status: "ready",
      }),
      componentKey: () => componentKey.slice(),
      subscribe: () => () => {},
    },
  });
  cleanup.push(() => client.dispose());
  return client;
}
const meta = (threadId = "root") => ({
  threadId,
  "x-codex-turn-metadata": { turn_id: `${threadId}-turn` },
});
const capture = (target = "fake-monitor") =>
  `await cua.attach({ targetId: '${target}', targetGeneration: 1 }); await cua.configureCursor({ version: 1, visible: true, style: 'dot', color: '#FF0066', size: 16, label: 'Private observer cursor', trail: false }); await cua.moveCursor({ x: 50, y: 40 }); await cua.snapshot();`;
async function fixture(
  profile = ":yolo",
  afterChunkPublished?: Parameters<
    typeof createComputerUsePreviewFixture
  >[0]["afterChunkPublished"],
  contentDomain: "chat" | "task" = "chat",
) {
  let agents!: CuaAgentCoordinator;
  let activityQueue = Promise.resolve();
  let activityFailure: unknown;
  const f = createComputerUsePreviewFixture({
    binary: process.env.CANTRIP_CUA_TEST_BINARY!,
    permissionProfile: profile,
    afterChunkPublished,
    context: {
      experience: contentDomain === "task" ? "task" : "agent",
      contextKind: "project",
      projectId: "fixture-project",
      worktreeId: "fixture-worktree",
      scratchRootId: null,
      rootKind: "git-worktree",
      isPrimary: false,
    },
    agentObservations: {
      listObservations: (authority) => agents.listObservations(authority),
      readObservation: (authority, sourceId) =>
        agents.readObservation(authority, sourceId),
    },
    onRevokeChat: (chatId) => agents.cancelChat(chatId),
  });
  cleanup.push(async () => {
    await activityQueue;
    await f.close();
    if (activityFailure) throw activityFailure;
  });
  const events = new CuaAgentApprovalEvents();
  const approvals = new CuaApprovalManager({
    workerId: f.credentials.workerId,
    encryption: f.encryption,
    onTerminal: (event) => {
      events.terminal(event);
    },
  });
  cleanup.push(() => approvals.close());
  const authority = (): CuaAgentAuthority => ({
    ...computerUsePreviewAuthority({
      ownerId: f.credentials.ownerId,
      serverId: f.credentials.serverId,
      context: f.context,
    }),
    executionLaneId: f.context.executionLaneId,
  });
  agents = new CuaAgentCoordinator({
    service: f.service,
    approvals,
    events,
    identity: () => ({
      ownerId: f.credentials.ownerId,
      serverId: f.credentials.serverId,
      workerId: f.credentials.workerId,
    }),
    authority: async () => authority(),
  });
  const native = { root: new AbortController(), child: new AbortController() };
  const publications: CuaAgentApprovalEvent[] = [];
  let approvedRequest!: () => void;
  const pendingApproval = new Promise<void>((resolve) => {
    approvedRequest = resolve;
  });
  const sealer =
    contentDomain === "task"
      ? new EncryptedTaskEventSealer(
          f.encryption as WorkerEncryptionService,
          "default",
        )
      : new EncryptedChatEventSealer(
          f.encryption as WorkerEncryptionService,
          f.credentials.chatId,
          { explanation: null, steps: [], question: null },
        );
  const unregister = agents.register({
    ...authority(),
    initialAuthority: authority(),
    taskId: contentDomain === "task" ? "fixture-chat" : null,
    rootThreadId: "root",
    publishActivity: (activity) => {
      activityQueue = activityQueue
        .then(async () => {
          const event = await sealer.activity(activity);
          f.wire.push(JSON.stringify(event));
          if (event.type === "agent.protected-task-message")
            await f.activityPersistence.upsertLiveTaskMessage(
              f.credentials.ownerId,
              f.credentials.chatId,
              event.message,
            );
          else
            await f.activityPersistence.upsertLiveEncryptedChatMessage(
              f.credentials.ownerId,
              f.credentials.chatId,
              event.message,
            );
        })
        .catch((error: unknown) => {
          activityFailure ??= error;
        });
    },
    ownsThread: (threadId) => threadId in native,
    publish: async (event) => {
      publications.push(event);
      if (event.type === "computer-use.approval.request") approvedRequest();
    },
    resolve: ({ chatId, threadId, turnId }) =>
      threadId in native && turnId === `${threadId}-turn`
        ? {
            chatId,
            threadId,
            turnId,
            rootThreadId: "root",
            rootTurnId: "root-turn",
            parentThreadId: threadId === "root" ? null : "root",
            agentScope: {
              agentThreadId: threadId,
              rootThreadId: "root",
              parentThreadId: threadId === "root" ? null : "root",
              rootTurnId: "root-turn",
              agentPath: threadId === "root" ? ["root"] : ["root", "child"],
              nickname: null,
              role: null,
              depth: threadId === "root" ? 0 : 1,
              isRoot: threadId === "root",
            },
            signal: native[threadId as keyof typeof native].signal,
          }
        : null,
  });
  cleanup.push(unregister);
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-agent-observation-"),
  );
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const broker = new CantripMcpBroker({
    dataDirectory: directory,
    serverUrl: "https://fixture.invalid",
    token: "fixture-token",
    workerId: f.credentials.workerId,
  });
  broker.setComputerUseExecutor((...args) => agents.execute(...args));
  await broker.start();
  cleanup.push(() => broker.close());
  const attachment = broker.createBinding({
    ownerId: f.credentials.ownerId,
    workerId: f.credentials.workerId,
    chatId: f.credentials.chatId,
    contextKind: "project",
    projectId: "fixture-project",
    executionLaneId: f.context.executionLaneId,
    worktreeId: "fixture-worktree",
    rootKind: "git-worktree",
    scratchRootId: null,
    permissionProfileId: profile,
    allowedOperations: ["context.get"],
    computerUse: true,
  });
  const workerDirectory = fileURLToPath(
    new URL("../../cantrip_worker", import.meta.url),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      path.join(workerDirectory, "src/mcp/cua-stdio.ts"),
      "--connection",
      attachment.connectionPath,
    ],
    cwd: workerDirectory,
    stderr: "pipe",
  });
  const mcp = new Client({ name: "agent-preview-roundtrip", version: "1.0.0" });
  await mcp.connect(transport);
  cleanup.push(() => mcp.close());
  const call = (script: string, threadId = "root") =>
    mcp.callTool({ name: "js", arguments: { script }, _meta: meta(threadId) });
  return {
    f,
    agents,
    approvals,
    authority,
    native,
    mcp,
    call,
    pendingApproval,
    publications,
    complete: unregister,
    sealer,
    snapshots: vi.spyOn(f.service, "snapshot"),
    drainActivities: async () => {
      await activityQueue;
      if (activityFailure) throw activityFailure;
    },
  };
}
type Source = {
  sourceId: string;
  rootThreadId: string;
  binding: { threadId: string; turnId: string; sessionId: string };
  target: { bounds: { x: number; y: number } };
  observationRevision: number;
  cursorRevision: number;
  observedAtMs: number;
};
function data(result: Awaited<ReturnType<ComputerUseClient["operation"]>>) {
  if (result.content.status !== "ok")
    throw new Error(`Observation operation failed: ${result.content.code}`);
  return result.content.data;
}
const list = async (
  client: ComputerUseClient,
  lease: Awaited<ReturnType<ComputerUseClient["open"]>>,
) =>
  (
    data(
      await client.operation(lease, { operation: "agent.sources.list" }),
    ) as { sources: Source[] }
  ).sources;
function modelImage(result: Awaited<ReturnType<Client["callTool"]>>) {
  expect(result.isError).not.toBe(true);
  const content = result.content as Array<{ type: string; data: string }>;
  const image = content.find((item) => item.type === "image");
  if (!image) throw new Error("MCP result did not contain an image.");
  return Buffer.from(image.data, "base64");
}

async function recordedActivities(f: Fixture) {
  const { ownerId, componentKey } = f.credentials;
  const decrypted = await Promise.all([
    ...[...f.chatActivities.values()].map((message) =>
      decryptChatMessageProtectedContent({
        ownerId,
        componentKey,
        messageId: message.id,
        keyRevision: 1,
        encrypted: message.protectedContent,
        publicClassification: message.classification,
      }),
    ),
    ...[...f.taskActivities.values()].map((message) =>
      decryptTaskMessageProtectedContent({
        ownerId,
        componentKey,
        messageId: message.id,
        keyRevision: 1,
        encrypted: message.protectedContent,
        publicClassification: message.classification,
      }),
    ),
  ]);
  return decrypted
    .flatMap((message) =>
      message.content.flatMap((part) =>
        part.type === "activity"
          ? [agentActivitySchema.parse(part.activity)]
          : [],
      ),
    )
    .filter((activity) => activity.type === "computerUse");
}

describe.skipIf(!process.env.CANTRIP_CUA_TEST_BINARY)(
  "actual managed MCP image observed through protected preview",
  () => {
    it("shares exact model pixels with two observers without a second capture or desktop-origin offset", async () => {
      const t = await fixture();
      const first = viewer(t.f),
        second = viewer(t.f);
      const lease = await first.open(),
        other = await second.open();
      expect(await list(first, lease)).toEqual([]);
      expect(t.f.launchCount).toBe(0);
      const bytes = modelImage(await t.call(capture()));
      cleanup.push(() => {
        bytes.fill(0);
      });
      const sources = await list(first, lease);
      expect(sources).toHaveLength(1);
      const source = sources[0]!;
      expect(source.rootThreadId).toBe("root");
      expect(source.observationRevision).toBeGreaterThan(0);
      expect(source.cursorRevision).toBeGreaterThan(0);
      expect(source.observedAtMs).toBeGreaterThan(0);
      expect(source.binding).toMatchObject({
        threadId: "root",
        turnId: "root-turn",
      });
      expect(source.target.bounds).toMatchObject({ x: -320, y: -90 });
      expect(await list(second, other)).toEqual(sources);
      const digest = createHash("sha256").update(bytes).digest("hex");
      const requireWorker = createRequire(
        new URL("../../cantrip_worker/package.json", import.meta.url),
      );
      const sharp = requireWorker("sharp") as typeof import("sharp");
      for (const [client, currentLease] of [
        [first, lease],
        [second, other],
      ] as const) {
        const response = await client.operation(currentLease, {
          operation: "agent.observation.get",
          sourceId: source.sourceId,
        });
        try {
          const observation = data(response) as CuaSnapshot & {
            source: Source;
            nativeImage: CuaSnapshot["image"];
          };
          expect(observation.source).toEqual(source);
          expect(observation.image.sha256).toBe(digest);
          expect(observation.nativeImage.sha256).toBe(digest);
          expect(Buffer.from(response.bytes!)).toEqual(bytes);
          expect(observation.session.binding.threadId).toBe("root");
          const decoded = await sharp(response.bytes!)
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
          try {
            expect(decoded.info).toMatchObject({ width: 640, height: 360 });
            const offset = (80 * 640 + 100) * 4;
            expect([...decoded.data.subarray(offset, offset + 4)]).toEqual([
              255, 0, 102, 255,
            ]);
          } finally {
            decoded.data.fill(0);
          }
        } finally {
          response.bytes?.fill(0);
        }
      }
      expect(t.snapshots).toHaveBeenCalledTimes(1);
      first.dispose();
      expect(await list(second, other)).toEqual(sources);
      const continued = await second.operation(other, {
        operation: "agent.observation.get",
        sourceId: source.sourceId,
      });
      expect(continued.content.status).toBe("ok");
      continued.bytes?.fill(0);
      expect(t.snapshots).toHaveBeenCalledTimes(1);
      const wire = t.f.wire.join("\n") + t.f.logs.join("\n");
      for (const secret of [
        bytes.toString("base64"),
        "Private observer cursor",
        "CUA fixture monitor",
      ])
        expect(wire.includes(secret)).toBe(false);
    }, 20000);

    it("keeps root/child observations distinct and invalidates reset, completion, and Stop sources", async () => {
      const t = await fixture();
      const client = viewer(t.f);
      const lease = await client.open();
      modelImage(await t.call(capture())).fill(0);
      modelImage(await t.call(capture("fake-window"), "child")).fill(0);
      const before = await list(client, lease);
      expect(before).toHaveLength(2);
      const root = before.find((source) => source.binding.threadId === "root")!;
      const child = before.find(
        (source) => source.binding.threadId === "child",
      )!;
      expect(root.sourceId).not.toBe(child.sourceId);
      expect(root.binding.sessionId).not.toBe(child.binding.sessionId);
      const childImage = await client.operation(lease, {
        operation: "agent.observation.get",
        sourceId: child.sourceId,
      });
      expect((data(childImage) as CuaSnapshot).image).toMatchObject({
        width: 320,
        height: 200,
      });
      childImage.bytes?.fill(0);
      await t.mcp.callTool({ name: "js_reset", arguments: {}, _meta: meta() });
      expect(await list(client, lease)).toEqual([child]);
      const stale = await client.operation(lease, {
        operation: "agent.observation.get",
        sourceId: root.sourceId,
      });
      expect(stale.content.status).toBe("error");
      expect(stale.bytes).toBeNull();
      t.native.child.abort();
      expect(await list(client, lease)).toEqual([]);
      modelImage(await t.call(capture())).fill(0);
      await client.stop(lease);
      expect(t.f.service.status().sessions).toBe(0);
      const resumed = viewer(t.f);
      const next = await resumed.open();
      expect(await list(resumed, next)).toEqual([]);
      expect((await t.call(capture())).isError).toBe(true);
    }, 20000);

    it("invalidates the previous evaluation and clears the completed command's last source", async () => {
      const t = await fixture();
      const client = viewer(t.f);
      const lease = await client.open();
      modelImage(await t.call(capture())).fill(0);
      const previous = (await list(client, lease))[0]!;
      const result = await t.call("await cua.targets();");
      expect(result.isError).not.toBe(true);
      expect(await list(client, lease)).toEqual([]);
      const stale = await client.operation(lease, {
        operation: "agent.observation.get",
        sourceId: previous.sourceId,
      });
      expect(stale.content.status).toBe("error");
      expect(stale.bytes).toBeNull();
      modelImage(await t.call(capture())).fill(0);
      const latest = (await list(client, lease))[0]!;
      expect(latest.sourceId).not.toBe(previous.sourceId);
      await t.complete();
      expect(await list(client, lease)).toEqual([]);
      const completed = await client.operation(lease, {
        operation: "agent.observation.get",
        sourceId: latest.sourceId,
      });
      expect(completed.content.status).toBe("error");
      expect(completed.bytes).toBeNull();
      expect(t.f.service.status().sessions).toBe(0);
      expect(t.snapshots).toHaveBeenCalledTimes(2);
    }, 20000);

    it.each([
      "reset",
      "next evaluation",
      "command completion",
      "helper failure",
    ])(
      "withholds the final image when %s retires a source after encrypted chunks reached the server",
      async (retire) => {
        let reached!: () => void;
        let resume!: () => void;
        const chunkPublished = new Promise<void>((resolve) => {
          reached = resolve;
        });
        const continuePublication = new Promise<void>((resolve) => {
          resume = resolve;
        });
        let chunks = 0;
        const t = await fixture(":yolo", async () => {
          chunks++;
          reached();
          await continuePublication;
        });
        const client = viewer(t.f);
        const lease = await client.open();
        modelImage(await t.call(capture())).fill(0);
        const source = (await list(client, lease))[0]!;
        const reads = vi.spyOn(t.agents, "readObservation");
        const pending = client
          .operation(lease, {
            operation: "agent.observation.get",
            sourceId: source.sourceId,
          })
          .then(
            (result) => ({ result, error: null }),
            (error: unknown) => ({ result: null, error }),
          );
        try {
          await Promise.race([
            chunkPublished,
            pending.then(() => {
              throw new Error(
                "Observation completed before the chunk barrier.",
              );
            }),
          ]);
          expect(chunks).toBeGreaterThan(0);
          expect(reads).toHaveBeenCalledTimes(1);
          const inFlight = reads.mock.results[0]!.value as { payload: Buffer };
          expect(inFlight.payload.some((value) => value !== 0)).toBe(true);
          if (retire === "reset") {
            const reset = await t.mcp.callTool({
              name: "js_reset",
              arguments: {},
              _meta: meta(),
            });
            expect(reset.isError).not.toBe(true);
          } else if (retire === "next evaluation") {
            expect((await t.call("await cua.targets();")).isError).not.toBe(
              true,
            );
          } else if (retire === "helper failure") {
            const child = t.f.children[0]!;
            const closed = once(child, "close");
            expect(child.kill("SIGKILL")).toBe(true);
            await closed;
            expect(t.f.service.status()).toMatchObject({
              state: "restart-available",
              sessions: 0,
              lastFailure: "process-exited",
            });
          } else {
            await t.complete();
          }
        } finally {
          resume();
        }
        const completed = await pending;
        expect(completed.error).toBeInstanceOf(Error);
        expect(completed.result).toBeNull();
        expect(reads).toHaveBeenCalledTimes(1);
        const copied = reads.mock.results[0]!.value as { payload: Buffer };
        expect(copied.payload.length).toBeGreaterThan(0);
        expect(copied.payload.every((value) => value === 0)).toBe(true);
        expect(await list(client, lease)).toEqual([]);
        expect(t.snapshots).toHaveBeenCalledTimes(1);
        expect(t.f.launchCount).toBe(1);
      },
      20000,
    );

    it("holds four reader reservations until cancelled encrypted publications actually settle", async () => {
      let reached!: () => void;
      let resume!: () => void;
      let overflow!: () => void;
      const fourPublished = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const continuePublication = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const excessPublication = new Promise<void>((resolve) => {
        overflow = resolve;
      });
      const publishing = new Set<string>();
      let holding = true;
      const t = await fixture(":yolo", async (event) => {
        if (!holding) return;
        publishing.add(event.operationId);
        if (publishing.size === 4) reached();
        if (publishing.size > 4) overflow();
        await continuePublication;
      });
      const clients = Array.from({ length: 5 }, () => viewer(t.f));
      const leases = await Promise.all(clients.map((client) => client.open()));
      modelImage(await t.call(capture())).fill(0);
      const spare = clients[4]!;
      const spareLease = leases[4]!;
      const source = (await list(spare, spareLease))[0]!;
      const reads = vi.spyOn(t.agents, "readObservation");
      const pending = clients.slice(0, 4).map((client, index) =>
        client
          .operation(leases[index]!, {
            operation: "agent.observation.get",
            sourceId: source.sourceId,
          })
          .then(
            (result) => ({ result, error: null }),
            (error: unknown) => ({ result: null, error }),
          ),
      );
      const expectCapacity = async (sourceId: string) => {
        const response = await Promise.race([
          spare.operation(spareLease, {
            operation: "agent.observation.get",
            sourceId,
          }),
          excessPublication.then(() => {
            throw new Error(
              "A fifth reader published image chunks while four buffers remained live.",
            );
          }),
        ]);
        expect(response.content).toMatchObject({
          status: "error",
          code: "capacity",
        });
        expect(response.bytes).toBeNull();
      };
      let latest!: Source;
      try {
        await Promise.race([
          fourPublished,
          ...pending.map((result) =>
            result.then(() => {
              throw new Error(
                "A reader completed before all four publication barriers.",
              );
            }),
          ),
        ]);
        expect(reads).toHaveBeenCalledTimes(4);
        for (const result of reads.mock.results) {
          const read = result.value as { payload: Buffer };
          expect(read.payload.some((byte) => byte !== 0)).toBe(true);
        }
        await expectCapacity(source.sourceId);
        modelImage(await t.call(capture())).fill(0);
        latest = (await list(spare, spareLease))[0]!;
        expect(latest.sourceId).not.toBe(source.sourceId);
        await expectCapacity(latest.sourceId);
      } finally {
        holding = false;
        resume();
      }
      for (const result of await Promise.all(pending)) {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.result).toBeNull();
      }
      const copied = reads.mock.results.filter(
        (result) => result.type === "return",
      );
      expect(copied).toHaveLength(4);
      for (const result of copied) {
        const read = result.value as { payload: Buffer };
        expect(read.payload.every((byte) => byte === 0)).toBe(true);
      }
      const available = await spare.operation(spareLease, {
        operation: "agent.observation.get",
        sourceId: latest.sourceId,
      });
      expect(available.content.status).toBe("ok");
      expect(available.bytes!.length).toBeGreaterThan(0);
      available.bytes?.fill(0);
      expect(t.snapshots).toHaveBeenCalledTimes(2);
    }, 20000);

    it.each(["chat", "task"] as const)(
      "seals actual managed-MCP root/child operations, reset, and script failure into %s messages",
      async (domain) => {
        const t = await fixture(":yolo", undefined, domain);
        modelImage(await t.call(capture())).fill(0);
        modelImage(await t.call(capture("fake-window"), "child")).fill(0);
        const reset = await t.mcp.callTool({
          name: "js_reset",
          arguments: {},
          _meta: meta("child"),
        });
        expect(reset.isError).not.toBe(true);
        const failed = await t.call("throw new Error('PRIVATE SCRIPT ERROR');");
        expect(failed.isError).toBe(true);
        await t.drainActivities();
        const activities = await recordedActivities(t.f);
        expect(activities.length).toBeGreaterThanOrEqual(10);
        for (const activity of activities) {
          expect(activity.source).toBe("agent-mcp");
          expect(activity.binding.chatId).toBe(t.f.credentials.chatId);
          expect(activity.binding.taskId).toBe(
            domain === "task" ? t.f.credentials.chatId : null,
          );
          expect(activity.agentScope?.rootTurnId).toBe("root-turn");
          expect(activity.agentScope?.rootThreadId).toBe("root");
          expect(activity.correlation?.threadId).toBe(
            activity.binding.threadId,
          );
          expect(activity.correlation?.turnId).toBe(activity.binding.turnId);
          expect(activity.completedAtMs).toBeGreaterThanOrEqual(
            activity.startedAtMs,
          );
        }
        const child = activities.filter(
          (activity) => activity.binding.threadId === "child",
        );
        expect(
          child.some(
            (activity) => activity.operation === "observation.snapshot",
          ),
        ).toBe(true);
        for (const activity of child)
          expect(activity.agentScope).toMatchObject({
            parentThreadId: "root",
            agentPath: ["root", "child"],
            depth: 1,
            isRoot: false,
          });
        expect(
          activities.find((activity) => activity.operation === "js.reset"),
        ).toMatchObject({
          binding: { threadId: "child", turnId: "child-turn" },
          outcome: "completed",
        });
        expect(
          activities.some(
            (activity) =>
              activity.operation === "js.evaluate" &&
              activity.outcome === "failed" &&
              activity.binding.threadId === "root",
          ),
        ).toBe(true);
        const wire = t.f.wire.join("\n") + t.f.logs.join("\n");
        for (const secret of [
          "PRIVATE SCRIPT ERROR",
          "Private observer cursor",
          "CUA fixture monitor",
          capture(),
        ])
          expect(wire.includes(secret)).toBe(false);
        expect(
          JSON.stringify(activities).includes("PRIVATE SCRIPT ERROR"),
        ).toBe(false);
        expect(
          domain === "chat" ? t.f.taskActivities.size : t.f.chatActivities.size,
        ).toBe(0);
      },
      20000,
    );

    it.each(["chat", "task"] as const)(
      "releases the actual MCP session and waits for delayed %s terminal sealing before rejecting the runtime turn",
      async (domain) => {
        const t = await fixture(":yolo", undefined, domain);
        let entered!: () => void;
        let resume!: () => void;
        let draining!: () => void;
        const sealEntered = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const continueSeal = new Promise<void>((resolve) => {
          resume = resolve;
        });
        const drainEntered = new Promise<void>((resolve) => {
          draining = resolve;
        });
        const realActivity = t.sealer.activity.bind(t.sealer);
        const sealing = vi
          .spyOn(t.sealer, "activity")
          .mockImplementation(async (activity) => {
            if (
              activity.type === "computerUse" &&
              activity.operation === "js.evaluate"
            ) {
              entered();
              await continueSeal;
            }
            return realActivity(activity);
          });
        const runtimeFailure = new Error(
          "Synthetic original runtime rejection",
        );
        let settled = false;
        const finished = finalizeCuaAgentTurn(
          async () => {
            modelImage(await t.call(capture())).fill(0);
            expect(t.f.service.status().sessions).toBe(1);
            await sealEntered;
            throw runtimeFailure;
          },
          async () => {
            await t.complete();
            expect(t.f.service.status().sessions).toBe(0);
          },
          async () => {
            draining();
            await t.drainActivities();
          },
        ).then(
          () => {
            settled = true;
            return null;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );
        try {
          await Promise.race([
            drainEntered,
            finished.then(() => {
              throw new Error(
                "Runtime settled before draining protected activities.",
              );
            }),
          ]);
          expect(settled).toBe(false);
          expect(t.f.service.status().sessions).toBe(0);
          expect(t.snapshots).toHaveBeenCalledTimes(1);
          const before = await recordedActivities(t.f);
          expect(
            before.some(
              (activity) => activity.operation === "observation.snapshot",
            ),
          ).toBe(true);
          expect(
            before.some((activity) => activity.operation === "js.evaluate"),
          ).toBe(false);
        } finally {
          resume();
        }
        expect(await finished).toBe(runtimeFailure);
        const after = await recordedActivities(t.f);
        expect(
          after.filter((activity) => activity.operation === "js.evaluate"),
        ).toHaveLength(1);
        expect(
          after.find((activity) => activity.operation === "js.evaluate"),
        ).toMatchObject({
          source: "agent-mcp",
          outcome: "completed",
          binding: { threadId: "root", turnId: "root-turn" },
        });
        expect(t.f.service.status().sessions).toBe(0);
        sealing.mockRestore();
      },
      20000,
    );

    it("rejects foreign preview scope and stale durable authority before publishing pixels", async () => {
      const t = await fixture();
      const client = viewer(t.f);
      const lease = await client.open();
      modelImage(await t.call(capture())).fill(0);
      const source = (await list(client, lease))[0]!;
      for (const field of ["chatId", "workerId"] as const) {
        const { executionLaneId: _lane, ...previewAuthority } = t.authority();
        const foreign = { ...previewAuthority, [field]: "foreign" };
        await expect(
          Promise.resolve().then(() =>
            t.agents.readObservation(foreign, source.sourceId),
          ),
        ).rejects.toThrow();
        await expect(
          client.operation(
            { ...lease, [field]: "foreign" },
            { operation: "agent.observation.get", sourceId: source.sourceId },
          ),
        ).rejects.toThrow();
      }
      t.f.context.computerUseAuthorityGeneration++;
      await expect(
        client.operation(lease, {
          operation: "agent.observation.get",
          sourceId: source.sourceId,
        }),
      ).rejects.toThrow();
      expect(t.snapshots).toHaveBeenCalledTimes(1);
    }, 20000);

    it("records an explicit encrypted approval denial for the actual managed-MCP host action", async () => {
      const t = await fixture(":workspace");
      const pending = t.call("await cua.targets()");
      await Promise.race([
        t.pendingApproval,
        pending.then(() => {
          throw new Error("MCP completed before approval.");
        }),
      ]);
      const event = t.publications.find(
        (event) => event.type === "computer-use.approval.request",
      )!;
      if (event.type !== "computer-use.approval.request")
        throw new Error("Expected approval.");
      const classification = { kind: "permissions" as const };
      await t.agents.answer({
        type: "computer-use.approval.respond",
        ownerId: t.f.credentials.ownerId,
        chatId: t.f.credentials.chatId,
        executionLaneId: t.f.context.executionLaneId,
        requestKey: event.request.requestKey,
        agentAuthority: t.authority(),
        response: {
          classification,
          protectedResponse: await encryptInteractionResponseContent({
            ownerId: t.f.credentials.ownerId,
            requestKey: event.request.requestKey,
            keyRevision: 1,
            componentKey: t.f.credentials.componentKey,
            content: {
              version: 1,
              classification,
              response: {
                kind: "permissions",
                permissions: {},
                scope: "session",
                strictAutoReview: false,
              },
            },
          }),
        },
      });
      expect((await pending).isError).toBe(true);
      await t.drainActivities();
      const actions = await recordedActivities(t.f);
      expect(
        actions.find((activity) => activity.operation === "targets.list"),
      ).toMatchObject({
        outcome: "declined",
        errorCode: "denied",
        binding: { threadId: "root", turnId: "root-turn" },
      });
      expect(t.snapshots).not.toHaveBeenCalled();
      expect(t.f.service.status().sessions).toBe(0);
    }, 20000);

    it("preview Stop cancels a pending agent approval before any observation exists", async () => {
      const t = await fixture(":workspace");
      const client = viewer(t.f);
      const lease = await client.open();
      const pending = t.call("await cua.targets()");
      await Promise.race([
        t.pendingApproval,
        pending.then((result) => {
          throw new Error(`MCP ended before approval: ${result.isError}`);
        }),
      ]);
      await client.stop(lease);
      expect((await pending).isError).toBe(true);
      await t.drainActivities();
      const actions = (await recordedActivities(t.f)).filter(
        (activity) => activity.source === "agent-mcp",
      );
      expect(actions.some((activity) => activity.outcome === "cancelled")).toBe(
        true,
      );
      expect(t.approvals.status().pending).toBe(0);
      expect(
        t.publications.some(
          (event) => event.type === "computer-use.approval.terminal",
        ),
      ).toBe(true);
      expect(t.snapshots).not.toHaveBeenCalled();
      expect((await t.call("await cua.targets()")).isError).toBe(true);
    }, 20000);
  },
);
