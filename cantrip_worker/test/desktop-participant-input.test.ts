import { describe, expect, it, vi } from "vitest";
import { DesktopParticipantInput } from "../src/desktop/participant-input.js";
import type {
  InteractionParticipant,
  WorkerInputParticipants,
} from "../src/computer-use/participants.js";
import { remoteDesktopClientMessageSchema } from "@cantrip/protocol";
const target = {
  kind: "window" as const,
  id: "42",
  title: "Piano",
  application: "Brave",
};
const size = {
  pixelWidth: 200,
  pixelHeight: 200,
  logicalWidth: 100,
  logicalHeight: 100,
};
function fixture(
  presentation: {
    assets?: (...args: any[]) => void;
    cursor?: (...args: any[]) => void;
  } = {},
) {
  const instances: Array<{
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const open = vi.fn<WorkerInputParticipants["open"]>(async () => {
    const participant = {
      send: vi.fn(async () => ({})),
      close: vi.fn(async () => {}),
    };
    instances.push(participant);
    return participant as unknown as InteractionParticipant;
  });
  const state = vi.fn();
  const clipboard = vi.fn();
  const readClipboard = vi.fn(async () => "copied");
  const input = new DesktopParticipantInput({
    ...presentation,
    workerId: "worker",
    surfaceId: "surface",
    participants: { open },
    state,
    clipboard,
    readClipboard,
  });
  const epoch = (id: string) =>
    state.mock.calls.filter((c) => c[0] === id && c[1]).at(-1)![1] as string;
  const message = (id: string, sequence: number, fields: object) =>
    remoteDesktopClientMessageSchema.parse({
      type: "pointer",
      event: "down",
      x: 50,
      y: 80,
      button: "left",
      inputEpoch: epoch(id),
      inputSequence: sequence,
      ...fields,
    }) as Parameters<DesktopParticipantInput["send"]>[1];
  return { input, open, state, instances, epoch, message, clipboard };
}
describe("remote desktop participant input", () => {
  it("routes buttons, motion, scrolling and physical key holds to independent participants", async () => {
    const f = fixture();
    await f.input.attach("a", target);
    await f.input.attach("b", target);
    expect(f.open.mock.calls[0]![1]).toBe("macos-window-42");
    await f.input.send(
      "a",
      f.message("a", 1, { button: "back", modifiers: 4 }),
      size,
    );
    await f.input.send("a", f.message("a", 2, { event: "move" }), size);
    await f.input.send(
      "a",
      f.message("a", 3, { event: "up", button: "back" }),
      size,
    );
    await f.input.send(
      "b",
      f.message("b", 1, { event: "wheel", deltaY: 40 }),
      size,
    );
    const key = {
      type: "key",
      event: "down",
      key: "k",
      code: "KeyK",
      modifiers: 4,
    };
    await f.input.send("a", f.message("a", 4, key), size);
    await f.input.send("a", f.message("a", 5, key), size);
    await f.input.send("a", f.message("a", 6, { ...key, event: "up" }), size);
    expect(f.instances[0]!.send.mock.calls.map((c) => c[1])).toEqual([
      {
        type: "pointerDown",
        data: { point: { x: 25, y: 40 }, button: "back", modifiers: ["Meta"] },
      },
      { type: "pointerMove", data: { point: { x: 25, y: 40 }, modifiers: [] } },
      { type: "pointerUp", data: { point: { x: 25, y: 40 }, button: "back" } },
      {
        type: "keyDown",
        data: { key: "K", modifiers: ["Meta"], repeat: false },
      },
      {
        type: "keyDown",
        data: { key: "K", modifiers: ["Meta"], repeat: true },
      },
      { type: "keyUp", data: { key: "K" } },
    ]);
    f.input.detach("a");
    await vi.waitFor(() =>
      expect(f.instances[0]!.close).toHaveBeenCalledOnce(),
    );
    expect(f.instances[1]!.close).not.toHaveBeenCalled();
    await f.input.close();
  });
  it("rejects delayed epochs and duplicate sequences before posting", async () => {
    const f = fixture();
    await f.input.attach("a", target);
    const old = f.message("a", 1, {});
    await f.input.send("a", old, size);
    await expect(f.input.send("a", old, size)).rejects.toThrow(/stale/);
    f.input.reset();
    await f.input.attach("a", target);
    await expect(f.input.send("a", old, size)).rejects.toThrow(/stale/);
    expect(f.instances[1]!.send).not.toHaveBeenCalled();
    await f.input.close();
  });
  it("ignores stale cancellation and releases only the matching participant", async () => {
    const f = fixture();
    await f.input.attach("a", target);
    await f.input.attach("b", target);
    const old = f.epoch("a");
    expect(f.input.cancel("a", "stale")).toBe(false);
    expect(f.input.cancel("a", old)).toBe(true);
    await f.input.attach("a", target);
    expect(f.input.cancel("a", old)).toBe(false);
    await f.input.send("a", f.message("a", 1, {}), size);
    await f.input.send("b", f.message("b", 1, {}), size);
    await vi.waitFor(() =>
      expect(f.instances[0]!.close).toHaveBeenCalledOnce(),
    );
    expect(f.instances[1]!.close).not.toHaveBeenCalled();
    await f.input.close();
  });
  it("keeps delivered input alive when presentation broadcasts fail", async () => {
    const cursor = vi.fn(() => {
      throw new Error("transport closed");
    });
    const f = fixture({
      cursor,
      assets: () => {
        throw new Error("transport closed");
      },
    });
    await f.input.attach("a", target);
    await f.input.send("a", f.message("a", 1, {}), size);
    await f.input.send("a", f.message("a", 2, { event: "up" }), size);
    expect(cursor).toHaveBeenCalledWith(f.epoch("a"), 0.25, 0.4, true);
    expect(f.instances[0]!.send).toHaveBeenCalledTimes(2);
    expect(f.instances[0]!.close).not.toHaveBeenCalled();
    await f.input.close();
    expect(f.instances[0]!.close).toHaveBeenCalledOnce();
  });
  it("does not open global input for monitors", async () => {
    const f = fixture();
    await f.input.attach("a", { kind: "monitor", id: "1", name: "Display" });
    expect(f.open).not.toHaveBeenCalled();
    expect(f.state).toHaveBeenCalledWith(
      "a",
      null,
      expect.stringContaining("view-only"),
    );
  });
  it("splits long unicode pastes once without splitting code points", async () => {
    const f = fixture();
    await f.input.attach("a", target);
    const text = "🎹".repeat(5000);
    await f.input.send(
      "a",
      f.message("a", 1, { type: "clipboard", operation: "paste-text", text }),
      size,
    );
    const chunks = f.instances[0]!.send.mock.calls.map(
      (c) => c[1].data.data as string,
    );
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((c) => Buffer.byteLength(c) <= 8192)).toBe(true);
    await f.input.close();
  });
  it("discards queued actions after an uncertain failure", async () => {
    const f = fixture();
    await f.input.attach("a", target);
    f.instances[0]!.send.mockRejectedValueOnce(new Error("unknown"));
    const results = await Promise.allSettled([
      f.input.send("a", f.message("a", 1, {}), size),
      f.input.send("a", f.message("a", 2, {}), size),
    ]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(f.instances[0]!.send).toHaveBeenCalledOnce();
    await f.input.close();
  });
});

it("keeps a shared modifier held until both physical keys are released", async () => {
  const f = fixture();
  await f.input.attach("a", target);
  const key = {
    type: "key",
    event: "down",
    key: "Shift",
    code: "ShiftLeft",
    modifiers: 8,
  };
  await f.input.send("a", f.message("a", 1, key), size);
  await f.input.send(
    "a",
    f.message("a", 2, { ...key, code: "ShiftRight" }),
    size,
  );
  await f.input.send("a", f.message("a", 3, { ...key, event: "up" }), size);
  expect(f.instances[0]!.send).toHaveBeenCalledTimes(1);
  await f.input.send(
    "a",
    f.message("a", 4, { ...key, event: "up", code: "ShiftRight" }),
    size,
  );
  expect(f.instances[0]!.send.mock.calls.map((c) => c[1])).toEqual([
    {
      type: "keyDown",
      data: { key: "Shift", modifiers: ["Shift"], repeat: false },
    },
    { type: "keyUp", data: { key: "Shift" } },
  ]);
  await f.input.close();
});

it("resends idle peer positions on join without replaying clicks", async () => {
  const cursor = vi.fn();
  const f = fixture({ cursor });
  await f.input.attach("a", target);
  await f.input.send("a", f.message("a", 1, {}), size);
  cursor.mockClear();
  await f.input.attach("b", target);
  expect(cursor).toHaveBeenCalledWith(f.epoch("a"), 0.25, 0.4, false);
  expect(f.instances[0]!.send).toHaveBeenCalledOnce();
  await f.input.close();
});
