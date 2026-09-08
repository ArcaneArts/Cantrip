import { describe, expect, it, vi } from "vitest";
import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import {
  CodexAppServer,
  codexRuntimeId,
  type GoalRuntimeOptions,
  type PrepareManagedThreadOptions,
} from "../src/codex/app-server.js";
import { managedCuaMcpServer } from "../src/mcp/managed.js";

const options = {
  cwd: "/unused/cantrip-thread-session-test",
  threadId: "thread-1",
  permissionProfileId: ":workspace",
  model: {
    id: "model-1",
    routeId: "route-1",
    name: "gpt-5.6-sol",
    reasoningEffort: null,
  },
  provider: {
    id: "provider-1",
    name: "ChatGPT",
    kind: "chatgpt",
    baseUrl: "https://api.openai.com/v1",
    apiKey: null,
  },
} satisfies GoalRuntimeOptions & { threadId: string };

const configured = {
  ...options,
  mcpServers: [
    {
      name: "example",
      enabled: true,
      transport: "stdio" as const,
      command: "example-mcp",
      args: [],
      environment: {},
    },
  ],
};

const managed = {
  ...configured,
  executionProfile: "ide",
  subagentDefaults: null,
  planMode: "default",
  intent: "configure",
} satisfies PrepareManagedThreadOptions;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Run the real session preparation and metadata methods against a fake RPC
// transport. No native process, provider, MCP server, or desktop input starts.
function fixture() {
  const runtime = new CodexAppServer(
    "/unused/codex",
    "/unused/data",
    "/unused/home",
    unprobedCodexRuntimeReport,
  );
  const native = runtime as unknown as {
    handleMessage(data: Buffer): void;
    ensureStarted(): Promise<void>;
    methodAvailable(method: string): boolean;
    request(method: string, params: unknown): Promise<unknown>;
    loadThread(
      input: GoalRuntimeOptions,
      create?: boolean,
    ): Promise<string | null>;
  };
  native.ensureStarted = vi.fn().mockResolvedValue(undefined);
  native.methodAvailable = () => true;
  const request = vi.fn(
    async (method: string, params: unknown): Promise<unknown> => {
      if (method === "thread/resume" || method === "thread/start") {
        return { thread: { id: "thread-1" } };
      }
      if (method === "thread/managedConfig/update")
        return { threadId: "thread-1", applied: true };
      if (method === "thread/goal/get") return { goal: null };
      if (method === "collaborationMode/list") {
        return { data: [{ mode: "default" }, { mode: "plan" }] };
      }
      if (method === "thread/read") {
        return {
          thread: { id: "thread-1", turns: [], status: { type: "idle" } },
        };
      }
      if (
        method === "thread/unsubscribe" ||
        method === "thread/settings/update"
      )
        return {};
      throw new Error(
        `Unexpected test RPC: ${method} ${JSON.stringify(params)}`,
      );
    },
  );
  native.request = request;
  return { runtime, native, request };
}

