import {
  cantripMcpBindingSchema,
  type CantripMcpBinding,
} from "@cantrip/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installComputerUseAgentRoutes,
  resolveComputerUseAgentAuthority,
  type ComputerUseAgentRouteDependencies,
} from "../src/app/routes/computer-use-agent.js";
import type { ServerConfig } from "../src/config.js";
import type { ChatExecutionContext } from "../src/db/repository.js";
import { requestComputerUseAuthority } from "../../cantrip_worker/src/computer-use/authority-client.js";

const now = Date.parse("2026-09-05T00:00:00Z");
function binding(at = Date.now()): CantripMcpBinding {
  return cantripMcpBindingSchema.parse({
    bindingId: "00000000-0000-4000-8000-000000000001",
    ownerId: "owner",
    workerId: "worker",
    chatId: "chat",
    contextKind: "project",
    projectId: "project",
    worktreeId: "worktree",
    rootKind: "git-worktree",
    scratchRootId: null,
    executionLaneId: "lane",
    permissionProfileId: ":read-only",
    allowedOperations: ["context.get"],
    issuedAt: new Date(at - 1000).toISOString(),
    expiresAt: new Date(at + 60_000).toISOString(),
  });
}
function context(): ChatExecutionContext {
  return {
    contextKind: "project",
    projectId: "project",
    worktreeId: "worktree",
    rootKind: "git-worktree",
    scratchRootId: null,
    chatId: "chat",
    workerId: "worker",
    executionLaneId: "lane",
    computerUseAuthorityGeneration: 1,
    status: "idle",
    threadId: "eventually-consistent-native-thread",
    cwd: "PRIVATE-worker-path",
    permissionProfileId: ":yolo",
    defaultPermissionProfileId: ":workspace",
    isPrimary: true,
    worktreePolicy: "required-for-writes",
  } as ChatExecutionContext;
}
const resolve = (value: CantripMcpBinding, current = context()) =>
  resolveComputerUseAgentAuthority({
    binding: value,
    context: current,
    ownerId: "owner",
    serverId: "server",
    now,
  });

