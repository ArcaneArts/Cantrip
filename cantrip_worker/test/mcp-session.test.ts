import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CantripServerRequestError } from "../src/cli-client.js";
import {
  CantripMcpBroker,
  type CantripMcpSessionAttachment,
  type CantripMcpSessionInput,
} from "../src/mcp/broker.js";
import type { CuaMcpExecutor } from "../src/mcp/cua-contract.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const claims: CantripMcpSessionInput = {
  ownerId: "owner",
  contextKind: "project",
  projectId: "project",
  chatId: "chat",
  workerId: "worker",
  worktreeId: "worktree",
  rootKind: "git-worktree",
  scratchRootId: null,
  permissionProfileId: ":workspace-write",
  allowedOperations: ["context.get"],
  computerUse: true,
};
const result = {
  summary: "Authorized context.",
  target: null,
  worktreeId: "worktree",
  continuationScheduled: false,
  mutated: false,
  data: {
    worker: { id: "worker", name: "Worker", online: true },
    context: {
      chatId: "chat",
      executionLaneId: "first",
      permissionProfileId: ":workspace-write",
      projectId: "project",
      rootKind: "git-worktree",
      terminalId: null,
      workerId: "worker",
      worktreeId: "worktree",
      worktreeMode: "agent-managed",
    },
    binding: {
      status: "read-only",
      mutationReady: false,
      staleClaims: [],
      recoveryInstruction: "Select a write-capable profile to mutate.",
      expiresAt: "2026-09-09T00:00:00.000Z",
    },
  },
};
async function fixture(
  options: ConstructorParameters<typeof CantripMcpBroker>[1] = {},
  config: Partial<ConstructorParameters<typeof CantripMcpBroker>[0]> = {},
) {
  const directory =
    config.dataDirectory ??
    (await mkdtemp(path.join(os.tmpdir(), "cantrip-mcp-session-")));
  if (!config.dataDirectory)
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const broker = new CantripMcpBroker(
    {
      dataDirectory: directory,
      serverUrl: "https://example.invalid",
      token: "worker-token",
      workerId: "worker",
      ...config,
    },
    options,
  );
  await broker.start();
  cleanups.push(() => broker.close());
  return broker;
}
async function host(
  session: CantripMcpSessionAttachment,
  entry: "stdio" | "cua-stdio",
) {
  const client = new Client({ name: "idle-session-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      path.resolve(`src/mcp/${entry}.ts`),
      "--connection",
      session.connectionPath,
    ],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  cleanups.push(() => client.close());
  await client.connect(transport);
  return client;
}
function execute(session: CantripMcpSessionAttachment, computerUse = false) {
  return fetch(
    `${session.connection.endpoint}/v1/${computerUse ? "computer-use" : "execute"}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.connection.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        bindingId: session.connection.bindingId,
        request: computerUse
          ? {
              operation: "js_reset",
              threadId: "thread",
              turnId: "turn",
              itemId: null,
              callId: null,
            }
          : { operation: "context.get", arguments: {} },
      }),
    },
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve_, reject_) => {
    resolve = resolve_;
    reject = reject_;
  });
  return { promise, resolve, reject };
}

describe("idle MCP sessions and exact active bindings", () => {
  it("activates prepared hosts for native turns and scopes late cleanup to its lane", async () => {
    const normal = vi.fn(
      async (_binding: Parameters<CuaMcpExecutor>[0]) => result,
    );
    const computer = vi.fn<CuaMcpExecutor>(async () => ({ content: [] }));
    const broker = await fixture({ execute: normal });
    broker.setComputerUseExecutor(computer);
    const session = broker.createSession(claims);
    const first = broker.activateSession({
      ...claims,
      executionLaneId: "first",
    });
    expect(first).toBeTypeOf("function");
    expect((await execute(session)).status).toBe(200);
    expect((await execute(session, true)).status).toBe(200);
    expect(normal.mock.calls[0]?.[0]).toMatchObject({
      executionLaneId: "first",
      allowedOperations: claims.allowedOperations,
    });
    expect(JSON.parse(await readFile(session.connectionPath, "utf8"))).toEqual(
      session.connection,
    );
    const second = broker.activateSession({
      ...claims,
      executionLaneId: "second",
    });
    first!();
    expect((await execute(session, true)).status).toBe(200);
    expect(computer.mock.calls.at(-1)?.[0].executionLaneId).toBe("second");
    second!();
    expect((await execute(session)).status).toBe(409);
    expect((await execute(session, true)).status).toBe(409);
  });

  it("never activates another placement, permission profile or expired host", async () => {
    let now = Date.now();
    const broker = await fixture({ now: () => now, ttlMs: 10000 });
    const session = broker.createSession(claims);
    for (const patch of [
      { ownerId: "other" },
      { workerId: "other" },
      { chatId: "other" },
      { projectId: "other" },
      { worktreeId: "other" },
      { permissionProfileId: ":yolo" },
    ])
      expect(
        broker.activateSession({
          ...claims,
          ...patch,
          executionLaneId: "first",
        }),
      ).toBeNull();
    expect((await execute(session)).status).toBe(409);
    now += 10001;
    expect(
      broker.activateSession({ ...claims, executionLaneId: "first" }),
    ).toBeNull();
  });

  it("keeps computer use disabled when activating a prepared host", async () => {
    const broker = await fixture({ execute: async () => result });
    broker.setComputerUseExecutor(async () => ({ content: [] }));
    const session = broker.createSession({ ...claims, computerUse: false });
    const release = broker.activateSession({
      ...claims,
      executionLaneId: "first",
    });
    expect(release).toBeTypeOf("function");
    expect((await execute(session)).status).toBe(200);
    expect((await execute(session, true)).status).toBe(403);
    release!();
  });

  it("initializes both real stdio catalogs idle, then uses the same hosts for real authorized turns", async () => {
    const normal = vi.fn(async () => result);
    const computer = vi.fn<CuaMcpExecutor>(async () => ({ content: [] }));
    const broker = await fixture({ execute: normal });
    broker.setComputerUseExecutor(computer);
    const session = broker.createSession(claims);
    expect(session).not.toHaveProperty("binding");
    expect(
      JSON.parse(await readFile(session.connectionPath, "utf8")),
    ).not.toHaveProperty("executionLaneId");
    const normalHost = await host(session, "stdio");
    const computerHost = await host(session, "cua-stdio");
    expect(
      (await normalHost.listTools()).tools.some(
        ({ name }) => name === "context_get",
      ),
    ).toBe(true);
    expect(
      (await computerHost.listTools()).tools.map(({ name }) => name),
    ).toEqual(["js", "js_reset"]);
    expect(
      await normalHost.callTool({
        name: "tool_help",
        arguments: { tool: "context_get" },
      }),
    ).not.toHaveProperty("isError", true);
    expect((await execute(session)).status).toBe(409);
    expect((await execute(session, true)).status).toBe(409);
    expect(
      await normalHost.callTool({ name: "context_get", arguments: {} }),
    ).toHaveProperty("isError", true);
    const computerCall = {
      name: "js_reset",
      arguments: {},
      _meta: {
        threadId: "thread",
        "x-codex-turn-metadata": { turn_id: "turn" },
      },
    };
    expect(await computerHost.callTool(computerCall)).toHaveProperty(
      "isError",
      true,
    );
    expect(normal).not.toHaveBeenCalled();
    expect(computer).not.toHaveBeenCalled();

    const active = broker.createBinding({
      ...claims,
      executionLaneId: "first",
    });
    expect(active.connection).toEqual(session.connection);
    expect(active.connectionPath).toBe(session.connectionPath);
    // An attachment carrying old/omitted eligibility never disables a live turn.
    expect(broker.createSession({ ...claims, computerUse: false })).toEqual(
      session,
    );
    expect(
      await normalHost.callTool({ name: "context_get", arguments: {} }),
    ).not.toHaveProperty("isError", true);
    expect(await computerHost.callTool(computerCall)).not.toHaveProperty(
      "isError",
      true,
    );
    expect(normal.mock.calls).toHaveLength(1);
    expect(computer.mock.calls[0]?.[0].executionLaneId).toBe("first");

    expect(
      broker.deactivateBinding(session.connection.bindingId, "first"),
    ).toBe(true);
    expect((await execute(session)).status).toBe(409);
    expect((await execute(session, true)).status).toBe(409);
    expect((await normalHost.listTools()).tools.length).toBeGreaterThan(0);
    const second = broker.createBinding({
      ...claims,
      executionLaneId: "second",
    });
    expect(second.connection).toEqual(session.connection);
    expect(
      broker.deactivateBinding(session.connection.bindingId, "first"),
    ).toBe(false);
    expect((await execute(session)).status).toBe(200);
    expect((await execute(session, true)).status).toBe(200);
    expect(computer.mock.calls.at(-1)?.[0].executionLaneId).toBe("second");
  }, 20_000);

  it.each(["stale-binding", "expired", "continuation"] as const)(
    "does not let an overlapping old %s result poison its replacement",
    async (outcome) => {
      const started = deferred<void>();
      const old = deferred<typeof result>();
      const broker = await fixture({
        execute: async (binding) => {
          if (binding.executionLaneId === "first") {
            started.resolve();
            return old.promise;
          }
          return result;
        },
      });
      const first = broker.createBinding({
        ...claims,
        executionLaneId: "first",
      });
      const pending = execute(first);
      await started.promise;
      const replacement = broker.createBinding({
        ...claims,
        executionLaneId: "second",
      });
      if (outcome === "continuation")
        old.resolve({ ...result, continuationScheduled: true });
      else
        old.reject(
          new CantripServerRequestError("Old request rejected.", 409, outcome),
        );
      const response = await pending;
      expect(response.status).toBe(outcome === "continuation" ? 200 : 409);
      expect((await execute(replacement)).status).toBe(200);
      expect(
        broker.deactivateBinding(first.connection.bindingId, "first"),
      ).toBe(false);
      await expect(access(first.connectionPath)).resolves.toBeUndefined();
    },
  );

  it.each(["deactivate", "replace", "disable", "revoke"] as const)(
    "aborts current computer input on explicit %s while a view attach preserves it",
    async (action) => {
      const started = deferred<void>();
      let signal: AbortSignal | undefined;
      const broker = await fixture();
      broker.setComputerUseExecutor(
        async (_binding, _request, _id, activeSignal) => {
          signal = activeSignal;
          started.resolve();
          await new Promise<void>((_resolve, reject) =>
            activeSignal.addEventListener(
              "abort",
              () => reject(new Error("cancelled")),
              { once: true },
            ),
          );
          return { content: [] };
        },
      );
      const first = broker.createBinding({
        ...claims,
        executionLaneId: "first",
      });
      const pending = execute(first, true);
      await started.promise;
      broker.createSession({ ...claims, computerUse: false });
      expect(signal?.aborted).toBe(false);
      if (action === "deactivate")
        broker.deactivateBinding(first.connection.bindingId, "first");
      else if (action === "revoke")
        broker.revokeBinding(first.connection.bindingId);
      else
        broker.createBinding({
          ...claims,
          executionLaneId: action === "replace" ? "second" : "first",
          computerUse: action !== "disable",
        });
      expect(signal?.aborted).toBe(true);
      expect((await pending).status).toBe(400);
      if (action === "disable")
        expect((await execute(first, true)).status).toBe(403);
      if (action === "deactivate")
        expect((await execute(first, true)).status).toBe(409);
      if (action === "revoke")
        expect((await execute(first, true)).status).toBe(401);
    },
  );

  it("keeps a live connection stable near expiry and rotates only after actual expiry", async () => {
    let now = Date.parse("2026-08-21T12:00:00Z");
    const broker = await fixture({ now: () => now, ttlMs: 90_000 });
    const session = broker.createSession(claims);
    now += 60_000;
    expect(
      broker.createBinding({ ...claims, executionLaneId: "first" }).connection,
    ).toEqual(session.connection);
    expect(broker.createSession(claims)).toEqual(session);
    now += 30_000;
    const renewed = broker.createSession(claims);
    expect(renewed.connection.bindingId).not.toBe(session.connection.bindingId);
    expect((await execute(session)).status).toBe(401);
    expect((await execute(renewed)).status).toBe(409);
  });

  it("rejects invalid idle or active claims without revoking an existing session", async () => {
    const broker = await fixture({ execute: async () => result });
    const active = broker.createBinding({
      ...claims,
      executionLaneId: "first",
    });
    expect(() =>
      broker.createSession({ ...claims, workerId: "another-worker" }),
    ).toThrow("different worker");
    expect(() =>
      broker.createSession({ ...claims, contextKind: "standalone" } as never),
    ).toThrow();
    expect(() =>
      broker.createBinding({ ...claims, executionLaneId: "" }),
    ).toThrow();
    expect((await execute(active)).status).toBe(200);
  });

  it("recreates both stdio hosts with a fresh idle connection after broker restart", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "cantrip-mcp-restart-"),
    );
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const first = await fixture(
      { execute: async () => result },
      { dataDirectory: directory },
    );
    first.setComputerUseExecutor(async () => ({ content: [] }));
    const old = first.createBinding({ ...claims, executionLaneId: "old-turn" });
    const oldHost = await host(old, "stdio");
    const oldComputerHost = await host(old, "cua-stdio");
    expect(
      await oldHost.callTool({ name: "context_get", arguments: {} }),
    ).not.toHaveProperty("isError", true);
    await first.close();

    const normal = vi.fn(async () => result);
    const computer = vi.fn<CuaMcpExecutor>(async () => ({ content: [] }));
    const next = await fixture(
      { execute: normal },
      { dataDirectory: directory, token: "new-worker-token" },
    );
    next.setComputerUseExecutor(computer);
    const session = next.createSession(claims);
    expect(session.connectionPath).not.toBe(old.connectionPath);
    expect(session.connection.bindingId).not.toBe(old.connection.bindingId);
    expect(session.connection.credential).not.toBe(old.connection.credential);
    expect(session.connection.endpoint).toBe(next.endpoint);
    await expect(access(old.connectionPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(JSON.parse(await readFile(session.connectionPath, "utf8"))).toEqual(
      session.connection,
    );
    expect(
      (
        await execute({
          ...old,
          connection: { ...old.connection, endpoint: next.endpoint! },
        })
      ).status,
    ).toBe(401);

    const coldHost = await host(session, "stdio");
    const coldComputerHost = await host(session, "cua-stdio");
    const computerCall = {
      name: "js_reset",
      arguments: {},
      _meta: {
        threadId: "thread",
        "x-codex-turn-metadata": { turn_id: "turn" },
      },
    };
    expect((await coldHost.listTools()).tools.length).toBeGreaterThan(0);
    expect(
      (await coldComputerHost.listTools()).tools.map(({ name }) => name),
    ).toEqual(["js", "js_reset"]);
    expect(
      await coldHost.callTool({ name: "context_get", arguments: {} }),
    ).toHaveProperty("isError", true);
    expect(await coldComputerHost.callTool(computerCall)).toHaveProperty(
      "isError",
      true,
    );
    expect(normal).not.toHaveBeenCalled();
    expect(computer).not.toHaveBeenCalled();
    expect(
      next.createBinding({ ...claims, executionLaneId: "new-turn" }).connection,
    ).toEqual(session.connection);
    // Old hosts hold their old connection. Even with a new active turn and a
    // replacement connection, a failed old call cannot reload/replay into that turn.
    expect(
      await oldHost.callTool({ name: "context_get", arguments: {} }),
    ).toHaveProperty("isError", true);
    expect(await oldComputerHost.callTool(computerCall)).toHaveProperty(
      "isError",
      true,
    );
    expect(normal).not.toHaveBeenCalled();
    expect(computer).not.toHaveBeenCalled();
    expect(
      await coldHost.callTool({ name: "context_get", arguments: {} }),
    ).not.toHaveProperty("isError", true);
    expect(await coldComputerHost.callTool(computerCall)).not.toHaveProperty(
      "isError",
      true,
    );
    expect(normal).toHaveBeenCalledTimes(1);
    expect(computer.mock.calls[0]?.[0].executionLaneId).toBe("new-turn");
  }, 20_000);

  it("preserves a replacement document when the old broker finishes cleanup late", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "cantrip-mcp-overlap-"),
    );
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const oldBroker = await fixture({}, { dataDirectory: directory });
    const old = oldBroker.createBinding({ ...claims, executionLaneId: "old" });
    const replacement = await fixture(
      { execute: async () => result },
      { dataDirectory: directory },
    );
    // Starting another broker does not sweep documents owned by live brokers.
    expect(JSON.parse(await readFile(old.connectionPath, "utf8"))).toEqual(
      old.connection,
    );
    const next = replacement.createSession(claims);
    expect(next.connectionPath).not.toBe(old.connectionPath);
    // Even an old process rewriting its own document cannot replace the new one.
    oldBroker.createSession(claims);
    expect(JSON.parse(await readFile(next.connectionPath, "utf8"))).toEqual(
      next.connection,
    );
    await oldBroker.close();
    expect(JSON.parse(await readFile(next.connectionPath, "utf8"))).toEqual(
      next.connection,
    );
    expect((await execute(next)).status).toBe(409);
    replacement.createBinding({ ...claims, executionLaneId: "new" });
    expect((await execute(next)).status).toBe(200);
  });

  it("uses opaque per-binding paths and reuses only the current session connection", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "cantrip-mcp-scope-"),
    );
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const broker = await fixture({}, { dataDirectory: directory });
    const base = broker.createSession(claims);
    expect(
      broker.createBinding({ ...claims, executionLaneId: "first-lane" })
        .connectionPath,
    ).toBe(base.connectionPath);
    const paths = new Set([base.connectionPath]);
    for (const variation of [
      { ...claims, ownerId: "another-owner" },
      { ...claims, projectId: "another-project" },
      { ...claims, chatId: "another-chat" },
      {
        ...claims,
        contextKind: "standalone" as const,
        projectId: null,
        worktreeId: null,
        rootKind: null,
        scratchRootId: "scratch-one",
      },
      {
        ...claims,
        contextKind: "standalone" as const,
        projectId: null,
        worktreeId: null,
        rootKind: null,
        scratchRootId: "scratch-two",
      },
    ])
      paths.add(broker.createSession(variation).connectionPath);
    const server = await fixture(
      {},
      { dataDirectory: directory, serverUrl: "https://another-server.invalid" },
    );
    paths.add(server.createSession(claims).connectionPath);
    const worker = await fixture(
      {},
      { dataDirectory: directory, workerId: "another-worker" },
    );
    paths.add(
      worker.createSession({ ...claims, workerId: "another-worker" })
        .connectionPath,
    );
    expect(paths.size).toBe(8);
    const refreshedAuthentication = await fixture(
      {},
      {
        dataDirectory: directory,
        serverUrl:
          "https://login:password@example.invalid/?token=changed#fragment",
        token: "changed-worker-token",
      },
    );
    expect(
      refreshedAuthentication.createSession(claims).connectionPath,
    ).not.toBe(base.connectionPath);
    for (const pathname of paths) {
      expect(path.basename(path.dirname(pathname))).toMatch(/^[a-f0-9-]{36}$/);
    }
    expect(
      broker.createBinding({
        ...claims,
        executionLaneId: "another-lane",
        worktreeId: "another-worktree",
        permissionProfileId: ":read-only",
      }).connectionPath,
    ).not.toBe(base.connectionPath);
  });
});
