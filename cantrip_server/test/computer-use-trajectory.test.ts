import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decryptChatMessageProtectedContent,
  decryptTaskMessageProtectedContent,
  decryptEndpointContentPayload,
  encryptEndpointContentPayload,
  openComputerUseResult,
  protectComputerUseRequest,
} from "../../packages/crypto/src/index.js";
import { agentActivitySchema } from "@cantrip/protocol";
import {
  computerUseHttpResultSchema,
  cuaSessionResultSchema,
  type ComputerUseAction,
} from "@cantrip/protocol/computer-use";
import {
  cuaPreviewLeaseSchema,
  type CuaPreviewLease,
} from "@cantrip/protocol/computer-use-preview";
import { createComputerUsePreviewFixture } from "./support/computer-use-preview-fixture.js";

type Fixture = ReturnType<typeof createComputerUsePreviewFixture>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
function fixture(domain: "chat" | "task", permissionProfile = ":yolo") {
  const f = createComputerUsePreviewFixture({
    binary: process.env.CANTRIP_CUA_TEST_BINARY!,
    permissionProfile,
    context: {
      experience: domain === "task" ? "task" : "agent",
      contextKind: "project",
      projectId: "fixture-project",
      worktreeId: "fixture-worktree",
      scratchRootId: null,
      status: "idle",
      threadId: "previous-real-agent-thread",
    },
  });
  fixtures.push(f);
  return f;
}
async function open(f: Fixture) {
  const response = await f.app.inject({
    method: "POST",
    url: `/api/chats/${f.credentials.chatId}/computer-use/preview`,
    payload: {},
  });
  expect(response.statusCode).toBe(200);
  return cuaPreviewLeaseSchema.parse(response.json());
}
async function perform(
  f: Fixture,
  lease: CuaPreviewLease,
  action: ComputerUseAction,
) {
  const { ownerId, serverId, workerId, chatId, componentKey } = f.credentials;
  const context = {
    serverId,
    workerId,
    chatId,
    operationId: randomUUID(),
    operation: action.operation,
    previewLeaseId: lease.leaseId,
  };
  const body = await protectComputerUseRequest({
    context,
    request: action,
    seal: (context, plaintext) =>
      encryptEndpointContentPayload({
        ownerId,
        context,
        plaintext,
        keyRevision: 1,
        componentKey,
      }),
  });
  const response = await f.app.inject({
    method: "POST",
    url: `/api/chats/${chatId}/computer-use/operation`,
    payload: body,
  });
  expect(response.statusCode).toBe(200);
  const envelope = computerUseHttpResultSchema.parse(response.json());
  const opened = await openComputerUseResult({
    context,
    opaque: envelope.response,
    chunks: envelope.chunks,
    open: (context, opaque) =>
      decryptEndpointContentPayload({
        ownerId,
        context,
        opaque,
        componentKey,
        keyRevision: 1,
      }),
  });
  return { ...opened, operationId: context.operationId };
}
async function activities(f: Fixture) {
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
    .map((activity) => {
      if (activity.type !== "computerUse")
        throw new Error("Unexpected activity type.");
      return activity;
    });
}
async function stop(f: Fixture, lease: CuaPreviewLease) {
  const response = await f.app.inject({
    method: "POST",
    url: `/api/chats/${f.credentials.chatId}/computer-use/preview/stop`,
    payload: { leaseId: lease.leaseId, workerId: lease.workerId },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ closed: true });
}

