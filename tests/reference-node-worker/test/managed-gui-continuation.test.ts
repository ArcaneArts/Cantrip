import { describe, expect, it, vi } from "vitest";
import {
  nativeCommandExecutionSchema,
  type NativeCommandReceipt,
  type NativeCommandSession,
} from "@cantrip/protocol";
import { NativeCommandClient } from "../src/native-command-client.js";
import { openNativeCommandContent } from "../src/native-command-content.js";
import {
  admitManagedGuiContinuation,
  managedGuiRetryEvidence,
} from "../src/codex/managed-gui-continuation.js";
import {
  CodexNativeRpcError,
  CodexTurnFailureError,
  type RunAgentTurnRetry,
} from "../src/codex/app-server.js";

const root: NativeCommandReceipt = {
  operationId: "root",
  operationGeneration: "root-generation",
  logicalOperationId: "root",
  activationGeneration: "activation",
  chatId: "chat",
  startsExecution: true,
  executionLaneId: "lane",
  status: "applied",
  method: "turn/start",
  payloadDigest: "a".repeat(64),
  rejectionCode: null,
  threadId: "thread",
  createdAt: "2026-09-08T00:00:00Z",
  updatedAt: "2026-09-08T00:00:00Z",
};
const session: NativeCommandSession = {
  chatId: "chat",
  threadId: "thread",
  contextKind: "project",
  projectId: "project",
  placementId: "placement",
  runtimeGeneration: "runtime",
  connectionId: "gui:root-generation",
  modelRouteId: "route",
  providerAccountId: null,
};
const execution = nativeCommandExecutionSchema.parse({
  chatId: "chat",
  workerId: "worker",
  contextKind: "project",
  projectId: "project",
  worktreeId: "placement",
  scratchRootId: null,
  threadId: "thread",
  executionLaneId: "lane",
  cwd: "/fixture",
  rootKind: "git-worktree",
  experience: "agent",
  status: "running",
  automationPaused: false,
  isPrimary: true,
  modelId: "model",
  reasoningEffort: null,
  modelRouteId: "route",
  providerAccountId: null,
  permissionProfileId: "workspace",
  modelConfiguration: { modelId: "model" },
  planMode: "default",
  worktreeMode: null,
  worktreePolicy: null,
});
const encryption = {
  ownerId: () => "owner",
  serverIdentity: () => "server",
  componentKey: () => ({ key: new Uint8Array(32).fill(17), keyRevision: 1 }),
};
function fixture() {
  const controller = new AbortController();
  const requests: Array<{ action: string; body: Record<string, any> }> = [];
  let duringAdmission: (() => void) | undefined;
  let corruptLineage = false;
  let saved = root;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const action = new URL(String(url)).pathname.split("/").at(-1)!;
    const body = JSON.parse(String(init!.body));
    requests.push({ action, body });
    if (action === "continue") {
      duringAdmission?.();
      saved = {
        ...root,
        operationId: body.operationId,
        operationGeneration: "retry-generation",
        activationGeneration: "retry-activation",
        previousOperationId: corruptLineage
          ? "wrong"
          : body.previousOperationId,
        payloadDigest: body.payloadDigest,
        status: "accepted",
      };
      return Response.json({
        receipt: saved,
        execution,
        computerUseAuthority: null,
      });
    }
    return Response.json({ receipt: { ...saved, status: body.status } });
  });
  const retry: RunAgentTurnRetry = {
    reason: "capacity",
    attempt: 2,
    operationGeneration: root.operationGeneration,
    threadId: "thread",
    turnId: "turn",
    nextThreadId: "thread",
    signal: controller.signal,
    error: new CodexTurnFailureError(
      "busy",
      "serverOverloaded",
      "thread",
      "turn",
    ),
  };
  const onAdmitted = vi.fn();
  const input = {
    client: new NativeCommandClient({
      serverUrl: "https://fixture.invalid",
      workerId: "worker",
      token: () => "token",
      fetch: fetcher,
    }),
    encryption,
    root,
    previous: root,
    session,
    retry,
    payload: { prompt: "private follow-up", attachments: [] },
    onAdmitted,
  };
  return {
    input,
    controller,
    requests,
    fetcher,
    onAdmitted,
    duringAdmission: (callback: () => void) => {
      duringAdmission = callback;
    },
    corrupt: () => {
      corruptLineage = true;
    },
  };
}

