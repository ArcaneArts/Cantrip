import { createRef } from "react";
import { act, create } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import {
  RemoteCursorOverlay,
  type CursorOverlayHandle,
} from "./cursor-overlay";

vi.hoisted(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
it("moves immediately, ignores own echoes, preserves peers and releases image URLs", async () => {
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  let serial = 0;
  const allocate = vi
    .spyOn(URL, "createObjectURL")
    .mockImplementation(() => `blob:${++serial}`);
  const sprite = {
    width: 256 as const,
    height: 256 as const,
    hotspot: { x: 128 as const, y: 128 as const },
    motion: {
      minimumDistance: 1,
      pixelsPerMs: 4,
      minDurationMs: 60,
      maxDurationMs: 90,
      easing: [1 / 3, 1, 2 / 3, 1] as [number, number, number, number],
    },
    normal: [1],
    click: [2],
  };
  const assets = [
    { id: "own", sprite },
    { id: "peer", sprite },
  ];
  const ref = createRef<CursorOverlayHandle>();
  const nodes: Array<{
    style: Record<string, string>;
    querySelector: () => { animate: ReturnType<typeof vi.fn> };
  }> = [];
  const glow = vi.fn();
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <RemoteCursorOverlay
        ref={ref}
        assets={[]}
        ownId={null}
        width={800}
        height={600}
      />,
      {
        createNodeMock(element) {
          if (
            (element.props as { className?: string }).className !== "absolute"
          )
            return null;
          const node = { style: {}, querySelector: () => ({ animate: glow }) };
          nodes.push(node);
          return node;
        },
      },
    );
  });
  ref.current!.remote("peer", 0.6, 0.5, false);
  await act(async () =>
    renderer.update(
      <RemoteCursorOverlay
        ref={ref}
        assets={assets}
        ownId="own"
        width={800}
        height={600}
      />,
    ),
  );
  expect(nodes.at(-1)!.style.left).toBe("60%");
  ref.current!.move(0.2, 0.3, true);
  expect(nodes.at(-2)!.style.left).toBe("20%");
  expect(glow).toHaveBeenCalledOnce();
  ref.current!.remote("own", 0.9, 0.9, true);
  expect(nodes.at(-2)!.style.left).toBe("20%");
  ref.current!.remote("peer", 0.7, 0.6, false);
  expect(nodes.at(-1)!.style.left).toBe("70%");
  await act(async () =>
    renderer.update(
      <RemoteCursorOverlay
        ref={ref}
        assets={[...assets]}
        ownId="own"
        width={800}
        height={600}
      />,
    ),
  );
  expect(nodes.at(-1)!.style.left).toBe("70%");
  expect(nodes.at(-1)!.style.visibility).toBe("visible");
  ref.current!.remote("peer", 0.8, 0.6, false, true);
  expect(nodes.at(-1)!.style.transition).toContain(
    "60ms cubic-bezier(0.3333333333333333,1,0.6666666666666666,1)",
  );
  ref.current!.remote("peer", 0.9, 0.6, true, true);
  expect(nodes.at(-1)!.style.transition).toBe("none");
  // A resized surface uses its current dimensions when calculating travel time.
  await act(async () =>
    renderer.update(
      <RemoteCursorOverlay
        ref={ref}
        assets={assets}
        ownId="own"
        width={3200}
        height={600}
      />,
    ),
  );
  ref.current!.remote("peer", 1, 0.6, false, true);
  expect(nodes.at(-1)!.style.transition).toMatch(/left 79\.999.*ms/);
  ref.current!.remote("peer", 0.5, 0.6, false, false);
  expect(nodes.at(-1)!.style.transition).toBe("none");
  await act(async () => renderer.unmount());
  expect(revoke).toHaveBeenCalledTimes(allocate.mock.calls.length);
  revoke.mockRestore();
  allocate.mockRestore();
});
