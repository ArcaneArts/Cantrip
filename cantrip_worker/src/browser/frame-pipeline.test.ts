import { describe, expect, it, vi } from "vitest";
import { BrowserFramePipeline } from "./frame-pipeline.js";
const viewport = { width: 800, height: 600, devicePixelRatio: 1 };
function fixture() {
  const command = vi.fn(
    async (_method: string, _params?: Record<string, unknown>) => ({}),
  );
  const capture = vi.fn(async () => ({ data: "frame" }));
  return {
    command,
    capture,
    pipeline: new BrowserFramePipeline(command, capture),
  };
}
describe("browser frame pipeline", () => {
  it("coalesces identical initialization, attachment and ready viewports", async () => {
    const { command, pipeline } = fixture();
    await Promise.all([
      pipeline.configure(viewport),
      pipeline.configure(viewport),
      pipeline.configure(viewport),
    ]);
    expect(command.mock.calls.map(([method]) => method)).toEqual([
      "Emulation.setDeviceMetricsOverride",
      "Emulation.setTouchEmulationEnabled",
      "Page.stopScreencast",
      "Page.startScreencast",
    ]);
    await pipeline.configure({ ...viewport, width: 900 });
    expect(command).toHaveBeenCalledTimes(8);
    await pipeline.configure({ ...viewport, width: 900, devicePixelRatio: 2 });
    expect(command).toHaveBeenCalledTimes(12);
  });
  it("restarts the same viewport after suspension, including in-flight setup", async () => {
    const { command, pipeline } = fixture();
    const first = pipeline.configure(viewport);
    const suspend = pipeline.suspend();
    const resume = pipeline.configure(viewport);
    await Promise.all([first, suspend, resume]);
    expect(
      command.mock.calls.filter(
        ([method]) => method === "Page.startScreencast",
      ),
    ).toHaveLength(2);
    expect(command.mock.calls.at(-1)?.[0]).toBe("Page.startScreencast");
  });
  it("does not remember failed configuration or poison subsequent requests", async () => {
    const { command, pipeline } = fixture();
    command.mockRejectedValueOnce(new Error("resize failed"));
    await expect(pipeline.configure(viewport)).rejects.toThrow("resize failed");
    await pipeline.configure(viewport);
    expect(
      command.mock.calls.filter(
        ([method]) => method === "Emulation.setDeviceMetricsOverride",
      ),
    ).toHaveLength(2);
  });
  it("shares only in-flight captures and retries after capture failure", async () => {
    const { capture, pipeline } = fixture();
    const first = pipeline.frame();
    expect(pipeline.frame()).toBe(first);
    await first;
    await pipeline.frame();
    expect(capture).toHaveBeenCalledTimes(2);
    capture.mockRejectedValueOnce(new Error("capture failed"));
    await expect(pipeline.frame()).rejects.toThrow("capture failed");
    await expect(pipeline.frame()).resolves.toEqual({ data: "frame" });
    expect(capture).toHaveBeenCalledTimes(4);
  });
  it("does not reuse a pending frame across navigation or viewport changes", async () => {
    let release!: (frame: { data: string }) => void;
    const { capture, pipeline } = fixture();
    capture.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const old = pipeline.frame();
    await Promise.resolve();
    const generation = pipeline.generation;
    pipeline.invalidateFrames();
    const fresh = pipeline.frame();
    expect(fresh).not.toBe(old);
    release({ data: "old" });
    await Promise.all([old, fresh]);
    expect(pipeline.generation).not.toBe(generation);
    expect(capture).toHaveBeenCalledTimes(2);
  });
  it("restarts capture after renderer replacement but not while suspended", async () => {
    const { command, pipeline } = fixture();
    await pipeline.configure(viewport);
    await pipeline.restart();
    expect(command).toHaveBeenCalledTimes(8);
    await pipeline.suspend();
    await pipeline.restart();
    expect(command).toHaveBeenCalledTimes(9);
    await pipeline.configure(viewport);
    expect(command).toHaveBeenCalledTimes(13);
  });
});
