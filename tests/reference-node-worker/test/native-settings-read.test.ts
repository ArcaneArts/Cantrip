import { describe, expect, it, vi } from "vitest";
import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import { CodexAppServer } from "../src/codex/app-server.js";
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
  function notify(method: string, params: unknown) {
    native.handleMessage(Buffer.from(JSON.stringify({ method, params })));
  }
  return { runtime, native, request, notify };
}
function snapshot(revision: string, epoch = "native-process-1") {
  return {
    threadId: "thread-1",
    threadSettings: nativeThreadSettings({
      settingsVersion: { epoch, revision },
      model: `model-${revision}`,
    }),
  };
}

// Exercise the production read path, with controlled transport response order.
// Actual native read and process recovery also run in the packaged CLI fixtures.
describe("native settings read", () => {
  it("reads actual native state without starting, resuming or configuring", async () => {
    const f = fixture();
    f.request.mockResolvedValue(snapshot("0"));
    expect(
      (await f.runtime.readNativeThreadSettings("thread-1")).confirmed
        ?.settings,
    ).toEqual(snapshot("0").threadSettings);
    expect(f.request.mock.calls).toEqual([
      ["thread/settings/read", { threadId: "thread-1" }],
    ]);
    expect(f.native.ensureStarted).not.toHaveBeenCalled();
  });

  it("keeps a newer notification when an earlier read arrives later", async () => {
    const f = fixture();
    let resolve!: (value: unknown) => void;
    f.request.mockReturnValue(
      new Promise((yes) => {
        resolve = yes;
      }),
    );
    const read = f.runtime.readNativeThreadSettings("thread-1");
    f.notify("thread/settings/updated", snapshot("2"));
    resolve(snapshot("1"));
    expect((await read).confirmed?.settings).toEqual(
      snapshot("2").threadSettings,
    );
  });

  it.each(["thread", "transport"] as const)(
    "rejects an in-flight read after %s retirement",
    async (kind) => {
      const f = fixture();
      f.notify("thread/settings/updated", snapshot("0"));
      let resolve!: (value: unknown) => void;
      f.request.mockReturnValue(
        new Promise((yes) => {
          resolve = yes;
        }),
      );
      if (kind === "transport")
        vi.spyOn(f.runtime, "transportGeneration", "get").mockReturnValue(
          "transport-1",
        );
      const result = f.runtime.readNativeThreadSettings("thread-1");
      const rejected = expect(result).rejects.toThrow(
        "replaced thread or transport",
      );
      if (kind === "thread")
        f.notify("thread/closed", { threadId: "thread-1" });
      else {
        f.runtime.close();
        vi.spyOn(f.runtime, "transportGeneration", "get").mockReturnValue(
          "transport-2",
        );
      }
      resolve(snapshot("1"));
      await rejected;
      expect(
        f.runtime.getNativeThreadSettings("thread-1").confirmed,
      ).toBeNull();
      f.request.mockResolvedValue(snapshot("0", "native-process-2"));
      expect(
        (await f.runtime.readNativeThreadSettings("thread-1")).confirmed
          ?.settings,
      ).toEqual(snapshot("0", "native-process-2").threadSettings);
    },
  );

  it("does not accept another thread's response or hide a native read error", async () => {
    const f = fixture();
    f.request.mockResolvedValue({ ...snapshot("0"), threadId: "other-thread" });
    await expect(
      f.runtime.readNativeThreadSettings("thread-1"),
    ).rejects.toThrow("another thread");
    expect(f.runtime.getNativeThreadSettings("thread-1").confirmed).toBeNull();
    f.request.mockRejectedValue(new Error("Native thread is not loaded"));
    await expect(
      f.runtime.readNativeThreadSettings("thread-1"),
    ).rejects.toThrow("Native thread is not loaded");
    expect(f.native.ensureStarted).not.toHaveBeenCalled();
  });
});
