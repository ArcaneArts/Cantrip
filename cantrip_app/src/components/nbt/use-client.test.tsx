// @vitest-environment jsdom
import { Blob as NodeBlob } from "node:buffer";
import { createElement, StrictMode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import type { NbtDocumentClient } from "@cantrip/nbt/document";
import { useNbtClient } from "./use-client";
import { clearNbtSessions } from "@/lib/nbt/session-registry";
const api = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@/lib/nbt/document", () => ({
  openNbtDocument: (...args: unknown[]) => api.open(...args),
}));
afterEach(async () => {
  await clearNbtSessions();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
it("keeps one worker through StrictMode effect cleanup and reattachment", async () => {
  vi.stubGlobal("Blob", NodeBlob);
  const value = client("strict"),
    source = async () => new Blob([new Uint8Array([10, 0, 0, 0])]);
  api.open.mockResolvedValue(value);
  function Harness() {
    useNbtClient(source, "strict", "java", "none", true);
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(StrictMode, null, createElement(Harness)),
    );
  });
  expect(api.open).toHaveBeenCalledTimes(1);
  expect(value.close).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
  await vi.waitFor(() => expect(value.close).toHaveBeenCalledTimes(1));
});
function client(id: string) {
  const snapshot = { state: "complete", root: "node:0" };
  const edits = {
    revision: 0,
    dirty: false,
    canUndo: false,
    canRedo: false,
    version: "local",
    saving: false,
    uncertain: false,
  };
  return {
    id,
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    subscribeEdits: () => () => {},
    getEditSnapshot: () => edits,
    setPaused: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  } as unknown as NbtDocumentClient & { id: string };
}
it("hides a previous document synchronously while the next source opens and pauses without reopening", async () => {
  vi.stubGlobal("Blob", NodeBlob);
  const first = client("first"),
    second = client("second"),
    one = async () => new Blob([new Uint8Array([10, 0, 0, 0])]);
  let resolve!: (blob: Blob) => void;
  const two = () => new Promise<Blob>((done) => (resolve = done)),
    observed: string[] = [];
  api.open.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  function Harness({
    source,
    scope,
    active = true,
  }: {
    source: typeof one;
    scope: string;
    active?: boolean;
  }) {
    const state = useNbtClient(source, scope, "java", "none", active);
    observed.push(
      scope + ":" + ((state.client as typeof first | null)?.id ?? "opening"),
    );
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(Harness, { source: one, scope: "first" }),
    );
  });
  expect(api.open).toHaveBeenCalledTimes(1);
  await act(async () => {
    renderer.update(
      createElement(Harness, { source: one, scope: "first", active: false }),
    );
  });
  expect(api.open).toHaveBeenCalledTimes(1);
  expect(first.setPaused).toHaveBeenLastCalledWith(true);
  await act(async () => {
    renderer.update(createElement(Harness, { source: two, scope: "second" }));
  });
  expect(observed).not.toContain("second:first");
  await vi.waitFor(() => expect(first.close).toHaveBeenCalledTimes(1));
  await act(async () => resolve(new Blob([new Uint8Array([10, 0, 0, 0])])));
  expect(observed.at(-1)).toBe("second:second");
  await act(async () => renderer.unmount());
  await vi.waitFor(() => expect(second.close).toHaveBeenCalledTimes(1));
});
