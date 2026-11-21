import { describe, expect, it, vi } from "vitest";
import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import {
  CodexAppServer,
  CodexNativeRpcError,
  type ManagedNativeGuiCommand,
} from "../src/codex/app-server.js";
import { nativeThreadSettings } from "./fixtures/native-thread-settings.js";

function fixture() {
  const runtime = new CodexAppServer(
    "/unused/codex",
    "/unused/data",
    "/unused/home",
    unprobedCodexRuntimeReport,
  );
  const native = runtime as unknown as {
    request(method: string, params: unknown): Promise<unknown>;
    handleMessage(data: Buffer): void;
    ensureStarted(): Promise<void>;
  };
  const request = vi.fn<typeof native.request>();
  native.request = request;
  native.ensureStarted = vi.fn();
  const commands: ManagedNativeGuiCommand[] = [];
  runtime.setManagedNativeCommandDispatcher("thread-1", async (command) => {
    commands.push(command);
    return command.dispatch();
  });
  const notify = (method: string, params: unknown) =>
    native.handleMessage(Buffer.from(JSON.stringify({ method, params })));
  const options = {
    threadId: "thread-1",
    operationId: "operation-1",
    settingsBindingId: "binding-1",
    nativeEpoch: "native-core",
    patch: { model: "native-model", effort: "high", serviceTier: null },
  };
  const acknowledgment = {
    operationId: options.operationId,
    submissionId: "submission-1",
  };
  const applied = {
    threadId: options.threadId,
    ...acknowledgment,
    threadSettings: nativeThreadSettings({
      model: "native-model",
      effort: "high",
      serviceTier: null,
    }),
  };
  return {
    runtime,
    native,
    request,
    commands,
    notify,
    options,
    acknowledgment,
    applied,
  };
}

describe("explicit native settings controller", () => {
  it("dispatches only the explicit patch after admission without preparing or reading", async () => {
    const f = fixture();
    f.request.mockResolvedValue(f.acknowledgment);
    const result = await f.runtime.updateNativeThreadSettings(f.options);
    expect(result.status).toBe("queued");
    expect(result.applied).toBeNull();
    expect(f.runtime.getNativeThreadSettings("thread-1").confirmed).toBeNull();
    expect(f.commands).toHaveLength(1);
    expect(f.commands[0]).toMatchObject({
      operationId: "operation-1",
      settingsBindingId: "binding-1",
      method: "thread/settings/update",
    });
    expect(f.request.mock.calls).toEqual([
      [
        "thread/settings/update",
        {
          threadId: "thread-1",
          operationId: "operation-1",
          ...f.options.patch,
        },
      ],
    ]);
    expect(f.native.ensureStarted).not.toHaveBeenCalled();
    f.notify("thread/settings/updated", f.applied);
    expect(
      f.runtime.getNativeThreadSettings("thread-1").requests[0]?.status,
    ).toBe("applied");
  });

  it("preserves omitted fields and honors the adapter's normalized native frame", async () => {
    const f = fixture();
    f.request.mockResolvedValue(f.acknowledgment);
    f.runtime.setManagedNativeCommandDispatcher("thread-1", (command) =>
      command.dispatch({
        method: command.method,
        params: { ...command.params, personality: "pragmatic" },
      }),
    );
    await f.runtime.updateNativeThreadSettings({
      ...f.options,
      patch: { effort: "low" },
    });
    expect(f.request.mock.calls).toEqual([
      [
        "thread/settings/update",
        {
          threadId: "thread-1",
          operationId: "operation-1",
          effort: "low",
          personality: "pragmatic",
        },
      ],
    ]);
  });

  it("recognizes application arriving before the queue acknowledgment", async () => {
    const f = fixture();
    f.request.mockImplementation(async () => {
      f.notify("thread/settings/updated", f.applied);
      return f.acknowledgment;
    });
    expect((await f.runtime.updateNativeThreadSettings(f.options)).status).toBe(
      "applied",
    );
  });

  it("does not apply an old binding to an observed replacement Core", async () => {
    const f = fixture();
    f.notify("thread/settings/updated", {
      ...f.applied,
      threadSettings: nativeThreadSettings({
        settingsVersion: { epoch: "replacement-core", revision: "0" },
      }),
    });
    await expect(
      f.runtime.updateNativeThreadSettings(f.options),
    ).rejects.toThrow("Core was replaced");
    expect(f.request).not.toHaveBeenCalled();
  });

  it("requires managed admission and never falls back to direct native input", async () => {
    const f = fixture();
    f.runtime.setManagedNativeCommandDispatcher("thread-1", null);
    await expect(
      f.runtime.updateNativeThreadSettings(f.options),
    ).rejects.toThrow("managed command controller");
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each(["thread", "controller", "transport"])(
    "does not dispatch after %s replacement during admission",
    async (kind) => {
      const f = fixture();
      let dispatch!: () => Promise<unknown>;
      let ready!: () => void;
      const admitted = new Promise<void>((resolve) => {
        ready = resolve;
      });
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.runtime.setManagedNativeCommandDispatcher(
        "thread-1",
        async (command) => {
          dispatch = () => command.dispatch();
          ready();
          await wait;
          return dispatch();
        },
      );
      const result = f.runtime.updateNativeThreadSettings(f.options);
      const rejected = expect(result).rejects.toThrow(/replaced/);
      await admitted;
      if (kind === "thread")
        f.notify("thread/closed", { threadId: "thread-1" });
      else if (kind === "controller")
        f.runtime.setManagedNativeCommandDispatcher("thread-1", null);
      else
        vi.spyOn(f.runtime, "transportGeneration", "get").mockReturnValue(
          "replacement",
        );
      release();
      await rejected;
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it.each(["rejected", "uncertain"] as const)(
    "records %s RPC outcome without retrying",
    async (status) => {
      const f = fixture();
      f.request.mockRejectedValue(
        status === "rejected"
          ? new CodexNativeRpcError("Invalid effort", {
              code: -32602,
              message: "Invalid effort",
            })
          : new Error("Transport lost"),
      );
      await expect(
        f.runtime.updateNativeThreadSettings(f.options),
      ).rejects.toThrow();
      expect(
        f.runtime.getNativeThreadSettings("thread-1").requests[0]?.status,
      ).toBe(status);
      await expect(
        f.runtime.updateNativeThreadSettings(f.options),
      ).rejects.toThrow("identity was reused");
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps applied evidence when the acknowledgment is lost", async () => {
    const f = fixture();
    f.request.mockImplementation(async () => {
      f.notify("thread/settings/updated", f.applied);
      throw new Error("Lost acknowledgment");
    });
    await expect(
      f.runtime.updateNativeThreadSettings(f.options),
    ).rejects.toThrow("Lost acknowledgment");
    expect(
      f.runtime.getNativeThreadSettings("thread-1").requests[0]?.status,
    ).toBe("applied");
  });
});
