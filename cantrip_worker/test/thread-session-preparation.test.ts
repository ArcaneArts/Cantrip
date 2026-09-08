import { describe, expect, it, vi } from "vitest";
import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import {
  CodexAppServer,
  type GoalRuntimeOptions,
} from "../src/codex/app-server.js";

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
      ).toEqual(
        kind === "goal" ? [] : [["thread/resume", { threadId: "thread-1" }]],
      );
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

  it("coalesces concurrent cold observations into one identity-only resume", async () => {
    const f = fixture();
    const resumed = deferred<unknown>();
    const entered = deferred<void>();
    f.request.mockImplementationOnce(async () => {
      entered.resolve();
      return resumed.promise;
    });
    const first = f.runtime.getPlanMode({
      ...options,
      fallbackMode: "default",
    });
    await entered.promise;
    const plan = f.runtime.getPlanMode({ ...options, fallbackMode: "default" });
    resumed.resolve({ thread: { id: "thread-1" } });
    await Promise.all([first, plan]);
    expect(
      f.request.mock.calls.filter(([method]) => method === "thread/resume"),
    ).toEqual([["thread/resume", { threadId: "thread-1" }]]);
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
    "reloads after a failed reconfiguration before a subsequent %s request",
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
      expect(f.request.mock.calls.map(([method]) => method)).toEqual([
        "thread/resume",
      ]);
      if (next === "configure") {
        expect(f.request.mock.calls[0]?.[1]).toMatchObject({
          config: { mcp_servers: { example: { command: "example-mcp" } } },
        });
      } else {
        expect(f.request.mock.calls[0]?.[1]).toEqual({ threadId: "thread-1" });
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

  it("does not create a replacement thread after an observation fails and allows retry", async () => {
    const f = fixture();
    f.request.mockRejectedValueOnce(new Error("native connection lost"));
    await expect(
      f.runtime.getPlanMode({ ...options, fallbackMode: "default" }),
    ).rejects.toThrow();
    await expect(
      f.runtime.getPlanMode({ ...options, fallbackMode: "default" }),
    ).resolves.toEqual({ mode: "default", threadId: "thread-1" });
    expect(
      f.request.mock.calls.filter(([method]) => method === "thread/resume"),
    ).toEqual([
      ["thread/resume", { threadId: "thread-1" }],
      ["thread/resume", { threadId: "thread-1" }],
    ]);
    expect(
      f.request.mock.calls.some(([method]) => method === "thread/start"),
    ).toBe(false);
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