describe("thread session preparation", () => {
  it("retains actual managed ownership when ordinary reload inputs omit MCP and the gate", async () => {
    const f = fixture();
    await f.runtime.prepareManagedThread({
      ...managed,
      executionGate: { runnerGeneration: "runner" },
    });
    f.request.mockClear();
    await f.native.loadThread({
      ...options,
      permissionProfileId: ":read-only",
    });
    const resume = f.request.mock.calls.find(
      ([method]) => method === "thread/resume",
    )![1];
    expect(resume).toMatchObject({
      managedConfig: {
        mcpServers: { example: expect.any(Object) },
        executionGate: { runnerGeneration: "runner" },
      },
    });
    expect(
      f.request.mock.calls.some(([method]) => method === "thread/unsubscribe"),
    ).toBe(false);
    await f.native.loadThread({
      ...options,
      mcpServers: [],
    } as GoalRuntimeOptions);
    expect(f.request).toHaveBeenLastCalledWith(
      "thread/managedConfig/update",
      expect.objectContaining({
        mcpServers: {},
        executionGate: { runnerGeneration: "runner" },
      }),
    );
  });

  it("keeps acknowledged gate ownership after MCP readiness fails", async () => {
    const f = fixture();
    const internals = f.runtime as unknown as {
      ensureManagedMcpReady(): Promise<void>;
    };
    vi.spyOn(internals, "ensureManagedMcpReady")
      .mockRejectedValueOnce(new Error("catalog failed"))
      .mockResolvedValue();
    await expect(
      f.runtime.prepareManagedThread({
        ...managed,
        executionGate: { runnerGeneration: "runner" },
      }),
    ).rejects.toThrow("catalog failed");
    f.request.mockClear();
    await f.native.loadThread(options);
    expect(f.request).toHaveBeenCalledWith(
      "thread/managedConfig/update",
      expect.objectContaining({
        mcpServers: { example: expect.any(Object) },
        executionGate: { runnerGeneration: "runner" },
      }),
    );
    expect(
      f.request.mock.calls.some(([method]) => method === "thread/unsubscribe"),
    ).toBe(false);
  });

  it("retains the actual rearmed gate generation for later managed configuration updates", async () => {
    const f = fixture();
    await f.runtime.prepareManagedThread({
      ...managed,
      executionGate: { runnerGeneration: "old-runner" },
    });
    vi.spyOn(
      f.runtime as unknown as {
        assertManagedExecutionTransport(generation: string): void;
      },
      "assertManagedExecutionTransport",
    ).mockImplementation(() => {});
    const request = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, params) =>
      method === "thread/managedExecution/bind"
        ? { bound: true }
        : method === "thread/managedExecution/invalidate"
          ? { invalidated: true }
          : request(method, params),
    );
    await f.runtime.bindManagedExecution(
      {
        threadId: "thread-1",
        runnerGeneration: "new-runner",
        expectedRunnerGeneration: "old-runner",
      },
      "transport",
    );
    await f.runtime.invalidateManagedExecution(
      { threadId: "thread-1", runnerGeneration: "new-runner" },
      "transport",
    );
    await f.native.loadThread({
      ...options,
      mcpServers: [],
    } as GoalRuntimeOptions);
    expect(f.request).toHaveBeenLastCalledWith(
      "thread/managedConfig/update",
      expect.objectContaining({
        mcpServers: {},
        executionGate: { runnerGeneration: "new-runner" },
      }),
    );
  });

  it("drops retained ownership on an actual foreign thread closure", async () => {
    const f = fixture();
    await f.runtime.prepareManagedThread({
      ...managed,
      executionGate: { runnerGeneration: "runner" },
    });
    f.native.handleMessage(
      Buffer.from(
        JSON.stringify({
          method: "thread/closed",
          params: { threadId: "thread-1" },
        }),
      ),
    );
    f.request.mockClear();
    await f.native.loadThread(options);
    const resume = f.request.mock.calls.find(
      ([method]) => method === "thread/resume",
    )![1];
    expect(resume).not.toHaveProperty("managedConfig");
    expect(
      f.request.mock.calls.some(
        ([method]) => method === "thread/managedConfig/update",
      ),
    ).toBe(false);
  });

  it.each([{ mcpServers: configured.mcpServers }, { mcpServers: [] }])(
    "supplies exact managed startup configuration before any MCP initialization: $mcpServers",
    async ({ mcpServers }) => {
      const f = fixture();
      await f.runtime.prepareManagedThread({
        ...managed,
        threadId: null,
        mcpServers,
      });
      const start = f.request.mock.calls.find(
        ([method]) => method === "thread/start",
      )![1] as {
        managedConfig: Record<string, unknown>;
      };
      const update = f.request.mock.calls.find(
        ([method]) => method === "thread/managedConfig/update",
      )![1] as {
        threadId: string;
      };
      const { threadId, ...configuration } = update;
      expect(threadId).toBe("thread-1");
      expect(start.managedConfig).toEqual(configuration);
      expect(start.managedConfig).toMatchObject({
        mcpServers: mcpServers.length
          ? { example: { command: "example-mcp" } }
          : {},
        developerInstructions: expect.stringContaining(
          "Computer use is not enabled.",
        ),
        multiAgentEnabled: true,
        subagentModel: null,
        subagentReasoningEffort: null,
      });
      expect(Object.keys(start.managedConfig)).toHaveLength(5);
    },
  );

  it("keeps ordinary thread startup outside the managed replacement contract", async () => {
    const f = fixture();
    await f.native.loadThread({ ...configured, threadId: null });
    const start = f.request.mock.calls.find(
      ([method]) => method === "thread/start",
    )![1];
    expect(start).not.toHaveProperty("managedConfig");
  });

  it.each(["configure", "preserve"] as const)(
    "supplies the exact managed profile before a cold %s resume",
    async (intent) => {
      const f = fixture();
      await f.runtime.prepareManagedThread({ ...managed, intent });
      const resume = f.request.mock.calls.find(
        ([method]) => method === "thread/resume",
      )![1] as Record<string, unknown>;
      const update = f.request.mock.calls.find(
        ([method]) => method === "thread/managedConfig/update",
      )![1] as Record<string, unknown>;
      const { threadId, ...configuration } = update;
      expect(resume.managedConfig).toEqual(configuration);
      expect(resume.threadId).toBe(threadId);
      if (intent === "preserve") {
        expect(Object.keys(resume).sort()).toEqual([
          "managedConfig",
          "threadId",
        ]);
      }
    },
  );

  it.each(["thread/unsubscribe", "thread/resume"])(
    "accepts a legacy owned idle-engine replacement observed during %s",
    async (closingMethod) => {
      const f = fixture();
      await f.native.loadThread(configured);
      const request = f.request.getMockImplementation()!;
      f.request.mockImplementation(async (method, params) => {
        if (method === closingMethod) {
          f.native.handleMessage(
            Buffer.from(
              JSON.stringify({
                method: "thread/closed",
                params: { threadId: "thread-1" },
              }),
            ),
          );
        }
        return request(method, params);
      });
      await expect(
        f.native.loadThread({
          ...configured,
          mcpServers: [],
        } as GoalRuntimeOptions),
      ).resolves.toBe("thread-1");
      expect(f.request).toHaveBeenCalledWith("thread/unsubscribe", {
        threadId: "thread-1",
      });
      expect(f.request).toHaveBeenCalledWith(
        "thread/resume",
        expect.objectContaining({ threadId: "thread-1" }),
      );
    },
  );

  it.each(["thread/closed", "thread/status/changed"])(
    "rejects an unrelated %s during cold configure resume",
    async (method) => {
      const f = fixture();
      const entered = deferred<void>();
      const resumed = deferred<unknown>();
      const request = f.request.getMockImplementation()!;
      f.request.mockImplementation(async (method, params) => {
        if (method === "thread/resume") {
          entered.resolve();
          return resumed.promise;
        }
        return request(method, params);
      });
      const pending = f.runtime.prepareManagedThread(managed);
      const rejected = expect(pending).rejects.toThrow(
        "thread closed or changed",
      );
      await entered.promise;
      f.native.handleMessage(
        Buffer.from(
          JSON.stringify({
            method,
            params: { threadId: "thread-1", status: { type: "notLoaded" } },
          }),
        ),
      );
      resumed.resolve({ thread: { id: "thread-1" } });
      await rejected;
      expect(f.request.mock.calls.map(([method]) => method)).toEqual([
        "thread/resume",
      ]);
      f.request.mockImplementation(request);
      await expect(f.runtime.prepareManagedThread(managed)).resolves.toEqual({
        threadId: "thread-1",
      });
      expect(
        f.request.mock.calls.filter(([method]) => method === "thread/resume"),
      ).toHaveLength(2);
    },
  );

  it.each(["thread/closed", "thread/status/changed"])(
    "rehydrates managed configuration after native %s without restarting the worker",
    async (method) => {
      const f = fixture();
      const input = { ...managed, intent: "preserve" as const };
      await f.runtime.prepareManagedThread(input);
      f.request.mockClear();
      f.native.handleMessage(
        Buffer.from(
          JSON.stringify({
            method: "thread/status/changed",
            params: { threadId: "thread-1", status: { type: "idle" } },
          }),
        ),
      );
      await f.runtime.prepareManagedThread(input);
      expect(f.request).not.toHaveBeenCalled();
      f.native.handleMessage(
        Buffer.from(
          JSON.stringify({
            method,
            params: { threadId: "thread-1", status: { type: "notLoaded" } },
          }),
        ),
      );
      await f.runtime.prepareManagedThread(input);
      expect(f.request.mock.calls.map(([name]) => name)).toEqual([
        "thread/resume",
        "thread/managedConfig/update",
      ]);
    },
  );

  it("rejects an in-flight managed receipt after its native thread closes", async () => {
    const f = fixture();
    const entered = deferred<void>();
    const oldUpdate = deferred<unknown>();
    const request = f.request.getMockImplementation()!;
    let first = true;
    f.request.mockImplementation(async (method, params) => {
      if (method === "thread/managedConfig/update" && first) {
        first = false;
        entered.resolve();
        return oldUpdate.promise;
      }
      return request(method, params);
    });
    const input = { ...managed, intent: "preserve" as const };
    const oldPreparation = f.runtime.prepareManagedThread(input);
    const rejected = expect(oldPreparation).rejects.toThrow(
      "thread closed or changed",
    );
    await entered.promise;
    f.native.handleMessage(
      Buffer.from(
        JSON.stringify({
          method: "thread/closed",
          params: { threadId: "thread-1" },
        }),
      ),
    );
    oldUpdate.resolve({ threadId: "thread-1", applied: true });
    await rejected;
    await f.runtime.prepareManagedThread(input);
    expect(
      f.request.mock.calls.filter(([method]) => method === "thread/resume"),
    ).toHaveLength(2);
    expect(
      f.request.mock.calls.filter(
        ([method]) => method === "thread/managedConfig/update",
      ),
    ).toHaveLength(2);
    f.request.mockClear();
    await f.runtime.prepareManagedThread(input);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("applies changed managed material on a preserving attachment without overwriting root settings", async () => {
    const f = fixture();
    const input = { ...managed, intent: "preserve" as const };
    await f.runtime.prepareManagedThread(input);
    f.request.mockClear();
    await f.runtime.prepareManagedThread(input);
    expect(f.request).not.toHaveBeenCalled();
    await f.runtime.prepareManagedThread({ ...input, mcpServers: [] });
    expect(f.request.mock.calls).toEqual([
      [
        "thread/managedConfig/update",
        expect.objectContaining({
          threadId: "thread-1",
          mcpServers: {},
          subagentModel: null,
          subagentReasoningEffort: null,
          multiAgentEnabled: true,
        }),
      ],
    ]);
    expect(f.request.mock.calls[0]![1]).not.toHaveProperty("model");
    expect(f.request.mock.calls[0]![1]).not.toHaveProperty("approvalPolicy");
    expect(f.request.mock.calls[0]![1]).not.toHaveProperty("collaborationMode");
  });

  it("retries an unacknowledged managed update and never caches a different thread's receipt", async () => {
    const f = fixture();
    const request = f.request.getMockImplementation()!;
    let invalid = true;
    f.request.mockImplementation(async (method, params) =>
      method === "thread/managedConfig/update" && invalid
        ? { threadId: "another-thread", applied: true }
        : request(method, params),
    );
    const input = { ...managed, intent: "preserve" as const };
    await expect(f.runtime.prepareManagedThread(input)).rejects.toThrow(
      "did not acknowledge",
    );
    invalid = false;
    await f.runtime.prepareManagedThread(input);
    expect(
      f.request.mock.calls.filter(([method]) => method === "thread/resume"),
    ).toHaveLength(1);
    expect(
      f.request.mock.calls.filter(
        ([method]) => method === "thread/managedConfig/update",
      ),
    ).toHaveLength(2);
  });

  it("keeps omitted managed configuration observational on preserving attachment", async () => {
    const f = fixture();
    await f.runtime.prepareManagedThread({
      ...managed,
      intent: "preserve",
      mcpServers: undefined,
    });
    expect(f.request.mock.calls).toEqual([
      ["thread/resume", { threadId: "thread-1" }],
    ]);
  });

  it("cannot let an old managed update acknowledge or invalidate its replacement runtime", async () => {
    const f = fixture();
    const entered = deferred<void>();
    const oldUpdate = deferred<unknown>();
    const request = f.request.getMockImplementation()!;
    let first = true;
    f.request.mockImplementation(async (method, params) => {
      if (method === "thread/managedConfig/update" && first) {
        first = false;
        entered.resolve();
        return oldUpdate.promise;
      }
      return request(method, params);
    });
    const input = { ...managed, intent: "preserve" as const };
    const oldPreparation = f.runtime.prepareManagedThread(input);
    const rejected = expect(oldPreparation).rejects.toThrow("runtime changed");
    await entered.promise;
    f.runtime.close();
    await f.runtime.prepareManagedThread(input);
    oldUpdate.resolve({ threadId: "thread-1", applied: true });
    await rejected;
    f.request.mockClear();
    await f.runtime.prepareManagedThread(input);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("syncs a prepared custom-child thread using the same native runtime profile", async () => {
    const f = fixture();
    const subagentDefaults = {
      model: { ...options.model, name: "custom-child" },
      provider: options.provider,
    };
    const expectedRuntime = codexRuntimeId(
      options.model,
      options.provider,
      subagentDefaults,
      "ide",
    );
    // Use the real runtime identity function to enforce the profile selected by
    // runtimeFor; an omitted child would start a separate app-server and lose
    // the external-turn baseline.
    f.native.ensureStarted = vi.fn(
      async (...args: Parameters<typeof codexRuntimeId>) => {
        if (codexRuntimeId(...args) !== expectedRuntime)
          throw new Error("Wrong native runtime profile");
      },
    );
    const input = { ...managed, subagentDefaults };
    await f.runtime.prepareManagedThread(input);
    await f.runtime.prepareExternalSync(input);
    f.request.mockClear();
    await expect(f.runtime.syncThread(input)).resolves.toMatchObject({
      threadId: "thread-1",
      turns: [],
    });
    expect(f.native.ensureStarted).toHaveBeenLastCalledWith(
      options.model,
      options.provider,
      subagentDefaults,
      "ide",
    );
    expect(f.request.mock.calls).toEqual([
      ["thread/read", { threadId: "thread-1", includeTurns: true }],
    ]);
  });

  it("reloads managed MCP hosts after credential renewal at a stable connection path", async () => {
    const f = fixture();
    const request = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, params) => {
      if (method === "mcpServerStatus/list")
        return {
          data: [
            {
              name: "cantrip_cua",
              tools: {
                js: { name: "js", inputSchema: {} },
                js_reset: { name: "js_reset", inputSchema: {} },
              },
            },
          ],
          nextCursor: null,
        };
      return request(method, params);
    });
    const input = (generation: string) => ({
      ...options,
      mcpServers: [
        managedCuaMcpServer(
          { command: "node", arguments: ["cua-stdio.js"] },
          "/stable/chat/connection.json",
          generation,
        ),
      ],
    });
    await f.native.loadThread(input("binding-before-expiry"));
    await f.native.loadThread(input("binding-after-expiry"));
    await f.native.loadThread(input("binding-after-expiry"));
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/resume",
      "mcpServerStatus/list",
      "thread/unsubscribe",
      "thread/resume",
      "mcpServerStatus/list",
    ]);
    const resumes = f.request.mock.calls.filter(
      ([method]) => method === "thread/resume",
    );
    expect(resumes[0]?.[1]).toMatchObject({
      config: {
        mcp_servers: {
          cantrip_cua: {
            args: [
              "cua-stdio.js",
              "--connection",
              "/stable/chat/connection.json",
            ],
            env: { CANTRIP_MCP_CONNECTION_GENERATION: "binding-before-expiry" },
          },
        },
      },
    });
    expect(resumes[1]?.[1]).toMatchObject({
      config: {
        mcp_servers: {
          cantrip_cua: {
            args: [
              "cua-stdio.js",
              "--connection",
              "/stable/chat/connection.json",
            ],
            env: { CANTRIP_MCP_CONNECTION_GENERATION: "binding-after-expiry" },
          },
        },
      },
    });
  });

  it("keeps custom child/runtime profile when exposing the endpoint and observing console history", async () => {
    const f = fixture();
    const profile = {
      executionProfile: "ide" as const,
      subagentDefaults: {
        model: { ...options.model, name: "custom-child" },
        provider: options.provider,
      },
    };
    await f.runtime.prepareExternalSync({ ...options, ...profile });
    expect(f.native.ensureStarted).toHaveBeenLastCalledWith(
      options.model,
      options.provider,
      profile.subagentDefaults,
      "ide",
    );
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
    ]);
    // This fixture has no socket; assert actual forwarding before that error.
    await expect(
      f.runtime.remoteEndpoint(options.model, options.provider, profile),
    ).rejects.toThrow("remote endpoint");
    expect(f.native.ensureStarted).toHaveBeenLastCalledWith(
      options.model,
      options.provider,
      profile.subagentDefaults,
      "ide",
    );
  });

  it("prepares complete configuration without a prompt and reuses an applied plan mode", async () => {
    const f = fixture();
    const input: PrepareManagedThreadOptions = {
      ...managed,
      subagentDefaults: {
        model: { ...options.model, name: "gpt-5.6-terra" },
        provider: options.provider,
      },
    };
    await expect(f.runtime.prepareManagedThread(input)).resolves.toEqual({
      threadId: "thread-1",
    });
    expect(f.native.ensureStarted).toHaveBeenCalledWith(
      input.model,
      input.provider,
      input.subagentDefaults,
      "ide",
    );
    expect(f.request.mock.calls[0]?.[1]).toMatchObject({
      config: {
        agents: { default_subagent_model: "gpt-5.6-terra" },
        mcp_servers: { example: { command: "example-mcp" } },
      },
    });
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/resume",
      "thread/managedConfig/update",
      "collaborationMode/list",
      "thread/settings/update",
    ]);
    f.request.mockClear();
    await f.runtime.prepareManagedThread(input);
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "preserves native settings on attach (already loaded: %s) and identifies the supplied thread",
    async (loaded) => {
      const f = fixture();
      if (loaded) await f.runtime.prepareManagedThread(managed);
      f.request.mockClear();
      const onThreadIdentified = vi.fn();
      await f.runtime.prepareManagedThread({
        ...managed,
        intent: "preserve",
        planMode: "plan",
        mcpServers: [],
        permissionProfileId: ":danger-full-access",
        model: { ...options.model, name: "conflicting-attach-default" },
        onThreadIdentified,
      });
      expect(onThreadIdentified).toHaveBeenCalledExactlyOnceWith("thread-1");
      expect(
        f.request.mock.calls.filter(
          ([method]) => method !== "thread/managedConfig/update",
        ),
      ).toEqual(
        loaded
          ? []
          : [
              [
                "thread/resume",
                {
                  threadId: "thread-1",
                  managedConfig: expect.objectContaining({ mcpServers: {} }),
                },
              ],
            ],
      );
      expect(f.request).toHaveBeenCalledWith(
        "thread/managedConfig/update",
        expect.objectContaining({ threadId: "thread-1", mcpServers: {} }),
      );
      const applied = f.request.mock.calls.find(
        ([method]) => method === "thread/managedConfig/update",
      )![1];
      expect(applied).not.toHaveProperty("model");
      expect(applied).not.toHaveProperty("permissionProfileId");
    },
  );

  it("awaits the new identity binding before MCP failure and retries with the same native thread", async () => {
    const f = fixture();
    const identified = deferred<void>();
    const persisted = deferred<void>();
    const request = f.request.getMockImplementation()!;
    const clock = { now: Date.now() };
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock.now);
    let threadId: string | null = null;
    let rejectCatalog = true;
    const nativeError = new Error("MCP initialization failed");
    f.request.mockImplementation(async (method, params) => {
      if (method === "mcpServerStatus/list") {
        expect(threadId).toBe("thread-1");
        if (rejectCatalog) {
          clock.now += 11_000;
          throw nativeError;
        }
        return {
          data: [
            {
              name: "cantrip_cua",
              tools: {
                js: { name: "js", inputSchema: {} },
                js_reset: { name: "js_reset", inputSchema: {} },
              },
            },
          ],
          nextCursor: null,
        };
      }
      return request(method, params);
    });
    const input: PrepareManagedThreadOptions = {
      ...managed,
      threadId: null,
      mcpServers: [{ ...configured.mcpServers[0]!, name: "cantrip_cua" }],
      onThreadIdentified: async (id) => {
        threadId = id;
        identified.resolve();
        await persisted.promise;
      },
    };
    try {
      const prepared = f.runtime.prepareManagedThread(input);
      const failed = expect(prepared).rejects.toMatchObject({
        cause: nativeError,
      });
      await identified.promise;
      expect(f.request.mock.calls.map(([method]) => method)).toEqual([
        "thread/start",
      ]);
      persisted.resolve();
      await failed;
      rejectCatalog = false;
      await expect(
        f.runtime.prepareManagedThread({ ...input, threadId }),
      ).resolves.toEqual({ threadId: "thread-1" });
      expect(f.request.mock.calls.map(([method]) => method)).toEqual([
        "thread/start",
        "thread/managedConfig/update",
        "mcpServerStatus/list",
        "thread/managedConfig/update",
        "mcpServerStatus/list",
        "collaborationMode/list",
        "thread/settings/update",
      ]);
    } finally {
      now.mockRestore();
    }
  });

  it("retains identity before a rejected plan update and retries without starting another thread", async () => {
    const f = fixture();
    const request = f.request.getMockImplementation()!;
    let threadId: string | null = null;
    let rejectPlan = true;
    f.request.mockImplementation(async (method, params) => {
      if (method === "thread/settings/update" && rejectPlan) {
        expect(threadId).toBe("thread-1");
        throw new Error("plan update rejected");
      }
      return request(method, params);
    });
    const input: PrepareManagedThreadOptions = {
      ...managed,
      threadId: null,
      onThreadIdentified: (id) => {
        threadId = id;
      },
    };
    await expect(f.runtime.prepareManagedThread(input)).rejects.toThrow(
      "plan update rejected",
    );
    rejectPlan = false;
    await f.runtime.prepareManagedThread({ ...input, threadId });
    expect(
      f.request.mock.calls.filter(([method]) => method === "thread/start"),
    ).toHaveLength(1);
    expect(
      f.request.mock.calls.filter(([method]) => method === "thread/resume"),
    ).toHaveLength(0);
  });

  it("does not create a native conversation for preserve without an identity", async () => {
    const f = fixture();
    await expect(
      f.runtime.prepareManagedThread({
        ...managed,
        threadId: null,
        intent: "preserve",
      }),
    ).rejects.toThrow("Could not initialize");
    expect(f.request).not.toHaveBeenCalled();
  });

  it("halts preparation when identity persistence fails and retries that same identity", async () => {
    const f = fixture();
    let threadId: string | null = null;
    const onThreadIdentified = vi.fn(async (id: string) => {
      threadId = id;
      throw new Error("binding persistence unavailable");
    });
    await expect(
      f.runtime.prepareManagedThread({
        ...managed,
        threadId: null,
        onThreadIdentified,
      }),
    ).rejects.toThrow("binding persistence unavailable");
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
    ]);
    onThreadIdentified.mockResolvedValue(undefined);
    await f.runtime.prepareManagedThread({
      ...managed,
      threadId,
      onThreadIdentified,
    });
    expect(onThreadIdentified).toHaveBeenCalledTimes(2);
    expect(
      f.request.mock.calls.filter(([method]) => method === "thread/start"),
    ).toHaveLength(1);
  });

  it("does not apply a stale plan after close during collaboration discovery", async () => {
    const f = fixture();
    const entered = deferred<void>();
    const modes = deferred<unknown>();
    const request = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, params) => {
      if (method === "collaborationMode/list") {
        entered.resolve();
        return modes.promise;
      }
      return request(method, params);
    });
    const pending = f.runtime.prepareManagedThread(managed);
    const failed = expect(pending).rejects.toThrow("runtime changed");
    await entered.promise;
    f.runtime.close();
    modes.resolve({ data: [{ mode: "default" }] });
    await failed;
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/resume",
      "thread/managedConfig/update",
      "collaborationMode/list",
    ]);
  });

  it.each(["collaborationMode/list", "thread/settings/update"])(
    "rejects a native thread close while awaiting %s and retries plan preparation",
    async (blockedMethod) => {
      const f = fixture();
      const entered = deferred<void>();
      const blocked = deferred<unknown>();
      const request = f.request.getMockImplementation()!;
      f.request.mockImplementation(async (method, params) => {
        if (method === blockedMethod) {
          entered.resolve();
          return blocked.promise;
        }
        return request(method, params);
      });
      const pending = f.runtime.prepareManagedThread(managed);
      const failed = expect(pending).rejects.toThrow(
        "thread closed or changed",
      );
      await entered.promise;
      f.native.handleMessage(
        Buffer.from(
          JSON.stringify({
            method: "thread/closed",
            params: { threadId: "thread-1" },
          }),
        ),
      );
      blocked.resolve(
        blockedMethod === "collaborationMode/list"
          ? { data: [{ mode: "default" }] }
          : {},
      );
      await failed;
      if (blockedMethod === "collaborationMode/list") {
        expect(f.request.mock.calls.map(([method]) => method)).not.toContain(
          "thread/settings/update",
        );
      }
      f.request.mockImplementation(request);
      f.request.mockClear();
      await expect(f.runtime.prepareManagedThread(managed)).resolves.toEqual({
        threadId: "thread-1",
      });
      expect(f.request).toHaveBeenCalledWith(
        "thread/resume",
        expect.objectContaining({ threadId: "thread-1" }),
      );
      expect(f.request).toHaveBeenCalledWith(
        "thread/settings/update",
        expect.objectContaining({ threadId: "thread-1" }),
      );
    },
  );

  it("reads goal and plan metadata without reconfiguring a loaded thread", async () => {
    const f = fixture();
    await f.native.loadThread(configured);
    f.request.mockClear();

    await expect(f.runtime.getGoal(options)).resolves.toEqual({ goal: null });
    await expect(
      f.runtime.getPlanMode({ ...options, fallbackMode: "plan" }),
    ).resolves.toEqual({
      mode: "plan",
      threadId: "thread-1",
    });

    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/goal/get",
    ]);
    // Reading metadata must not invalidate the already applied configuration.
    await f.native.loadThread(configured);
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/goal/get",
    ]);
  });

  it.each(["goal", "plan"] as const)(
    "cold %s observation preserves native configuration",
    async (kind) => {
      const f = fixture();
      if (kind === "goal") await f.runtime.getGoal(options);
      else await f.runtime.getPlanMode({ ...options, fallbackMode: "default" });

      expect(
        f.request.mock.calls.filter(([method]) => method === "thread/resume"),
      ).toEqual([]);
      if (kind === "plan")
        expect(f.native.ensureStarted).not.toHaveBeenCalled();
      expect(
        f.request.mock.calls.some(([method]) =>
          [
            "thread/start",
            "thread/unsubscribe",
            "thread/settings/update",
          ].includes(method),
        ),
      ).toBe(false);
    },
  );

  it("returns concurrent cold Plan Mode fallbacks without starting or loading native", async () => {
    const f = fixture();
    await expect(
      Promise.all([
        f.runtime.getPlanMode({ ...options, fallbackMode: "plan" }),
        f.runtime.getPlanMode({ ...options, fallbackMode: "default" }),
      ]),
    ).resolves.toEqual([
      { mode: "plan", threadId: "thread-1" },
      { mode: "default", threadId: "thread-1" },
    ]);
    expect(f.native.ensureStarted).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });

  it("returns the live native mode instead of the display fallback", async () => {
    const f = fixture();
    f.native.handleMessage(
      Buffer.from(
        JSON.stringify({
          method: "thread/settings/updated",
          params: {
            threadId: "thread-1",
            threadSettings: { collaborationMode: { mode: "plan" } },
          },
        }),
      ),
    );
    await expect(
      f.runtime.getPlanMode({ ...options, fallbackMode: "default" }),
    ).resolves.toEqual({ mode: "plan", threadId: "thread-1" });
    expect(f.native.ensureStarted).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });

  it("serializes competing explicit configurations and applies the later removal last", async () => {
    const f = fixture();
    const resumed = deferred<unknown>();
    const entered = deferred<void>();
    f.request.mockImplementationOnce(async () => {
      entered.resolve();
      return resumed.promise;
    });
    const first = f.native.loadThread(configured);
    await entered.promise;
    const second = f.native.loadThread({ ...options, mcpServers: [] });
    resumed.resolve({ thread: { id: "thread-1" } });
    await Promise.all([first, second]);

    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/resume",
      "thread/unsubscribe",
      "thread/resume",
    ]);
    expect(f.request.mock.calls[0]?.[1]).toMatchObject({
      config: { mcp_servers: { example: { command: "example-mcp" } } },
    });
    expect(f.request.mock.calls[2]?.[1]).toMatchObject({
      config: { mcp_servers: {} },
    });
  });

  it("deduplicates concurrent applications of the same explicit configuration", async () => {
    const f = fixture();
    await Promise.all([
      f.native.loadThread(configured),
      f.native.loadThread(configured),
    ]);
    expect(
      f.request.mock.calls.filter(([method]) => method === "thread/resume"),
    ).toHaveLength(1);
  });

  it("serializes configuration removal behind the real managed MCP catalog result", async () => {
    const f = fixture();
    const catalog = deferred<unknown>();
    const entered = deferred<void>();
    const request = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, params) => {
      if (method === "mcpServerStatus/list") {
        entered.resolve();
        return catalog.promise;
      }
      return request(method, params);
    });
    const withCua = {
      ...configured,
      mcpServers: [{ ...configured.mcpServers[0]!, name: "cantrip_cua" }],
    };
    const prepared = f.native.loadThread(withCua);
    await entered.promise;
    const removed = f.native.loadThread({ ...options, mcpServers: [] });
    catalog.resolve({
      data: [
        {
          name: "cantrip_cua",
          tools: {
            js: { name: "js", inputSchema: {} },
            js_reset: { name: "js_reset", inputSchema: {} },
          },
        },
      ],
      nextCursor: null,
    });
    await Promise.all([prepared, removed]);

    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/resume",
      "mcpServerStatus/list",
      "thread/unsubscribe",
      "thread/resume",
    ]);
    expect(f.request.mock.calls[3]?.[1]).toMatchObject({
      config: { mcp_servers: {} },
    });
    // The later removal remains applied; the earlier catalog must not reset it.
    await f.native.loadThread({ ...options, mcpServers: [] });
    expect(f.request).toHaveBeenCalledTimes(4);
  });

  it("retries explicit preparation after a rejected resume without caching success or creating a thread", async () => {
    const f = fixture();
    f.request.mockRejectedValueOnce(new Error("MCP configuration rejected"));
    await expect(f.native.loadThread(configured)).rejects.toThrow(
      "MCP configuration rejected",
    );
    await expect(f.native.loadThread(configured)).resolves.toBe("thread-1");
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/resume",
      "thread/resume",
    ]);
    expect(f.request.mock.calls[1]?.[1]).toMatchObject({
      config: { mcp_servers: { example: { command: "example-mcp" } } },
    });
  });

  it.each(["configure", "preserve"] as const)(
    "handles subsequent %s requests after rejected reconfiguration",
    async (next) => {
      const f = fixture();
      await f.native.loadThread(configured);
      const request = f.request.getMockImplementation()!;
      let rejectResume = true;
      f.request.mockImplementation(async (method, params) => {
        if (method === "thread/resume" && rejectResume) {
          rejectResume = false;
          throw new Error("replacement configuration rejected");
        }
        return request(method, params);
      });
      await expect(
        f.native.loadThread({ ...options, mcpServers: [] }),
      ).rejects.toThrow("replacement configuration rejected");
      f.request.mockClear();

      if (next === "configure") await f.native.loadThread(configured);
      else await f.runtime.getPlanMode({ ...options, fallbackMode: "default" });
      expect(f.request.mock.calls.map(([method]) => method)).toEqual(
        next === "configure" ? ["thread/resume"] : [],
      );
      if (next === "configure") {
        expect(f.request.mock.calls[0]?.[1]).toMatchObject({
          config: { mcp_servers: { example: { command: "example-mcp" } } },
        });
      }
    },
  );

  it("keeps explicit empty MCP configuration distinct from omitted observation fields", async () => {
    const f = fixture();
    await f.native.loadThread(configured);
    f.request.mockClear();
    await f.runtime.getGoal(options);
    await f.native.loadThread({ ...options, mcpServers: [] });
    const resumes = f.request.mock.calls.filter(
      ([method]) => method === "thread/resume",
    );
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.[1]).toMatchObject({ config: { mcp_servers: {} } });
    expect(resumes[0]?.[1]).toHaveProperty(
      "developerInstructions",
      expect.stringContaining("Computer use is not enabled."),
    );
  });

  it("keeps the display fallback available while native transport is unavailable", async () => {
    const f = fixture();
    f.request.mockRejectedValue(new Error("native connection lost"));
    await expect(
      f.runtime.getPlanMode({ ...options, fallbackMode: "default" }),
    ).resolves.toEqual({ mode: "default", threadId: "thread-1" });
    await expect(
      f.runtime.getPlanMode({
        ...options,
        threadId: null,
        fallbackMode: "plan",
      }),
    ).resolves.toEqual({ mode: "plan", threadId: null });
    expect(f.native.ensureStarted).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)(
    "invalidates pending preparation on close even when its old RPC later %ss",
    async (settlement) => {
      const f = fixture();
      const resumed = deferred<unknown>();
      const entered = deferred<void>();
      f.request.mockImplementationOnce(async () => {
        entered.resolve();
        return resumed.promise;
      });
      const pending = f.native.loadThread(configured);
      // Attach a rejection handler before close to avoid unhandled promises.
      const settled = pending.then(
        () => ({ rejected: false }),
        () => ({ rejected: true }),
      );
      await entered.promise;
      f.runtime.close();
      if (settlement === "resolve")
        resumed.resolve({ thread: { id: "thread-1" } });
      else resumed.reject(new Error("old transport closed"));
      await expect(settled).resolves.toEqual({ rejected: true });
      expect(f.request.mock.calls.map(([method]) => method)).toEqual([
        "thread/resume",
      ]);

      // A new runtime generation must resume again, not trust the late reply.
      await f.native.loadThread(configured);
      expect(f.request.mock.calls.map(([method]) => method)).toEqual([
        "thread/resume",
        "thread/resume",
      ]);
    },
  );
});