describe("computer-use server authority", () => {
  it("returns selected YOLO even when its effective filesystem policy is read-only", () => {
    expect(resolve(binding(now))).toMatchObject({
      profile: {
        selectedId: ":yolo",
        effectiveId: ":read-only",
        forcedByWorktreePolicy: true,
        usesDefault: false,
      },
      executionLaneId: "lane",
      placementId: "worktree",
      generation: 1,
    });
  });
  it("reads new policy and generation instead of treating attachment claims as current permission", () => {
    const current = context();
    current.permissionProfileId = ":workspace";
    current.computerUseAuthorityGeneration = 2;
    expect(resolve(binding(now), current)).toMatchObject({
      generation: 2,
      profile: { selectedId: ":workspace" },
    });
  });
  it("projects inherited defaults without requiring a server-side native thread/status guess", () => {
    const current = context();
    current.threadId = null;
    current.permissionProfileId = null;
    expect(resolve(binding(now), current)).toMatchObject({
      profile: { selectedId: ":workspace", usesDefault: true },
    });
  });
  it.each([
    "ownerId",
    "workerId",
    "chatId",
    "projectId",
    "worktreeId",
    "executionLaneId",
  ] as const)(
    "rejects changed %s rather than following a different scope",
    (field) => {
      expect(resolve({ ...binding(now), [field]: "another" })).toBeNull();
    },
  );
  it("rejects changed root kind and a missing lane", () => {
    expect(
      resolve(binding(now), { ...context(), rootKind: "folder-root" }),
    ).toBeNull();
    expect(
      resolve(binding(now), { ...context(), executionLaneId: null }),
    ).toBeNull();
  });
  it("rejects expired and future-issued attachments at the actual boundary", () => {
    expect(
      resolve({ ...binding(now), expiresAt: new Date(now).toISOString() }),
    ).toBeNull();
    expect(
      resolve({
        ...binding(now),
        issuedAt: new Date(now + 60_001).toISOString(),
      }),
    ).toBeNull();
    expect(
      resolve({
        ...binding(now),
        issuedAt: new Date(now + 60_000).toISOString(),
        expiresAt: new Date(now + 120_000).toISOString(),
      }),
    ).not.toBeNull();
  });
  it("handles standalone scratch placement independently and rejects another scratch root", () => {
    const standalone = {
      ...binding(now),
      contextKind: "standalone" as const,
      projectId: null,
      worktreeId: null,
      rootKind: null,
      scratchRootId: "scratch",
    };
    const current = {
      ...context(),
      ...standalone,
      permissionProfileId: ":yolo",
      worktreePolicy: null,
    } as ChatExecutionContext;
    expect(resolve(standalone, current)).toMatchObject({
      placementId: "scratch",
      contextKind: "standalone",
    });
    expect(
      resolve({ ...standalone, scratchRootId: "other" }, current),
    ).toBeNull();
  });
});

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function fixture() {
  const app = Fastify();
  apps.push(app);
  const current = context();
  const repository = {
    authenticateWorkerCredential: vi
      .fn<
        ComputerUseAgentRouteDependencies["repository"]["authenticateWorkerCredential"]
      >()
      .mockResolvedValue({
        id: "credential",
        ownerId: "owner",
        workerId: "worker",
        scopes: ["worker:agent-tools"],
      }),
    getChatExecutionContext: vi
      .fn<
        ComputerUseAgentRouteDependencies["repository"]["getChatExecutionContext"]
      >()
      .mockResolvedValue(current),
  };
  const runAsOwner = vi.fn<ComputerUseAgentRouteDependencies["runAsOwner"]>(
    async (_owner, work) => work(),
  );
  installComputerUseAgentRoutes(app, {
    config: { deploymentMode: "server", authMode: "account" } as ServerConfig,
    serverId: "server",
    repository,
    runAsOwner,
  });
  const call = (payload: unknown = { binding: binding() }, authorized = true) =>
    app.inject({
      method: "POST",
      url: "/api/internal/computer-use/authority",
      payload,
      headers: authorized
        ? { authorization: "Bearer test-worker-credential" }
        : {},
    });
  return { app, current, repository, runAsOwner, call };
}
describe("worker-authenticated computer-use authority route", () => {
  it("serves the real worker HTTP client and immediately rejects a moved execution", async () => {
    const f = fixture();
    const serverUrl = await f.app.listen({ host: "127.0.0.1", port: 0 });
    const input = {
      serverUrl,
      binding: binding(),
      token: "test-worker-credential",
      signal: new AbortController().signal,
    };
    expect(await requestComputerUseAuthority(input)).toMatchObject({
      generation: 1,
      workerId: "worker",
    });
    f.current.executionLaneId = "relocated-lane";
    await expect(requestComputerUseAuthority(input)).rejects.toMatchObject({
      code: "unauthorized",
    });
  });
  it("uses the agent-tools credential scope and returns bounded public authority only", async () => {
    const f = fixture();
    const response = await f.call();
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(f.repository.authenticateWorkerCredential).toHaveBeenCalledWith(
      expect.any(String),
      "worker",
      "worker:agent-tools",
    );
    expect(f.repository.getChatExecutionContext).toHaveBeenCalledWith(
      "owner",
      "chat",
    );
    expect(f.runAsOwner).toHaveBeenCalledWith("owner", expect.any(Function));
    expect(response.body).not.toContain("PRIVATE");
    expect(response.body).not.toContain("eventually-consistent");
  });
  it("requires a real worker credential, not an application session or body identity", async () => {
    const f = fixture();
    expect((await f.call(undefined, false)).statusCode).toBe(401);
    f.repository.authenticateWorkerCredential.mockResolvedValue(null);
    expect((await f.call()).statusCode).toBe(401);
    expect(f.repository.getChatExecutionContext).not.toHaveBeenCalled();
  });
  it("rejects a credential owner mismatch before loading any chat", async () => {
    const f = fixture();
    expect(
      (await f.call({ binding: { ...binding(), ownerId: "other" } }))
        .statusCode,
    ).toBe(401);
    expect(f.repository.getChatExecutionContext).not.toHaveBeenCalled();
  });
  it("reads fresh policy on each call even if a revocation push never arrived", async () => {
    const f = fixture();
    expect((await f.call()).json().profile.selectedId).toBe(":yolo");
    f.current.permissionProfileId = ":workspace";
    f.current.computerUseAuthorityGeneration = 2;
    expect((await f.call()).json()).toMatchObject({
      generation: 2,
      profile: { selectedId: ":workspace" },
    });
    expect(f.repository.getChatExecutionContext).toHaveBeenCalledTimes(2);
  });
  it("rejects archived/missing chat and relocated worker or lane", async () => {
    const f = fixture();
    f.current.workerId = "new-worker";
    expect((await f.call()).statusCode).toBe(409);
    f.current.workerId = "worker";
    f.current.executionLaneId = "new-lane";
    expect((await f.call()).statusCode).toBe(409);
    f.repository.getChatExecutionContext.mockResolvedValue(null);
    expect((await f.call()).statusCode).toBe(409);
  });
  it("rejects extra claims and oversized bodies without executing authorization", async () => {
    const f = fixture();
    expect(
      (await f.call({ binding: binding(), profile: ":yolo" })).statusCode,
    ).toBe(400);
    expect(
      (await f.call({ binding: binding(), extra: "x".repeat(32768) }))
        .statusCode,
    ).toBe(413);
    expect(f.repository.getChatExecutionContext).not.toHaveBeenCalled();
  });
  it("reports server failure without exposing details or creating fallback authority", async () => {
    const f = fixture();
    f.repository.getChatExecutionContext.mockRejectedValue(
      new Error("PRIVATE path and credential"),
    );
    const response = await f.call();
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("PRIVATE");
    expect(response.json()).not.toHaveProperty("generation");
  });
  it("does not invent a generation for a missing persisted authority revision", async () => {
    const f = fixture();
    delete f.current.computerUseAuthorityGeneration;
    expect((await f.call()).statusCode).toBe(503);
  });
});
