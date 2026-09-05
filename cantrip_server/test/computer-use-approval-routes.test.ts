import {
  type AgentInteractionRequestWire,
  type EncryptedAgentInteractionRequest,
  type EncryptedAgentInteractionResolutionCreate,
} from "@cantrip/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installAgentInteractionRoutes,
  type AgentInteractionRouteDependencies,
} from "../src/app/routes/agent-interactions.js";
import {
  AgentInteractionConflictError,
  type ChatExecutionContext,
  type ModelRuntime,
} from "../src/db/repository.js";
import { WorkerUnavailableError } from "../src/workers/bridge.js";

const timestamp = "2026-09-01T00:00:00.000Z";
const approvalId = "00000000-0000-4000-8000-000000000001";
const url = `/api/agent-requests/${approvalId}/respond`;
const privateDetails = "PRIVATE-NATIVE-TARGET-and-protected-payload";

function opaque(): EncryptedAgentInteractionResolutionCreate["protectedResponse"] {
  return {
    formatVersion: 1,
    keyRevision: 1,
    envelope: {
      version: 1,
      algorithm: "AES-256-GCM",
      keyRevision: 1,
      nonce: Buffer.alloc(12).toString("base64url"),
      ciphertext: Buffer.alloc(16).toString("base64url"),
    },
  };
}

function resolution(): EncryptedAgentInteractionResolutionCreate {
  return {
    idempotencyKey: "resolution-one",
    classification: { kind: "permissions" },
    protectedResponse: opaque(),
  };
}

