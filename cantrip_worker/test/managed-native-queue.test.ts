import { describe, expect, it, vi } from "vitest";
import {
  ManagedNativeQueue,
  managedQueueGoalHandoff,
  type ManagedNativeQueueRequest,
} from "../src/codex/managed-native-queue.js";
import {
  openNativeCommandContent,
  protectNativeCommandContent,
} from "../src/native-command-content.js";

const identity = {
  serverId: "server",
  ownerId: "owner",
  workerId: "worker",
  chatId: "chat",
  projectId: "project",
  contextKind: "project" as const,
  placementId: "placement",
  threadId: "thread",
  runtimeGeneration: "runtime",
  modelRouteId: "route",
  providerAccountId: null,
};
const encryption = {
  ownerId: () => "owner",
  serverIdentity: () => "server",
  componentKey: (_scope: string, revision = 1) => ({
    key: new Uint8Array(32).fill(12),
    keyRevision: revision,
  }),
};
const item = (id: string, revision = 1) => ({
  id,
  revision,
  idempotencyKey: id,
  input: [{ type: "text", text: id }],
  clientUserMessageId: `message-${id}`,
});
function fixture(items: any[] = []) {
  let snapshot = { revision: 1, paused: true, items, claims: [] };
  const client = {
    lookup: vi.fn(async (_body: any): Promise<any> => ({ found: false })),
    read: vi.fn(async () => snapshot),
    mutate: vi.fn(async (body: any) => {
      const changed = body.mutation;
      if (changed.kind === "add")
        snapshot = {
          ...snapshot,
          revision: snapshot.revision + 1,
          items: [...snapshot.items, changed.prompt],
        };
      return {
        ...snapshot,
        receipt: { ...body.admission, status: "applied" },
        ...(changed.kind === "start" ? { claim: { id: "claim" } } : {}),
        ...(["add", "update"].includes(changed.kind)
          ? { acceptedItem: changed.prompt }
          : {}),
      };
    }),
    startReceipt: vi.fn(),
  };
  const preparePrompt = vi.fn(async ({ request, id, existing }: any) => ({
    prompt: {
      ...existing,
      id,
      revision: 1,
      idempotencyKey: request.params.managed.operationId,
      input: request.params.input,
      clientUserMessageId:
        request.params.clientUserMessageId ?? existing?.clientUserMessageId,
    },
    attachments: [],
  }));
  const queue = new ManagedNativeQueue({
    identity,
    client: client as any,
    encryption,
    policy: {
      cwd: "/tmp",
      codexHome: "/tmp",
      permissionProfileId: ":workspace",
      security: {
        permissions: ":workspace",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
      },
    },
    currentActivationGeneration: () => null,
    preparePrompt,
    openPrompt: async (prompt: any) => ({
      id: prompt.id,
      input: prompt.input,
      clientUserMessageId: prompt.clientUserMessageId,
      managed: { frozen: false, mode: "default", action: "plain" },
    }),
  });
  const request = (
    method: ManagedNativeQueueRequest["method"],
    params: Record<string, unknown> = {},
    signal = new AbortController().signal,
  ) =>
    queue.execute({
      method,
      params: {
        threadId: identity.threadId,
        managed: { operationId: "operation" },
        ...params,
      },
      identity,
      connectionId: "view",
      signal,
      assertCurrent() {},
    });
  return {
    queue,
    client,
    preparePrompt,
    request,
    setSnapshot: (next: typeof snapshot) => {
      snapshot = next;
    },
  };
}