describe("managed GUI retry admission", () => {
  it("keeps the reserved lane and root connection while obtaining a fresh protected attempt", async () => {
    const f = fixture();
    const result = await admitManagedGuiContinuation(f.input);
    expect(result.receipt.operationGeneration).not.toBe(
      root.operationGeneration,
    );
    expect(result.receipt.executionLaneId).toBe(root.executionLaneId);
    expect(f.requests).toHaveLength(1);
    const body = f.requests[0]!.body;
    expect(body).toMatchObject({
      rootOperationId: "root",
      previousOperationId: "root",
      session,
      failure: {
        kind: "native-terminal",
        nativeTurnId: "turn",
        runtimeGeneration: "runtime",
      },
    });
    expect(JSON.stringify(body)).not.toContain("private follow-up");
    expect(
      await openNativeCommandContent({
        service: encryption,
        context: {
          chatId: "chat",
          operationId: body.operationId,
          direction: "request",
        },
        envelope: body.protectedPayload,
      }),
    ).toEqual(f.input.payload);
  });

  it("records then rejects a committed successor when Stop races with admission", async () => {
    const f = fixture();
    f.duringAdmission(() => f.controller.abort(new Error("Stopped")));
    await expect(admitManagedGuiContinuation(f.input)).rejects.toThrow(
      "Stopped",
    );
    expect(f.onAdmitted).toHaveBeenCalledOnce();
    expect(f.requests.map((r) => r.action)).toEqual(["continue", "receipt"]);
    expect(f.requests[1]!.body).toMatchObject({
      operationGeneration: "retry-generation",
      status: "rejected",
      rejectionCode: "cancelled-before-dispatch",
      executionComplete: false,
    });
  });

  it("does not request continuation after Stop or for a stale generation", async () => {
    const f = fixture();
    f.input.retry.operationGeneration = "old";
    await expect(admitManagedGuiContinuation(f.input)).rejects.toThrow(
      "replaced execution",
    );
    f.controller.abort(new Error("Stopped"));
    await expect(admitManagedGuiContinuation(f.input)).rejects.toThrow(
      "Stopped",
    );
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("rejects cross-lineage receipts without adopting their authority", async () => {
    const f = fixture();
    f.corrupt();
    await expect(admitManagedGuiContinuation(f.input)).rejects.toThrow(
      "uncorrelated retry lineage",
    );
    expect(f.onAdmitted).not.toHaveBeenCalled();
  });

  it("does not invent native evidence or replay after an uncertain transport failure", async () => {
    const f = fixture();
    const unknown = new Error("invalid compaction busy");
    f.input.retry.error = unknown;
    await expect(admitManagedGuiContinuation(f.input)).rejects.toBe(unknown);
    expect(f.fetcher).not.toHaveBeenCalled();
    f.input.retry.error = new CodexTurnFailureError(
      "busy",
      "serverOverloaded",
      "thread",
      "turn",
    );
    f.fetcher.mockRejectedValue(new Error("response lost after commit"));
    await expect(admitManagedGuiContinuation(f.input)).rejects.toThrow(
      "response lost",
    );
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it("preserves the actual rejected RPC method instead of guessing from receipt status", () => {
    const f = fixture();
    f.input.retry.error = new CodexNativeRpcError(
      "invalid",
      { code: -32600, message: "invalid" },
      "thread/resume",
    );
    expect(managedGuiRetryEvidence(f.input.retry, "runtime")).toEqual({
      kind: "native-rejected",
      method: "thread/resume",
      code: -32600,
      runtimeGeneration: "runtime",
    });
    f.input.retry.error = new CodexNativeRpcError("invalid", {
      code: -32600,
      message: "invalid",
    });
    expect(() => managedGuiRetryEvidence(f.input.retry, "runtime")).toThrow(
      "invalid",
    );
  });
});