function approval(): EncryptedAgentInteractionRequest {
  return {
    id: approvalId,
    requestKey: "native-request-one",
    projectId: null,
    provenance: {
      owner: "computer-use",
      chatId: "chat-one",
      threadId: null,
      turnId: null,
      itemId: null,
      workerId: "worker-one",
      executionLaneId: "lane-one",
    },
    classification: { kind: "permissions" },
    protectedPayload: opaque(),
    status: "pending",
    protectedResponse: null,
    resolvedByUserId: null,
    expiresAt: "2030-09-01T00:00:00.000Z",
    resolvedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup(options: { preview?: boolean } = {}) {
  const logs: string[] = [];
  const app = Fastify({
    logger: { stream: { write: (line: string) => logs.push(line) } },
  });
  apps.push(app);
  const state = {
    interaction: approval() as AgentInteractionRequestWire,
    context: {
      chatId: "chat-one",
      contextKind: "standalone",
      workerId: "worker-one",
      executionLaneId: "lane-one",
      threadId: null,
      modelId: null,
      status: "idle",
      scratchRootId: "scratch-one",
      projectId: null,
      computerUseAuthorityGeneration: 1,
      permissionProfileId: ":workspace",
      isPrimary: true,
      worktreePolicy: null,
    } as ChatExecutionContext,
    idempotencyKey: null as string | null,
  };
  if (options.preview) {
    state.interaction.provenance.executionLaneId = null;
    state.context.threadId = "real-agent-thread";
    state.context.status = "running";
  }
  const applicationOwnerId = vi.fn(() => "owner-one");
  const repository = {
    listAgentInteractionRequests:
      vi.fn<
        AgentInteractionRouteDependencies["repository"]["listAgentInteractionRequests"]
      >(),
    getAgentInteractionRequest:
      vi.fn<
        AgentInteractionRouteDependencies["repository"]["getAgentInteractionRequest"]
      >(),
    getChatExecutionContext:
      vi.fn<
        AgentInteractionRouteDependencies["repository"]["getChatExecutionContext"]
      >(),
    validateEncryptedAgentInteractionResolution:
      vi.fn<
        AgentInteractionRouteDependencies["repository"]["validateEncryptedAgentInteractionResolution"]
      >(),
    validateAgentInteractionResolution:
      vi.fn<
        AgentInteractionRouteDependencies["repository"]["validateAgentInteractionResolution"]
      >(),
  };
  repository.getChatExecutionContext.mockImplementation(async (owner, chat) =>
    owner === "owner-one" && chat === "chat-one" ? state.context : null,
  );
  repository.validateEncryptedAgentInteractionResolution.mockImplementation(
    async (owner, id) =>
      owner === "owner-one" &&
      id === approvalId &&
      "protectedPayload" in state.interaction
        ? state.interaction
        : null,
  );
  repository.validateAgentInteractionResolution.mockImplementation(
    async (owner, id) => {
      if (owner !== "owner-one" || id !== approvalId) return null;
      if (!("payload" in state.interaction)) {
        throw new AgentInteractionConflictError(
          "Protected interaction requests require a protected response.",
        );
      }
      return state.interaction;
    },
  );
  const resolveProtected =
    vi.fn<
      AgentInteractionRouteDependencies["resolveLiveEncryptedAgentInteractionRequest"]
    >();
  resolveProtected.mockImplementation(async (owner, id, input) => {
    if (owner !== "owner-one" || id !== approvalId) return null;
    if (!("protectedPayload" in state.interaction)) return null;
    if (state.interaction.status !== "pending") {
      if (
        state.interaction.status === "resolved" &&
        state.idempotencyKey === input.idempotencyKey
      ) {
        return state.interaction;
      }
      throw new AgentInteractionConflictError("Interaction is not pending.");
    }
    state.idempotencyKey = input.idempotencyKey;
    state.interaction = {
      ...state.interaction,
      status: "resolved",
      protectedResponse: input.protectedResponse,
      resolvedByUserId: owner,
      resolvedAt: timestamp,
      updatedAt: timestamp,
    };
    return state.interaction;
  });
  const resolveVisible =
    vi.fn<
      AgentInteractionRouteDependencies["resolveLiveAgentInteractionRequest"]
    >();
  const request =
    vi.fn<AgentInteractionRouteDependencies["bridge"]["request"]>();
  request.mockResolvedValue({ accepted: true });
  const isConnected = vi.fn(() => false);
  const runtimeForContext =
    vi.fn<AgentInteractionRouteDependencies["runtimeForContext"]>();
  runtimeForContext.mockResolvedValue(null);
  installAgentInteractionRoutes(app, {
    applicationOwnerId,
    serverId: "server-one",
    bridge: { request, isConnected },
    repository,
    resolveLiveAgentInteractionRequest: resolveVisible,
    resolveLiveEncryptedAgentInteractionRequest: resolveProtected,
    runtimeForContext,
  });
  return {
    app,
    logs,
    state,
    repository,
    request,
    isConnected,
    runtimeForContext,
    resolveProtected,
    resolveVisible,
    applicationOwnerId,
    send: (payload: unknown = resolution()) =>
      app.inject({ method: "POST", url, payload }),
  };
}

describe("computer-use approval responses", () => {
  it("refreshes agent approval authority while preserving actual child turn ownership", async () => {
    const f = setup();
    f.state.interaction.provenance.threadId = "child-thread";
    f.state.interaction.provenance.turnId = "child-turn";
    f.state.context.threadId = "root-thread";
    f.state.context.computerUseAuthorityGeneration = 3;
    f.state.context.permissionProfileId = ":read-only";
    expect((await f.send()).statusCode).toBe(200);
    expect(f.request.mock.lastCall?.[1]).toMatchObject({
      type: "computer-use.approval.respond",
      executionLaneId: "lane-one",
      agentAuthority: {
        ownerId: "owner-one",
        serverId: "server-one",
        chatId: "chat-one",
        workerId: "worker-one",
        executionLaneId: "lane-one",
        generation: 3,
        profile: { selectedId: ":read-only" },
      },
    });
    expect(f.request.mock.lastCall?.[1]).not.toHaveProperty("previewAuthority");
    expect(f.runtimeForContext).not.toHaveBeenCalled();
  });

  it("authorizes an idle preview without borrowing the active agent lane", async () => {
    const f = setup({ preview: true });
    expect((await f.send()).statusCode).toBe(200);
    expect(f.request.mock.lastCall?.[1]).toMatchObject({
      type: "computer-use.approval.respond",
      executionLaneId: null,
      previewAuthority: {
        ownerId: "owner-one",
        serverId: "server-one",
        workerId: "worker-one",
        chatId: "chat-one",
        contextKind: "standalone",
        projectId: null,
        placementId: "scratch-one",
        generation: 1,
        profile: {
          selectedId: ":workspace",
          effectiveId: ":workspace",
          forcedByWorktreePolicy: false,
          usesDefault: false,
        },
      },
    });
    expect(f.runtimeForContext).not.toHaveBeenCalled();
    expect(f.isConnected).not.toHaveBeenCalled();
  });

  it("sends refreshed authority so the worker rejects approval after a policy change", async () => {
    const f = setup({ preview: true });
    f.state.context.computerUseAuthorityGeneration = 2;
    f.state.context.permissionProfileId = ":read-only";
    f.request.mockRejectedValue(new Error("revoked"));
    expect((await f.send()).statusCode).toBe(409);
    expect(f.request.mock.lastCall?.[1]).toMatchObject({
      previewAuthority: {
        generation: 2,
        profile: { selectedId: ":read-only" },
      },
    });
    expect(f.resolveProtected).not.toHaveBeenCalled();
  });

  it("rejects a preview approval after the chat moves to another worker", async () => {
    const f = setup({ preview: true });
    f.state.context.workerId = "other-worker";
    expect((await f.send()).statusCode).toBe(409);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("routes an idle native approval without a Codex thread or selected model", async () => {
    const f = setup();
    const response = await f.send();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "resolved",
      provenance: { owner: "computer-use", threadId: null },
    });
    expect(
      f.repository.validateEncryptedAgentInteractionResolution,
    ).toHaveBeenCalledWith("owner-one", approvalId, resolution());
    expect(f.repository.getChatExecutionContext).toHaveBeenCalledWith(
      "owner-one",
      "chat-one",
    );
    expect(f.request).toHaveBeenCalledExactlyOnceWith(
      "worker-one",
      {
        type: "computer-use.approval.respond",
        ownerId: "owner-one",
        chatId: "chat-one",
        executionLaneId: "lane-one",
        requestKey: "native-request-one",
        agentAuthority: expect.objectContaining({
          ownerId: "owner-one",
          serverId: "server-one",
          executionLaneId: "lane-one",
        }),
        response: {
          classification: resolution().classification,
          protectedResponse: resolution().protectedResponse,
        },
      },
      { ownerId: "owner-one", timeoutMs: 30_000 },
    );
    expect(f.isConnected).not.toHaveBeenCalled();
    expect(f.runtimeForContext).not.toHaveBeenCalled();
    expect(f.resolveVisible).not.toHaveBeenCalled();
  });

  it("hides foreign-owner approvals without contacting the worker", async () => {
    const f = setup();
    f.applicationOwnerId.mockReturnValue("other-owner");
    expect((await f.send()).statusCode).toBe(404);
    expect(f.repository.getChatExecutionContext).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.resolveProtected).not.toHaveBeenCalled();
  });

  it.each(["workerId", "executionLaneId"] as const)(
    "rejects a stale %s without applying the approval",
    async (field) => {
      const f = setup();
      f.state.context[field] = "replacement";
      expect((await f.send()).statusCode).toBe(409);
      expect(f.request).not.toHaveBeenCalled();
      expect(f.resolveProtected).not.toHaveBeenCalled();
    },
  );

  it("rejects an approval whose chat is no longer accessible", async () => {
    const f = setup();
    f.repository.getChatExecutionContext.mockResolvedValue(null);
    expect((await f.send()).statusCode).toBe(409);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("rejects plaintext responses to protected native approvals", async () => {
    const f = setup();
    expect(
      (
        await f.send({
          idempotencyKey: "plaintext",
          response: { kind: "permissions", scope: "session", permissions: {} },
        })
      ).statusCode,
    ).toBe(409);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.resolveVisible).not.toHaveBeenCalled();
    expect(f.resolveProtected).not.toHaveBeenCalled();
  });

  it("never forwards a plaintext response even if a visible native request exists", async () => {
    const f = setup();
    const { classification, protectedPayload, protectedResponse, ...common } =
      approval();
    f.state.interaction = {
      ...common,
      payload: {
        kind: "permissions",
        source: "native-computer-use",
        startedAtMs: 0,
        environmentId: null,
        cwd: null,
        reason: null,
        requestedPermissions: {},
      },
      response: null,
    };
    const response = await f.send({
      idempotencyKey: "plaintext",
      response: { kind: "permissions", scope: "session", permissions: {} },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "Computer-use approvals require a protected response.",
    });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.resolveVisible).not.toHaveBeenCalled();
  });

  it("returns the durable result for a duplicate without applying it twice", async () => {
    const f = setup();
    const first = await f.send();
    const replay = await f.send();
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.resolveProtected).toHaveBeenCalledTimes(2);
    expect(
      (await f.send({ ...resolution(), idempotencyKey: "different" }))
        .statusCode,
    ).toBe(409);
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it("does not replay a resolved approval into a replacement execution lane", async () => {
    const f = setup();
    await f.send();
    f.state.context.executionLaneId = "replacement";
    expect((await f.send()).statusCode).toBe(409);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.resolveProtected).toHaveBeenCalledTimes(1);
  });

  it.each(["expired", "interrupted"] as const)(
    "rejects a %s approval",
    async (status) => {
      const f = setup();
      f.state.interaction.status = status;
      f.state.interaction.resolvedAt = timestamp;
      expect((await f.send()).statusCode).toBe(409);
      expect(f.request).not.toHaveBeenCalled();
      expect(f.resolveProtected).not.toHaveBeenCalled();
    },
  );

  it.each([
    [new Error(privateDetails), 409],
    [new WorkerUnavailableError(privateDetails), 503],
  ])(
    "redacts a worker rejection without resolving it",
    async (error, status) => {
      const f = setup();
      f.request.mockRejectedValue(error);
      const response = await f.send();
      expect(response.statusCode).toBe(status);
      expect(response.body).not.toContain(privateDetails);
      expect(f.logs.join("")).not.toContain(privateDetails);
      expect(f.resolveProtected).not.toHaveBeenCalled();
      expect(f.isConnected).not.toHaveBeenCalled();
    },
  );

  it("requires a real worker acknowledgment before durable resolution", async () => {
    const f = setup();
    f.request.mockResolvedValue({ accepted: false });
    expect((await f.send()).statusCode).toBe(409);
    expect(f.resolveProtected).not.toHaveBeenCalled();
  });

  it("retains a concurrent revocation after the worker reply", async () => {
    const f = setup();
    f.request.mockImplementation(async () => {
      f.state.interaction.status = "interrupted";
      return { accepted: true };
    });
    expect((await f.send()).statusCode).toBe(409);
    expect(f.state.interaction.status).toBe("interrupted");
  });

  it.each(["context", "resolution"] as const)(
    "redacts %s persistence failures",
    async (step) => {
      const f = setup();
      if (step === "context")
        f.repository.getChatExecutionContext.mockRejectedValue(
          new Error(privateDetails),
        );
      else f.resolveProtected.mockRejectedValue(new Error(privateDetails));
      const response = await f.send();
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain(privateDetails);
      expect(f.logs.join("")).not.toContain(privateDetails);
    },
  );

  it("preserves the protected Codex runtime path for historical provenance", async () => {
    const f = setup();
    delete f.state.interaction.provenance.owner;
    f.state.interaction.provenance.threadId = "codex-thread";
    f.isConnected.mockReturnValue(true);
    const runtime = {
      model: { id: "model" },
      provider: { id: "provider" },
    } as ModelRuntime;
    f.runtimeForContext.mockResolvedValue(runtime);
    expect((await f.send()).statusCode).toBe(200);
    expect(f.isConnected).toHaveBeenCalledWith("worker-one");
    expect(f.runtimeForContext).toHaveBeenCalledWith(f.state.context);
    expect(f.request).toHaveBeenCalledExactlyOnceWith(
      "worker-one",
      {
        type: "agent.interaction.respond.protected",
        executionProfile: "standalone-chat",
        requestKey: "native-request-one",
        response: {
          classification: resolution().classification,
          protectedResponse: resolution().protectedResponse,
        },
        model: runtime.model,
        provider: runtime.provider,
      },
      { timeoutMs: 30_000 },
    );
  });

  it("preserves Codex offline handling without treating it as native approval", async () => {
    const f = setup();
    delete f.state.interaction.provenance.owner;
    f.state.interaction.provenance.threadId = "codex-thread";
    expect((await f.send()).statusCode).toBe(503);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.runtimeForContext).not.toHaveBeenCalled();
  });

  it("preserves visible Codex responses and their runtime routing", async () => {
    const f = setup();
    const { classification, protectedPayload, protectedResponse, ...common } =
      approval();
    const visible = {
      kind: "fileChange" as const,
      decision: "accept" as const,
    };
    f.state.interaction = {
      ...common,
      provenance: {
        ...common.provenance,
        owner: "codex",
        threadId: "codex-thread",
      },
      payload: {
        kind: "fileChange",
        startedAtMs: 0,
        reason: null,
        grantRoot: null,
      },
      response: null,
    };
    f.resolveVisible.mockResolvedValue({
      ...f.state.interaction,
      status: "resolved",
      response: visible,
      resolvedAt: timestamp,
      resolvedByUserId: "owner-one",
    });
    f.isConnected.mockReturnValue(true);
    const runtime = {
      model: { id: "model" },
      provider: { id: "provider" },
    } as ModelRuntime;
    f.runtimeForContext.mockResolvedValue(runtime);
    expect(
      (await f.send({ idempotencyKey: "visible", response: visible }))
        .statusCode,
    ).toBe(200);
    expect(f.request.mock.lastCall?.[1]).toEqual({
      type: "agent.interaction.respond",
      executionProfile: "standalone-chat",
      requestKey: "native-request-one",
      response: visible,
      model: runtime.model,
      provider: runtime.provider,
    });
    expect(f.resolveProtected).not.toHaveBeenCalled();
  });
});