describe("canonical native queue projection", () => {
  it("correlates a goal epoch to its parent queue operation only until its first native attempt owns the handoff", () => {
    const claim = {
      id: "claim",
      awaitingGoal: true,
      status: "dispatched",
      goalEpoch: "goal:4",
      operationId: "queue-parent",
      operationGeneration: "parent-generation",
      goalOperationId: null,
      goalOperationGeneration: null,
    };
    const snapshot = {
      revision: 1,
      paused: false,
      items: [],
      claims: [claim],
    } as any;
    expect(managedQueueGoalHandoff(snapshot, "goal:4")).toEqual({
      claimId: "claim",
      operationId: "queue-parent",
      operationGeneration: "parent-generation",
      goalEpoch: "goal:4",
    });
    expect(managedQueueGoalHandoff(snapshot, "goal:3")).toBeUndefined();
    claim.goalOperationId = "actual-attempt" as any;
    expect(managedQueueGoalHandoff(snapshot, "goal:4")).toBeUndefined();
  });

  it("preserves full native vectors and stable operation/item identity, protecting only the admission frame", async () => {
    const f = fixture();
    const input = [
      {
        type: "text",
        text: "private",
        text_elements: [{ byte_range: { start: 0, end: 7 } }],
      },
      { type: "image", url: "https://fixture/image" },
      { type: "mention", name: "agent", path: "agent://one" },
    ];
    const params = {
      input,
      clientUserMessageId: "message",
      managed: { operationId: "stable-operation", action: "literal" },
    };
    const first = await f.request("thread/queue/add", params);
    await f.request("thread/queue/add", params);
    expect(f.preparePrompt.mock.calls[0]![0].id).toBe(
      f.preparePrompt.mock.calls[1]![0].id,
    );
    expect(first.queuedSubmission).toMatchObject({
      input,
      clientUserMessageId: "message",
    });
    const admission = f.client.mutate.mock.calls[0]![0].admission;
    expect(admission.operationId).toBe("stable-operation");
    expect(admission.payloadDigest).toBe(
      f.client.mutate.mock.calls[1]![0].admission.payloadDigest,
    );
    expect(JSON.stringify(admission)).not.toContain("private");
    expect(
      await openNativeCommandContent({
        service: encryption,
        context: {
          chatId: "chat",
          operationId: "stable-operation",
          direction: "request",
        },
        envelope: admission.protectedPayload,
      }),
    ).toEqual({
      method: "thread/queue/add",
      params: { threadId: "thread", ...params },
    });
  });

  it.each(["add", "update", "delete"] as const)(
    "reconciles a lost %s ACK before consulting changed or removed items",
    async (kind) => {
      const f = fixture([]);
      const accepted = item("original", 3);
      f.client.lookup.mockResolvedValue({
        found: true,
        revision: 99,
        paused: false,
        items: kind === "update" ? [item("original", 9)] : [],
        claims: [],
        receipt: { status: "applied" },
        ...(kind === "delete" ? {} : { acceptedItem: accepted }),
      });
      const result = await f.request(`thread/queue/${kind}`, {
        queuedSubmissionId: "original",
        input: accepted.input,
        clientUserMessageId: accepted.clientUserMessageId,
        expectedRevision: "2",
      });
      if (kind === "delete") expect(result).toEqual({ deleted: true });
      else
        expect(result.queuedSubmission).toMatchObject({
          id: "original",
          input: accepted.input,
        });
      expect(f.client.read).not.toHaveBeenCalled();
      expect(f.client.mutate).not.toHaveBeenCalled();
      expect(f.preparePrompt).not.toHaveBeenCalled();
      expect(f.client.lookup.mock.calls[0]![0].admission.operationId).toBe(
        "operation",
      );
    },
  );

  it("shows unresolved imported input separately without making it an executable queue item", async () => {
    const f = fixture([]);
    f.setSnapshot({
      revision: 3,
      paused: false,
      items: [],
      claims: [],
      pendingImports: [
        {
          importId: "import",
          nativeItemId: "legacy",
          status: "uncertain",
          prompt: item("protected-staged"),
        },
      ],
    } as any);
    const result = await f.request("thread/queue/list");
    expect(result.data).toEqual([]);
    expect(result.managedQueue.pendingImports).toEqual([
      {
        id: "import",
        nativeItemId: "legacy",
        status: "uncertain",
        input: item("protected-staged").input,
      },
    ]);
  });

  it("returns the complete canonical snapshot when the managed TUI omits pagination", async () => {
    const f = fixture(
      Array.from({ length: 1001 }, (_, index) => item(`item-${index}`)),
    );
    const result = await f.request("thread/queue/list");
    expect(result.data).toHaveLength(1001);
    expect(result.nextCursor).toBeNull();
  });

  it("uses canonical item revisions for edits and keeps stale-page cursors from mixing snapshots", async () => {
    const f = fixture([item("one", 7), item("two", 8)]);
    const page = await f.request("thread/queue/list", { limit: 1 });
    expect(page).toMatchObject({
      data: [{ id: "one" }],
      managedQueue: { revision: "1", paused: true },
    });
    expect(
      (
        await f.request("thread/queue/list", {
          limit: 1,
          cursor: page.nextCursor,
        })
      ).data,
    ).toMatchObject([{ id: "two" }]);
    await f.request("thread/queue/update", {
      queuedSubmissionId: "one",
      input: [{ type: "text", text: "changed" }],
      expectedRevision: "1",
    });
    expect(f.client.mutate.mock.calls[0]![0].mutation).toMatchObject({
      kind: "update",
      id: "one",
      expectedItemRevision: 7,
    });
    f.setSnapshot({
      revision: 2,
      paused: false,
      items: [item("two")],
      claims: [],
    });
    await expect(
      f.request("thread/queue/list", { cursor: page.nextCursor }),
    ).rejects.toThrow("reload");
  });

  it("requires an explicit stable mutation ID and exact full session ownership", async () => {
    const f = fixture();
    await expect(
      f.request("thread/queue/start", { managed: {} }),
    ).rejects.toThrow("operation ID");
    await expect(
      f.queue.execute({
        method: "thread/queue/list",
        params: { threadId: "thread" },
        identity: { ...identity, ownerId: "other" },
        connectionId: "view",
        signal: new AbortController().signal,
        assertCurrent() {},
      }),
    ).rejects.toThrow("another native session");
    expect(f.client.read).not.toHaveBeenCalled();
    expect(f.client.mutate).not.toHaveBeenCalled();
  });

  it("opens the actual GUI TurnStartResponse shape without inventing a JSON-RPC envelope", async () => {
    const f = fixture();
    const actual = {
      turn: { id: "gui-native-turn", status: "inProgress", items: [] },
    };
    const protectedResult = await protectNativeCommandContent({
      service: encryption,
      context: {
        chatId: "chat",
        operationId: "gui-effect",
        direction: "result",
      },
      content: actual,
    });
    f.client.startReceipt.mockResolvedValue({
      receipt: {
        operationId: "gui-effect",
        method: "turn/start",
        status: "applied",
      },
      claim: { nativeTurnId: "gui-native-turn" },
      protectedResult: protectedResult.envelope,
    });
    expect(await f.request("thread/queue/start")).toEqual(actual);
    f.client.startReceipt.mockResolvedValue({
      receipt: {
        operationId: "gui-effect",
        method: "turn/start",
        status: "applied",
      },
      claim: { nativeTurnId: "other" },
      protectedResult: protectedResult.envelope,
    });
    await expect(f.request("thread/queue/start")).rejects.toThrow(
      "correlated native Turn",
    );
  });

  it("returns only the actual claimed native Turn acknowledgment and never retries an uncertain start", async () => {
    const f = fixture();
    const content = {
      id: 42,
      result: { turn: { id: "actual-turn", status: "inProgress", items: [] } },
    };
    const protectedResult = await protectNativeCommandContent({
      service: encryption,
      context: { chatId: "chat", operationId: "effect", direction: "result" },
      content,
    });
    f.client.startReceipt.mockResolvedValue({
      receipt: {
        operationId: "effect",
        method: "turn/start",
        status: "applied",
      },
      claim: { nativeTurnId: "actual-turn" },
      protectedResult: protectedResult.envelope,
    });
    expect(await f.request("thread/queue/start")).toEqual(content.result);
    f.client.startReceipt.mockRejectedValue(
      new Error("Transport interrupted after claim commit"),
    );
    await expect(f.request("thread/queue/start")).rejects.toThrow(
      "after claim commit",
    );
    expect(f.client.mutate).toHaveBeenCalledTimes(2);
    expect(f.client.startReceipt).toHaveBeenCalledTimes(2);
  });

  it("rejects a protected result from another claimed native turn", async () => {
    const f = fixture();
    const sealed = await protectNativeCommandContent({
      service: encryption,
      context: { chatId: "chat", operationId: "effect", direction: "result" },
      content: { result: { turn: { id: "foreign" } } },
    });
    f.client.startReceipt.mockResolvedValue({
      receipt: {
        operationId: "effect",
        method: "turn/start",
        status: "applied",
      },
      claim: { nativeTurnId: "actual" },
      protectedResult: sealed.envelope,
    });
    await expect(f.request("thread/queue/start")).rejects.toThrow("correlated");
  });

  it("acknowledges a real shell action without fabricating a model turn", async () => {
    const f = fixture();
    const sealed = await protectNativeCommandContent({
      service: encryption,
      context: {
        chatId: "chat",
        operationId: "shell-effect",
        direction: "result",
      },
      content: { result: {} },
    });
    f.client.startReceipt.mockResolvedValue({
      receipt: {
        operationId: "shell-effect",
        method: "thread/shellCommand",
        status: "applied",
      },
      claim: { nativeTurnId: null },
      protectedResult: sealed.envelope,
    });
    expect(await f.request("thread/queue/start")).toEqual({
      managedAction: {
        operationId: "operation",
        executionOperationId: "shell-effect",
        method: "thread/shellCommand",
        status: "applied",
      },
    });
    f.client.startReceipt.mockResolvedValue({
      receipt: {
        operationId: "shell-effect",
        method: "unknown/mutation",
        status: "applied",
      },
      claim: { nativeTurnId: null },
      protectedResult: sealed.envelope,
    });
    await expect(f.request("thread/queue/start")).rejects.toThrow(
      "supported native acknowledgment",
    );
  });

  it("rechecks actual runtime ownership after asynchronous prompt protection", async () => {
    const f = fixture();
    let current = true;
    f.preparePrompt.mockImplementation(async ({ id }: any) => {
      current = false;
      return {
        prompt: {
          id,
          revision: 1,
          idempotencyKey: "operation",
          input: [],
          clientUserMessageId: "message",
        },
        attachments: [],
      };
    });
    await expect(
      f.queue.execute({
        method: "thread/queue/add",
        params: {
          threadId: "thread",
          managed: { operationId: "operation" },
          input: [{ type: "text", text: "input" }],
          clientUserMessageId: "message",
        },
        identity,
        connectionId: "view",
        signal: new AbortController().signal,
        assertCurrent() {
          if (!current) throw new Error("Actual runtime replaced");
        },
      }),
    ).rejects.toThrow("Actual runtime replaced");
    expect(f.client.mutate).not.toHaveBeenCalled();
  });

  it("publishes monotonic canonical revisions only for its thread", () => {
    const f = fixture();
    const listener = vi.fn();
    const unsubscribe = f.queue.subscribe(listener);
    f.queue.publishRevision({ threadId: "thread", revision: "2" });
    f.queue.publishRevision({ threadId: "thread", revision: "1" });
    f.queue.publishRevision({ threadId: "thread", revision: "2" });
    f.queue.publishRevision({ threadId: "other", revision: "3" });
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    f.queue.publishRevision({ threadId: "thread", revision: "3" });
    expect(listener).toHaveBeenCalledOnce();
  });
});
