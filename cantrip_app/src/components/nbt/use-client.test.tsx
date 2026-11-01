// @vitest-environment jsdom
import { Blob as NodeBlob } from "node:buffer";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import type { NbtDocumentClient } from "@cantrip/nbt/document";
import { useNbtClient } from "./use-client";
const api = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@/lib/nbt/document", () => ({
  openNbtDocument: (...args: unknown[]) => api.open(...args),
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
function client(id: string) {
  const snapshot = { state: "complete", root: "node:0" };
  return {
    id,
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
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
  expect(first.close).toHaveBeenCalledTimes(1);
  await act(async () => resolve(new Blob([new Uint8Array([10, 0, 0, 0])])));
  expect(observed.at(-1)).toBe("second:second");
  await act(async () => renderer.unmount());
  expect(second.close).toHaveBeenCalledTimes(1);
});