describe("managed autonomous gate installation", () => {
  it.each(["configure", "preserve"] as const)(
    "installs the gate in the first cold %s resume and retains it in the live overlay",
    async (intent) => {
      const f = fixture();
      await f.runtime.prepareManagedThread({
        ...managed,
        intent,
        executionGate: { runnerGeneration: "runner" },
      });
      const resume = f.request.mock.calls.find(
        ([method]) => method === "thread/resume",
      )!;
      const update = f.request.mock.calls.find(
        ([method]) => method === "thread/managedConfig/update",
      )!;
      expect(resume[1]).toMatchObject({
        managedConfig: { executionGate: { runnerGeneration: "runner" } },
      });
      expect(update[1]).toMatchObject({
        executionGate: { runnerGeneration: "runner" },
      });
      expect(
        f.request.mock.calls.findIndex(
          ([method]) => method === "thread/resume",
        ),
      ).toBeLessThan(
        f.request.mock.calls.findIndex(
          ([method]) => method === "thread/managedConfig/update",
        ),
      );
    },
  );
});

describe("remaining managed GUI native mutations", () => {
  const goal = {
    threadId: "thread-1",
    objective: "actual goal",
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
  };

  it.each(["compact", "update-goal", "clear-goal"] as const)(
    "keeps %s on its bound engine and waits for admission",
    async (action) => {
      const f = fixture();
      const entered = deferred<void>();
      const release = deferred<void>();
      const methods: string[] = [];
      f.request.mockImplementation(async (method) =>
        method === "thread/goal/set"
          ? { goal }
          : method === "thread/goal/clear"
            ? { cleared: true }
            : {},
      );
      f.runtime.setManagedNativeCommandDispatcher(
        "thread-1",
        async (command) => {
          methods.push(command.method);
          entered.resolve();
          await release.promise;
          return command.dispatch();
        },
      );
      const pending =
        action === "compact"
          ? f.runtime.compactThread({ ...options, executionProfile: "ide" })
          : action === "update-goal"
            ? f.runtime.updateGoal({ ...options, status: "active" })
            : f.runtime.clearGoal(options);
      await entered.promise;
      expect(f.native.ensureStarted).not.toHaveBeenCalled();
      expect(f.request).not.toHaveBeenCalled();
      release.resolve();
      await pending;
      expect(f.request.mock.calls.map(([method]) => method)).toEqual(methods);
      expect(methods).toEqual([
        action === "compact"
          ? "thread/compact/start"
          : action === "update-goal"
            ? "thread/goal/set"
            : "thread/goal/clear",
      ]);
    },
  );

  it("admits both precise revert and its actual unsupported pagination fallback", async () => {
    const f = fixture();
    const methods: string[] = [];
    f.runtime.setManagedNativeCommandDispatcher("thread-1", async (command) => {
      methods.push(command.method);
      return command.dispatch();
    });
    f.request.mockImplementation(async (method) => {
      if (method === "thread/read")
        return {
          thread: {
            turns: [
              {
                id: "native-turn",
                items: [{ type: "userMessage", clientId: "cantrip:message" }],
              },
            ],
          },
        };
      if (method === "thread/revert")
        throw new Error("paginated history not supported");
      if (method === "thread/rollback") return {};
      throw new Error(`Unexpected ${method}`);
    });
    await f.runtime.rollbackLatestChatTurn({
      ...options,
      executionProfile: "ide",
      clientMessageId: "message",
    });
    expect(methods).toEqual(["thread/revert", "thread/rollback"]);
    expect(f.request).toHaveBeenCalledWith("thread/revert", {
      threadId: "thread-1",
      beforeTurnId: "native-turn",
    });
    expect(f.request).toHaveBeenCalledWith("thread/rollback", {
      threadId: "thread-1",
      numTurns: 1,
    });
    expect(f.native.ensureStarted).not.toHaveBeenCalled();
  });

  it("admits completed goal replacement clear and set separately while goal reads remain observational", async () => {
    const f = fixture();
    const methods: string[] = [];
    const operationIds: Array<string | undefined> = [];
    f.runtime.setManagedNativeCommandDispatcher("thread-1", async (command) => {
      methods.push(command.method);
      operationIds.push(command.operationId);
      return command.dispatch();
    });
    f.request.mockImplementation(async (method) =>
      method === "thread/goal/get"
        ? { goal: { ...goal, status: "complete" } }
        : method === "thread/goal/clear"
          ? { cleared: true }
          : { goal },
    );
    await f.runtime.getGoal(options);
    expect(methods).toEqual([]);
    await f.runtime.createGoal({
      ...options,
      objective: "next",
      operationId: "stable-user-message",
    });
    expect(methods).toEqual(["thread/goal/clear", "thread/goal/set"]);
    expect(operationIds).toEqual([
      "stable-user-message:clear",
      "stable-user-message",
    ]);
    expect(f.native.ensureStarted).not.toHaveBeenCalled();
    expect(
      f.request.mock.calls.some(
        ([method]) => method === "thread/resume" || method === "thread/start",
      ),
    ).toBe(false);
  });
});

