import { describe, expect, it, vi } from "vitest";
import { CuaEffects } from "./effects.js";
import type { CuaTransport } from "./transport.js";

const off = { effect: "off" as const, parameters: {} };
const debug = {
  effect: "debug-gradient" as const,
  parameters: { strength: 0.5 },
};
function fixture() {
  let active: CuaTransport | null = null;
  let configuration = off as typeof off | typeof debug;
  const request = vi.fn(async (operation: any) => {
    if (operation.operation === "effects.configure")
      configuration = operation.configuration;
    return {
      payload: Buffer.alloc(0),
      data: { supported: true, configuration, windows: [] },
    };
  });
  const transport: CuaTransport = {
    request,
    closed: false,
    close: async () => {},
  };
  const effects = new CuaEffects(() => active);
  return {
    effects,
    request,
    transport,
    start: (replacement = transport) => {
      active = replacement;
    },
    stop: () => {
      active = null;
    },
  };
}
describe("account-owned effect synchronization", () => {
  it("stores settings without starting a helper and applies them on its actual launch", async () => {
    const f = fixture();
    expect(
      (await f.effects.update({ revision: 2, configuration: debug })).state,
    ).toBe("idle");
    expect(f.request).not.toHaveBeenCalled();
    f.start();
    await f.effects.synchronize();
    expect(f.request).toHaveBeenCalledWith({
      operation: "effects.configure",
      configuration: debug,
    });
    await f.effects.synchronize();
    expect(f.request).toHaveBeenLastCalledWith({ operation: "effects.get" });
  });
  it("ignores stale heartbeats after a newer disable and re-applies on replacement", async () => {
    const f = fixture();
    f.start();
    await f.effects.update({ revision: 7, configuration: debug });
    await f.effects.update({ revision: 8, configuration: off });
    await f.effects.update({ revision: 7, configuration: debug });
    expect(f.effects.status().configuration).toEqual(off);
    expect(f.effects.status().native?.configuration).toEqual(off);
    expect(
      f.request.mock.calls.filter(
        ([op]) => op.operation === "effects.configure",
      ),
    ).toHaveLength(2);
    f.stop();
    expect(f.effects.status().native).toBeNull();
    f.start({ ...f.transport });
    await f.effects.synchronize();
    expect(f.request).toHaveBeenLastCalledWith({
      operation: "effects.configure",
      configuration: off,
    });
  });
  it("serializes changes that arrive during a native request, with newest configuration last", async () => {
    const f = fixture();
    f.start();
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    f.request.mockImplementationOnce(async () => {
      await gate;
      return {
        payload: Buffer.alloc(0),
        data: { supported: true, configuration: debug, windows: [] },
      };
    });
    const first = f.effects.update({ revision: 2, configuration: debug });
    await Promise.resolve();
    const second = f.effects.update({ revision: 3, configuration: off });
    resume();
    await Promise.all([first, second]);
    expect(f.effects.status().native?.configuration).toEqual(off);
    expect(f.effects.status().revision).toBe(3);
  });
  it("reports render configuration failure without throwing into input or heartbeat", async () => {
    const f = fixture();
    f.start();
    f.request.mockRejectedValueOnce(new Error("Shader unavailable"));
    const status = await f.effects.update({
      revision: 2,
      configuration: debug,
    });
    expect(status.state).toBe("failed");
    expect(status.error).toBe("Shader unavailable");
    expect((await f.effects.synchronize()).error).toBeNull();
  });
  it("leaves older callers that have not received settings untouched", async () => {
    const f = fixture();
    f.start();
    await f.effects.synchronize();
    expect(f.request).not.toHaveBeenCalled();
  });
});
