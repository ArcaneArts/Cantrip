import { describe, expect, it, vi } from "vitest";
import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import {
  CodexAppServer,
  type ManagedNativeGuiCommand,
} from "../src/codex/app-server.js";
import {
  readNativeAccountDefaults,
  nativeAccountDefaultsParams,
} from "../src/codex/native-account-defaults.js";

const read = (version = "v1") => ({
  config: {
    model: "cli-override",
    model_reasoning_effort: "high",
    service_tier: null,
    mcp_servers: { secret: "do-not-publish" },
    developer_instructions: "private",
  },
  layers: [
    {
      name: { type: "user", profile: null },
      version,
      config: {
        model: "saved",
        personality: "pragmatic",
        secret: "do-not-publish",
      },
    },
    {
      name: { type: "sessionFlags" },
      version: "flags",
      config: { model: "cli-override" },
    },
  ],
});
function fixture() {
  const runtime = new CodexAppServer(
    "/unused/codex",
    "/unused/data",
    "/unused/home",
    unprobedCodexRuntimeReport,
  );
  const native = runtime as unknown as {
    request(method: string, params: unknown): Promise<unknown>;
    ensureStarted(): Promise<void>;
  };
  const request = vi.fn<typeof native.request>().mockResolvedValue(read());
  native.request = request;
  native.ensureStarted = vi.fn();
  const commands: ManagedNativeGuiCommand[] = [];
  runtime.setManagedNativeCommandDispatcher("thread", async (command) => {
    commands.push(command);
    return command.dispatch();
  });
  const options = {
    threadId: "thread",
    operationId: "op",
    settingsBindingId: "binding",
  };
  return { runtime, native, request, commands, options };
}
describe("native account defaults", () => {
  it("uses the selected account user file above an empty conversation home", async () => {
    const result = await readNativeAccountDefaults(async () => ({
      config: { model: "session-model" },
      layers: [
        {
          name: { type: "sessionFlags" },
          version: "flags",
          config: { model: "session-model" },
        },
        {
          name: { type: "user", profile: "another-profile" },
          version: "profile-file",
          config: { model: "profile-model" },
        },
        {
          name: { type: "user", profile: null },
          version: "account-file",
          config: { model: "account-model" },
        },
        { name: { type: "user" }, version: "empty-home", config: {} },
      ],
    }));
    expect(result).toEqual({
      version: "account-file",
      stored: { model: "account-model" },
      effective: { model: "session-model" },
    });
  });
  it("reads only account values without starting or mutating the native thread", async () => {
    const f = fixture();
    expect(await f.runtime.nativeAccountDefaults(f.options)).toEqual({
      verification: "read",
      write: null,
      snapshot: {
        version: "v1",
        stored: { model: "saved", personality: "pragmatic" },
        effective: {
          model: "cli-override",
          model_reasoning_effort: "high",
          service_tier: null,
        },
      },
    });
    expect(f.commands).toHaveLength(0);
    expect(f.request).toHaveBeenCalledExactlyOnceWith("config/read", {
      includeLayers: true,
      cwd: null,
    });
    expect(f.native.ensureStarted).not.toHaveBeenCalled();
  });
  it("writes explicit edits after admission, verifies them and leaves chat settings alone", async () => {
    const f = fixture();
    f.request
      .mockResolvedValueOnce({
        status: "okOverridden",
        version: "v2",
        filePath: "/private/config.toml",
      })
      .mockResolvedValueOnce(read("v2"));
    const result = await f.runtime.nativeAccountDefaults({
      ...f.options,
      write: {
        expectedVersion: "v1",
        values: { model: "saved", service_tier: null },
      },
    });
    expect(result).toMatchObject({
      verification: "confirmed",
      write: { status: "okOverridden", version: "v2" },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /do-not-publish|private|mcp_servers/,
    );
    expect(f.commands).toHaveLength(1);
    expect(f.commands[0]).toMatchObject({
      operationId: "op",
      settingsBindingId: "binding",
      method: "config/batchWrite",
    });
    expect(f.request.mock.calls[0]).toEqual([
      "config/batchWrite",
      {
        expectedVersion: "v1",
        reloadUserConfig: false,
        edits: [
          { keyPath: "model", value: "saved", mergeStrategy: "replace" },
          { keyPath: "service_tier", value: null, mergeStrategy: "replace" },
        ],
      },
    ]);
    expect(f.runtime.getNativeThreadSettings("thread").requests).toEqual([]);
  });
  it.each(["read-error", "changed"])(
    "keeps write evidence after %s without replay",
    async (state) => {
      const f = fixture();
      f.request.mockResolvedValueOnce({ status: "ok", version: "v2" });
      if (state === "read-error")
        f.request.mockRejectedValueOnce(new Error("private native error"));
      else f.request.mockResolvedValueOnce(read("v3"));
      expect(
        await f.runtime.nativeAccountDefaults({
          ...f.options,
          write: { expectedVersion: "v1", values: { model: "saved" } },
        }),
      ).toMatchObject({
        write: { status: "ok", version: "v2" },
        verification: state === "changed" ? "changed" : "unavailable",
      });
      expect(f.request.mock.calls.map(([method]) => method)).toEqual([
        "config/batchWrite",
        "config/read",
      ]);
    },
  );
  it("does not dispatch through a replaced controller", async () => {
    const f = fixture();
    f.runtime.setManagedNativeCommandDispatcher("thread", async (command) => {
      f.runtime.setManagedNativeCommandDispatcher("thread", null);
      return command.dispatch();
    });
    await expect(
      f.runtime.nativeAccountDefaults({
        ...f.options,
        write: { expectedVersion: "v1", values: { model: "next" } },
      }),
    ).rejects.toThrow("replaced");
    expect(f.request).not.toHaveBeenCalled();
  });
  it("never treats a failed write as dispatched or reads/replays it", async () => {
    const f = fixture();
    f.request.mockRejectedValue(new Error("Version conflict"));
    await expect(
      f.runtime.nativeAccountDefaults({
        ...f.options,
        write: { expectedVersion: "old", values: { model: "next" } },
      }),
    ).rejects.toThrow("Version conflict");
    expect(f.request).toHaveBeenCalledOnce();
  });
  it("compares an absent user layer against the pinned empty-config fingerprint", async () => {
    const result = await readNativeAccountDefaults(async () => ({
      config: {},
      layers: [],
    }));
    expect(result.version).toBe(
      "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    );
    expect(result.stored).toEqual({});
  });
  it("rejects unrelated defaults while preserving null removal and omission", () => {
    expect(() =>
      nativeAccountDefaultsParams({
        expectedVersion: "v1",
        values: { approval_policy: "never" } as never,
      }),
    ).toThrow();
    expect(() =>
      nativeAccountDefaultsParams({ expectedVersion: "v1", values: {} }),
    ).toThrow();
    expect(
      nativeAccountDefaultsParams({
        expectedVersion: "v1",
        values: { service_tier: null, model: undefined },
      }).edits,
    ).toEqual([
      { keyPath: "service_tier", value: null, mergeStrategy: "replace" },
    ]);
  });
});
