import { createRef } from "react";
import { act, create } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import {
  BrowserAgentCursorOverlay,
  type BrowserAgentCursorHandle,
} from "./agent-cursor-overlay";
import type { RemoteBrowserServerMessage } from "@cantrip/protocol";
vi.hoisted(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
it("renders one agent cursor, rejects older updates and clears presentation on reconnect", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:sprite");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const ref = createRef<BrowserAgentCursorHandle>();
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<BrowserAgentCursorOverlay ref={ref} />, {
      createNodeMock: () => ({ style: {}, querySelector: () => null }),
    });
  });
  const state: Extract<
    RemoteBrowserServerMessage,
    { type: "browser-agent-cursor" }
  > = {
    type: "browser-agent-cursor",
    epoch: "00000000-0000-4000-8000-000000000001",
    sequence: 1,
    position: { x: 0.25, y: 0.5 },
    click: true,
    dragging: false,
    sprite: {
      width: 256,
      height: 256,
      hotspot: { x: 128, y: 128 },
      normal: [1],
      click: [2],
    },
  };
  await act(async () => ref.current!.receive(state));
  expect(renderer.root.findAllByType("img")).toHaveLength(2);
  await act(async () =>
    ref.current!.receive({
      ...state,
      epoch: "00000000-0000-4000-8000-000000000002",
    }),
  );
  expect(renderer.root.findAllByType("img")).toHaveLength(2);
  await act(async () =>
    ref.current!.receive({
      ...state,
      epoch: "00000000-0000-4000-8000-000000000002",
      sequence: 0,
      position: null,
    }),
  );
  expect(renderer.root.findAllByType("div")[0]!.props.style.opacity).toBe(1);
  await act(async () => ref.current!.reset());
  expect(renderer.root.findAllByType("img")).toHaveLength(0);
  expect(renderer.root.findAllByType("div")[0]!.props.style.opacity).toBe(0);
  await act(async () => renderer.unmount());
  vi.restoreAllMocks();
});