describe.skipIf(!process.env.CANTRIP_CUA_TEST_BINARY)(
  "actual preview operations in protected Trajectory",
  () => {
    it.each(["chat", "task"] as const)(
      "records idle %s actions, logical cursor, image metadata, failure and Stop without inventing an agent turn",
      async (domain) => {
        const f = fixture(domain);
        const lease = await open(f);
        expect(await activities(f)).toEqual([]);
        const target = { targetId: "fake-monitor", targetGeneration: 1 };
        const attached = await perform(f, lease, {
          operation: "session.open",
          ...target,
        });
        expect(attached.result.status).toBe("ok");
        if (attached.result.status !== "ok") throw new Error("Attach failed.");
        const session = cuaSessionResultSchema.parse(
          attached.result.data,
        ).session;
        await perform(f, lease, {
          operation: "cursor.configure",
          sessionId: session.binding.sessionId,
          ...target,
          appearance: {
            version: 1,
            style: "dot",
            color: "#FF0066",
            size: 16,
            label: "PRIVATE CUA CURSOR",
            trail: false,
            visible: true,
          },
        });
        await perform(f, lease, {
          operation: "cursor.move",
          sessionId: session.binding.sessionId,
          ...target,
          position: { x: 50, y: 40 },
        });
        const image = await perform(f, lease, {
          operation: "observation.snapshot",
          sessionId: session.binding.sessionId,
          ...target,
        });
        expect(image.payload).not.toBeNull();
        const digest = createHash("sha256")
          .update(image.payload!)
          .digest("hex");
        const imageBase64 = Buffer.from(image.payload!).toString("base64");
        image.payload!.fill(0);
        const failed = await perform(f, lease, {
          operation: "cursor.move",
          sessionId: session.binding.sessionId,
          targetId: "wrong-target",
          targetGeneration: 1,
          position: { x: 1, y: 1 },
        });
        expect(failed.result.status).toBe("error");
        await stop(f, lease);
        const all = await activities(f);
        expect(all).toHaveLength(6);
        expect(
          domain === "chat" ? f.taskActivities.size : f.chatActivities.size,
        ).toBe(0);
        for (const activity of all) {
          expect(activity.source).toBe("user-preview");
          expect(activity.binding).toMatchObject({
            chatId: f.credentials.chatId,
            workerId: f.credentials.workerId,
            threadId: null,
            turnId: null,
          });
          expect(activity.binding.taskId).toBe(
            domain === "task" ? f.credentials.chatId : null,
          );
          expect(activity.agentScope).toBeUndefined();
          expect(activity.correlation?.threadId ?? null).toBeNull();
          expect(activity.correlation?.turnId ?? null).toBeNull();
          expect(activity.completedAtMs).toBeGreaterThanOrEqual(
            activity.startedAtMs,
          );
          expect(activity.durationMs).toBeGreaterThanOrEqual(0);
        }
        const snapshot = all.find(
          (activity) => activity.operationId === image.operationId,
        )!;
        expect(snapshot).toMatchObject({
          outcome: "completed",
          target,
          cursor: { position: { x: 50, y: 40 } },
          observation: { image: { sha256: digest, width: 640, height: 360 } },
        });
        expect(
          all.find((activity) => activity.operationId === failed.operationId),
        ).toMatchObject({ outcome: "failed", status: "failed" });
        expect(all.at(-1)).toMatchObject({
          operation: "preview.stop",
          outcome: "completed",
        });
        const protectedWire =
          f.wire.join("\n") +
          f.logs.join("\n") +
          JSON.stringify([
            ...f.chatActivities.values(),
            ...f.taskActivities.values(),
          ]);
        for (const secret of [
          "PRIVATE CUA CURSOR",
          "CUA fixture monitor",
          imageBase64,
        ])
          expect(protectedWire.includes(secret)).toBe(false);
        expect(JSON.stringify(all).includes(imageBase64)).toBe(false);
        expect(JSON.stringify(all).includes("CUA fixture monitor")).toBe(false);
        expect(f.service.status().sessions).toBe(0);
      },
      20000,
    );

    it("completes actual Stop when durable activity insertion fails and reports only a fixed diagnostic", async () => {
      const f = fixture("chat");
      const lease = await open(f);
      await perform(f, lease, {
        operation: "session.open",
        targetId: "fake-window",
        targetGeneration: 1,
      });
      expect(f.service.status().sessions).toBe(1);
      const before = f.chatActivities.size;
      const write = vi.spyOn(f.chatActivities, "set").mockImplementation(() => {
        throw new Error("PRIVATE DATABASE FAILURE");
      });
      try {
        await stop(f, lease);
      } finally {
        write.mockRestore();
      }
      expect(f.service.status().sessions).toBe(0);
      expect(f.coordinator.status().previews).toBe(0);
      expect(f.chatActivities.size).toBe(before);
      expect(f.logs.join("\n")).toContain(
        "computer-use.activity.publication-failed",
      );
      expect(f.logs.join("\n")).not.toContain("PRIVATE DATABASE FAILURE");
    }, 20000);

    it("reports successful Stop and a fixed audit failure when the worker loses its encryption key", async () => {
      const f = fixture("chat");
      const lease = await open(f);
      await perform(f, lease, {
        operation: "session.open",
        targetId: "fake-window",
        targetGeneration: 1,
      });
      const before = f.chatActivities.size;
      const key = vi
        .spyOn(f.encryption, "componentKey")
        .mockImplementation(() => {
          throw new Error("PRIVATE KEY FAILURE");
        });
      try {
        await stop(f, lease);
      } finally {
        key.mockRestore();
      }
      expect(f.service.status().sessions).toBe(0);
      expect(f.coordinator.status().previews).toBe(0);
      expect(f.chatActivities.size).toBe(before);
      expect(f.logs.join("\n")).toContain(
        "computer-use.activity.publication-failed",
      );
      expect(f.logs.join("\n")).not.toContain("PRIVATE KEY FAILURE");
    }, 20000);

    it("records approval refusal before any helper starts, and Stop remains available", async () => {
      const f = fixture("chat", ":workspace");
      const lease = await open(f);
      const blocked = await perform(f, lease, {
        operation: "session.open",
        targetId: "fake-window",
        targetGeneration: 1,
      });
      expect(blocked.result).toMatchObject({
        status: "error",
        code: "approval-required",
      });
      expect(f.launchCount).toBe(0);
      const all = await activities(f);
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        operationId: blocked.operationId,
        errorCode: "approval-required",
        source: "user-preview",
      });
      await stop(f, lease);
      expect((await activities(f)).at(-1)).toMatchObject({
        operation: "preview.stop",
        outcome: "completed",
      });
      expect(f.launchCount).toBe(0);
    }, 20000);
  },
);
