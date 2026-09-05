import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  decryptInteractionRequestContent,
  encryptInteractionResponseContent,
} from "@cantrip/crypto";
import {
  agentActivitySchema,
  agentInteractionRequestPayloadSchema,
} from "@cantrip/protocol";
import type { CuaAgentAuthority } from "@cantrip/protocol/computer-use-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CantripMcpBroker } from "../mcp/broker.js";
import { CuaAgentCoordinator } from "./agent.js";
import type { CuaActivity } from "./activity.js";
import {
  CuaAgentApprovalEvents,
  type CuaAgentApprovalEvent,
} from "./agent-approval-events.js";
import { CuaApprovalManager } from "./approvals.js";
import { CantripCuaService } from "./service.js";
import { launchCuaTransport } from "./transport.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const key = new Uint8Array(32).fill(17);
const identity = { ownerId: "owner", serverId: "server", workerId: "worker" };
const claims = {
  ownerId: "owner",
  workerId: "worker",
  chatId: "chat",
  projectId: "project",
  contextKind: "project" as const,
  executionLaneId: "lane",
  worktreeId: "worktree",
  rootKind: "git-worktree" as const,
  scratchRootId: null,
  permissionProfileId: ":yolo",
  allowedOperations: ["context.get"] as ["context.get"],
};
function metadata(threadId = "root") {
  return { threadId, "x-codex-turn-metadata": { turn_id: `${threadId}-turn` } };
}
async function fixture(
  profile = ":yolo",
  autoApprove: boolean | "deny" | "stale" = true,
) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cua-agent-integration-"),
  );
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const launch = vi.fn(launchCuaTransport);
  const service = new CantripCuaService({
    workerId: "worker",
    binary: process.env.CANTRIP_CUA_TEST_BINARY!,
    args: ["--backend", "fake"],
    launch,
  });
  cleanup.push(() => service.close());
  const events = new CuaAgentApprovalEvents();
  const approvals = new CuaApprovalManager({
    workerId: "worker",
    encryption: {
      ownerId: () => "owner",
      serverIdentity: () => "server",
      componentKey: () => ({ key: key.slice(), keyRevision: 1 }),
    },
    onTerminal: (terminal) => {
      events.terminal(terminal);
    },
  });
  cleanup.push(async () => approvals.close());
  const authority: CuaAgentAuthority = {
    ...identity,
    chatId: "chat",
    projectId: "project",
    contextKind: "project",
    executionLaneId: "lane",
    placementId: "worktree",
    generation: 1,
    profile: {
      selectedId: profile,
      effectiveId: profile,
      forcedByWorktreePolicy: false,
      usesDefault: false,
    },
  };
  const coordinator = new CuaAgentCoordinator({
    identity: () => identity,
    service,
    approvals,
    events,
    authority: async () => structuredClone(authority),
  });
  const native = { root: new AbortController(), child: new AbortController() };
  const published: CuaAgentApprovalEvent[] = [];
  const activities: CuaActivity[] = [];
  let notify!: () => void;
  const firstApproval = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const publish = async (event: CuaAgentApprovalEvent) => {
    published.push(event);
    if (event.type !== "computer-use.approval.request") return;
    notify();
    if (!autoApprove) return;
    const request = event.request;
    const opened = await decryptInteractionRequestContent({
      ownerId: "owner",
      requestKey: request.requestKey,
      keyRevision: 1,
      componentKey: key,
      encrypted: request.protectedPayload,
      publicClassification: request.classification,
    });
    const payload = agentInteractionRequestPayloadSchema.parse(opened.payload);
    if (payload.kind !== "permissions")
      throw new Error("Expected permission request");
    const classification = { kind: "permissions" as const };
    await coordinator.answer({
      type: "computer-use.approval.respond",
      ownerId: "owner",
      chatId: "chat",
      executionLaneId: "lane",
      requestKey: request.requestKey,
      agentAuthority:
        autoApprove === "stale"
          ? { ...authority, generation: authority.generation + 1 }
          : authority,
      response: {
        classification,
        protectedResponse: await encryptInteractionResponseContent({
          ownerId: "owner",
          requestKey: request.requestKey,
          keyRevision: 1,
          componentKey: key,
          content: {
            version: 1,
            classification,
            response: {
              kind: "permissions",
              permissions:
                autoApprove === "deny" ? {} : payload.requestedPermissions,
              scope: "session",
              strictAutoReview: false,
            },
          },
        }),
      },
    });
  };
  const unregister = coordinator.register({
    ...identity,
    initialAuthority: structuredClone(authority),
    chatId: "chat",
    projectId: "project",
    contextKind: "project",
    placementId: "worktree",
    executionLaneId: "lane",
    taskId: "task",
    rootThreadId: "root",
    ownsThread: (threadId: string) => threadId in native,
    publish,
    publishActivity: (activity) => {
      activities.push(agentActivitySchema.parse(activity) as CuaActivity);
    },
    resolve: ({ chatId, threadId, turnId }) => {
      if (!(threadId in native) || turnId !== `${threadId}-turn`) return null;
      return {
        chatId,
        threadId,
        turnId,
        rootThreadId: "root",
        rootTurnId: "root-turn",
        parentThreadId: threadId === "root" ? null : "root",
        agentScope: {
          agentThreadId: threadId,
          rootThreadId: "root",
          rootTurnId: "root-turn",
          nickname: null,
          role: null,
          parentThreadId: threadId === "root" ? null : "root",
          isRoot: threadId === "root",
          depth: threadId === "root" ? 0 : 1,
          agentPath: threadId === "root" ? ["root"] : ["root", "child"],
        },
        signal: native[threadId as keyof typeof native].signal,
      };
    },
  });
  cleanup.push(unregister);
  const broker = new CantripMcpBroker({
    dataDirectory: directory,
    serverUrl: "https://example.invalid",
    token: "worker-token",
    workerId: "worker",
  });
  broker.setComputerUseExecutor((...args) => coordinator.execute(...args));
  await broker.start();
  cleanup.push(() => broker.close());
  const attachment = broker.createBinding({ ...claims, computerUse: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      path.resolve("src/mcp/cua-stdio.ts"),
      "--connection",
      attachment.connectionPath,
    ],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({ name: "actual-rust-cua", version: "1.0.0" });
  await client.connect(transport);
  cleanup.push(() => client.close());
  const call = (script: string, threadId = "root") =>
    client.callTool({
      name: "js",
      arguments: { script },
      _meta: metadata(threadId),
    });
  return {
    client,
    coordinator,
    service,
    approvals,
    published,
    activities,
    firstApproval,
    launch,
    native,
    call,
    authority,
  };
}
function value(result: Awaited<ReturnType<Client["callTool"]>>) {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content.find((item) => item.type === "text")!.text).value;
}