describe("resuming actual managed native automation", () => {
  const activeGoal = {
    threadId: "thread-1",
    objective: "native objective",
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  it("reads the actual goal and rearms it through admitted goal/set after idle Stop", async () => {
    const f = fixture();
    const calls: Array<{ method: string; params: unknown }> = [];
    f.runtime.setManagedNativeCommandDispatcher("thread-1", async (command) => {
      calls.push({ method: command.method, params: command.params });
      return command.dispatch();
    });
    await f.runtime.interruptChat("chat", "thread-1");
    expect(f.request).not.toHaveBeenCalled();
    f.request.mockImplementation(async (method) => {
      if (method === "thread/goal/get" || method === "thread/goal/set")
        return { goal: activeGoal };
      throw new Error(`Unexpected ${method}`);
    });
    await expect(
      f.runtime.resumeManagedAutomation({ threadId: "thread-1" }),
    ).resolves.toEqual({ resumed: true });
    expect(calls).toEqual([
      { method: "turn/interrupt", params: { threadId: "thread-1" } },
      {
        method: "thread/goal/set",
        params: { threadId: "thread-1", status: "active" },
      },
    ]);
    expect(f.native.ensureStarted).not.toHaveBeenCalled();
  });

  it("gives the canonical queue priority and never consults native queue storage after cutover", async () => {
    const f = fixture();
    f.runtime.setManagedNativeCommandDispatcher("thread-1", async (command) =>
      command.dispatch(),
    );
    const resume = vi.fn(async () => ({ resumed: true }));
    f.runtime.setManagedQueueResume("thread-1", resume);
    expect(
      await f.runtime.resumeManagedAutomation({ threadId: "thread-1" }),
    ).toEqual({ resumed: true });
    expect(resume).toHaveBeenCalledOnce();
    expect(f.request).not.toHaveBeenCalled();
    resume.mockResolvedValue({ resumed: false });
    f.request.mockResolvedValue({ goal: null });
    expect(
      await f.runtime.resumeManagedAutomation({ threadId: "thread-1" }),
    ).toEqual({ resumed: false });
    expect(f.request.mock.calls).toEqual([
      ["thread/goal/get", { threadId: "thread-1" }],
    ]);
  });

  it("resumes an active goal only after the canonical queue reports no eligible input", async () => {
    const f = fixture();
    const order: string[] = [];
    f.runtime.setManagedNativeCommandDispatcher("thread-1", async (command) =>
      command.dispatch(),
    );
    f.runtime.setManagedQueueResume("thread-1", async () => {
      order.push("canonical");
      return { resumed: false };
    });
    f.request.mockImplementation(async (method) => {
      order.push(method);
      return { goal: activeGoal };
    });
    expect(
      await f.runtime.resumeManagedAutomation({ threadId: "thread-1" }),
    ).toEqual({ resumed: true });
    expect(order).toEqual(["canonical", "thread/goal/get", "thread/goal/set"]);
  });

  it("keeps old queue cleanup from removing a replacement handler and rejects an in-flight replacement", async () => {
    const f = fixture();
    f.runtime.setManagedNativeCommandDispatcher("thread-1", async (command) =>
      command.dispatch(),
    );
    const removeOld = f.runtime.setManagedQueueResume("thread-1", async () => ({
      resumed: false,
    }));
    const pending = deferred<{ resumed: boolean }>();
    const current = vi.fn(() => pending.promise);
    f.runtime.setManagedQueueResume("thread-1", current);
    removeOld();
    const result = f.runtime.resumeManagedAutomation({ threadId: "thread-1" });
    expect(current).toHaveBeenCalledOnce();
    f.runtime.setManagedQueueResume("thread-1", async () => ({
      resumed: false,
    }));
    pending.resolve({ resumed: true });
    await expect(result).rejects.toThrow("replaced during resume");
    expect(f.request).not.toHaveBeenCalled();
  });

  it("forwards only the exact owner wake RPC and preserves the native stopped result", async () => {
    const f = fixture();
    const generation = vi
      .spyOn(f.runtime, "transportGeneration", "get")
      .mockReturnValue("transport");
    f.request.mockResolvedValue({ scheduled: false });
    expect(
      await f.runtime.wakeManagedExecution(
        { threadId: "thread-1", runnerGeneration: "runner" },
        "transport",
      ),
    ).toEqual({ scheduled: false });
    expect(f.request.mock.calls).toEqual([
      [
        "thread/managedExecution/wake",
        { threadId: "thread-1", runnerGeneration: "runner" },
      ],
    ]);
    generation.mockReturnValue("replacement");
    await expect(
      f.runtime.wakeManagedExecution(
        { threadId: "thread-1", runnerGeneration: "runner" },
        "transport",
      ),
    ).rejects.toThrow("replaced native transport");
    expect(f.request).toHaveBeenCalledOnce();
  });

  it("starts the existing native queue when no active goal exists", async () => {
    const f = fixture();
    const mutations: string[] = [];
    f.runtime.setManagedNativeCommandDispatcher("thread-1", async (command) => {
      mutations.push(command.method);
      return command.dispatch();
    });
    f.request.mockImplementation(async (method) =>
      method === "thread/goal/get"
        ? { goal: { ...activeGoal, status: "paused" } }
        : method === "thread/queue/list"
          ? { data: [{ id: "actual-queued-input" }], nextCursor: null }
          : { turn: { id: "actual-turn" } },
    );
    await expect(
      f.runtime.resumeManagedAutomation({ threadId: "thread-1" }),
    ).resolves.toEqual({ resumed: true });
    expect(f.request.mock.calls).toEqual([
      ["thread/goal/get", { threadId: "thread-1" }],
      ["thread/queue/list", { threadId: "thread-1", limit: 1 }],
      ["thread/queue/start", { threadId: "thread-1" }],
    ]);
    expect(mutations).toEqual(["thread/queue/start"]);
    expect(f.native.ensureStarted).not.toHaveBeenCalled();
  });

  it("reports no native work without creating a prompt or engine and surfaces actual read failure", async () => {
    const f = fixture();
    const dispatch = vi.fn(async (command) => command.dispatch());
    f.runtime.setManagedNativeCommandDispatcher("thread-1", dispatch);
    f.request.mockImplementation(async (method) =>
      method === "thread/goal/get"
        ? { goal: null }
        : { data: [], nextCursor: null },
    );
    await expect(
      f.runtime.resumeManagedAutomation({ threadId: "thread-1" }),
    ).resolves.toEqual({ resumed: false });
    expect(dispatch).not.toHaveBeenCalled();
    expect(f.native.ensureStarted).not.toHaveBeenCalled();
    const failure = new Error("native connection lost");
    f.request.mockRejectedValue(failure);
    await expect(
      f.runtime.resumeManagedAutomation({ threadId: "thread-1" }),
    ).rejects.toBe(failure);
    await expect(
      f.runtime.resumeManagedAutomation({ threadId: "unbound" }),
    ).rejects.toThrow("bound managed native session");
  });
});