describe.skipIf(!process.env.CANTRIP_CUA_TEST_BINARY)(
  "compiled Rust through managed MCP and current agent authority",
  () => {
    it("delivers PNG content and persistent/reset isolated state through real stdio", async () => {
      const f = await fixture();
      expect(f.launch).not.toHaveBeenCalled();
      const result = await f.call(
        "let secret = 41; await cua.attach({ targetId: 'fake-window', targetGeneration: 1 }); await cua.moveCursor({ x: 20, y: 30 }); await cua.snapshot(); secret",
      );
      expect(value(result)).toBe(41);
      expect(f.activities.map((activity) => activity.operation)).toEqual([
        "target.attach",
        "cursor.move",
        "observation.snapshot",
        "js.evaluate",
      ]);
      for (const activity of f.activities) {
        expect(activity).toMatchObject({
          source: "agent-mcp",
          outcome: "completed",
          binding: {
            chatId: "chat",
            taskId: "task",
            threadId: "root",
            turnId: "root-turn",
          },
          agentScope: {
            agentThreadId: "root",
            rootThreadId: "root",
            isRoot: true,
            depth: 0,
          },
        });
        expect(JSON.stringify(activity.raw)).not.toContain("let secret");
      }
      expect(f.activities[2]!.observation?.image).toMatchObject({
        width: 320,
        height: 200,
      });
      const image = (
        result.content as Array<{ type: string; data: string }>
      ).find((item) => item.type === "image");
      expect(image).toBeDefined();
      expect(Buffer.from(image!.data, "base64").subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      expect(
        await sharp(Buffer.from(image!.data, "base64")).metadata(),
      ).toMatchObject({ width: 320, height: 200, format: "png" });
      expect(value(await f.call("secret += 1; secret"))).toBe(42);
      expect(value(await f.call("typeof secret", "child"))).toBe("undefined");
      expect(f.activities.at(-1)).toMatchObject({
        agentScope: {
          agentThreadId: "child",
          parentThreadId: "root",
          depth: 1,
        },
        binding: { threadId: "child", turnId: "child-turn" },
      });
      const priorSessionId = f.activities[0]!.binding.sessionId;
      await f.call("await cua.detach();");
      expect(f.activities.at(-2)).toMatchObject({
        operation: "target.detach",
        outcome: "completed",
        target: { targetId: "fake-window", targetGeneration: 1 },
        binding: { sessionId: priorSessionId },
      });
      expect(f.activities.at(-1)).toMatchObject({
        operation: "js.evaluate",
        target: null,
      });
      await f.client.callTool({
        name: "js_reset",
        arguments: {},
        _meta: metadata(),
      });
      expect(f.activities.at(-1)).toMatchObject({
        operation: "js.reset",
        outcome: "completed",
        binding: { sessionId: priorSessionId },
      });
      expect(value(await f.call("typeof secret"))).toBe("undefined");
      expect(f.published).toEqual([]);
      f.coordinator.cancelChat("chat");
      expect((await f.call("1")).isError).toBe(true);
    }, 20000);

    it("resumes non-YOLO child capture after exact encrypted approval", async () => {
      const f = await fixture(":workspace");
      const result = await f.call(
        "await cua.attach({ targetId: 'fake-window', targetGeneration: 1 }); await cua.snapshot(); 7",
        "child",
      );
      expect(value(result)).toBe(7);
      expect(f.published.length).toBeGreaterThan(0);
      for (const event of f.published)
        if (event.type === "computer-use.approval.request")
          expect(event.request.provenance).toMatchObject({
            owner: "computer-use",
            threadId: "child",
            turnId: "child-turn",
            workerId: "worker",
            executionLaneId: "lane",
          });
      expect(
        (result.content as Array<{ type: string }>).some(
          (item) => item.type === "image",
        ),
      ).toBe(true);
    }, 20000);

    it.each(["deny", "stale"] as const)(
      "a %s protected approval cannot authorize native capture",
      async (decision) => {
        const f = await fixture(":workspace", decision);
        const result = await f.call(
          "await cua.attach({ targetId: 'fake-window', targetGeneration: 1 }); await cua.snapshot();",
        );
        expect(result.isError).toBe(true);
        expect(
          (result.content as Array<{ type: string }>).some(
            (item) => item.type === "image",
          ),
        ).toBe(false);
        expect(f.approvals.status().grants).toBe(0);
        expect(
          f.activities.some(
            (activity) =>
              activity.operation === "target.attach" &&
              activity.outcome === "declined",
          ),
        ).toBe(decision === "deny");
      },
      20000,
    );

    it("native child completion releases its evaluator and preserves root state", async () => {
      const f = await fixture();
      expect(value(await f.call("let rootValue = 9; rootValue"))).toBe(9);
      expect(
        value(
          await f.call(
            "await cua.attach({ targetId: 'fake-window', targetGeneration: 1 }); let childValue = 3; childValue",
            "child",
          ),
        ),
      ).toBe(3);
      f.native.child.abort();
      expect((await f.call("childValue", "child")).isError).toBe(true);
      expect(value(await f.call("rootValue"))).toBe(9);
    }, 20000);

    it("Stop interrupts an outstanding approval and prevents session reopening", async () => {
      const f = await fixture(":workspace", false);
      const pending = f.call("await cua.targets()");
      await Promise.race([
        f.firstApproval,
        pending.then((result) => {
          throw new Error(JSON.stringify(result));
        }),
      ]);
      f.coordinator.cancelChat("chat");
      expect((await pending).isError).toBe(true);
      expect(
        f.activities.some(
          (activity) =>
            activity.operation === "targets.list" &&
            activity.outcome === "cancelled",
        ),
      ).toBe(true);
      expect((await f.call("await cua.targets()")).isError).toBe(true);
      expect(f.approvals.status().pending).toBe(0);
      expect(
        f.published.some(
          (event) => event.type === "computer-use.approval.terminal",
        ),
      ).toBe(true);
    }, 20000);

    it("records an evaluation error before any host call without retaining source or error text", async () => {
      const f = await fixture();
      expect(
        (await f.call("throw new Error('private-script-secret')")).isError,
      ).toBe(true);
      expect(f.activities).toHaveLength(1);
      expect(f.activities[0]).toMatchObject({
        operation: "js.evaluate",
        outcome: "failed",
      });
      expect(JSON.stringify(f.activities)).not.toContain(
        "private-script-secret",
      );
    }, 20000);
  },
);
