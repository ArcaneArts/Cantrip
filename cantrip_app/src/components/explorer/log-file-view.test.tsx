// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ExplorerLogTail } from "@cantrip/protocol/surface-stream";
import { LogFileView } from "./log-file-view";
const editor = vi.hoisted(() => ({
  scroll: undefined as undefined | ((bottom: boolean) => void),
  follow: false,
}));
vi.mock("@/components/editor/native-code-editor", () => ({
  NativeCodeEditor: ({
    session,
    onScrollPositionChange,
    followEnd,
    onReady,
  }: {
    session: { text: string };
    onScrollPositionChange: (bottom: boolean) => void;
    followEnd: boolean;
    onReady?(): void;
  }) => {
    useEffect(() => onReady?.(), [onReady]);
    editor.scroll = onScrollPositionChange;
    editor.follow = followEnd;
    return <pre>{session.text}</pre>;
  },
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const roots: ReturnType<typeof createRoot>[] = [];
const result = (
  content = "line\n",
  reset = true,
  offset = 0,
): ExplorerLogTail => ({
  path: "daemon.log",
  content,
  reset,
  startOffset: offset,
  size: offset + content.length,
  cursor: {
    offset: offset + content.length,
    identity: "a".repeat(64),
    anchor: "b".repeat(64),
  },
});
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.useRealTimers();
});
async function fixture(
  read = vi.fn().mockResolvedValue(result()),
  initialActive = true,
  staging = false,
) {
  const container = document.createElement("div"),
    root = createRoot(container);
  roots.push(root);
  const ready = vi.fn();
  const render = async (active = initialActive, restoring = staging) =>
    act(async () =>
      root.render(
        <LogFileView
          path="daemon.log"
          active={active}
          staging={restoring}
          readTail={read}
          onReady={ready}
        />,
      ),
    );
  await render();
  return { container, root, render, read, ready };
}
it("polls incremental output only while visible and following; scrolls detach and reattach", async () => {
  const f = await fixture();
  expect(f.read).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(editor.follow).toBe(true);
  f.read.mockResolvedValue(result("", false, 5));
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(f.read).toHaveBeenLastCalledWith(result().cursor);
  await act(async () => editor.scroll!(false));
  expect(editor.follow).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(f.read).toHaveBeenCalledTimes(2);
  await act(async () => editor.scroll!(true));
  expect(f.read).toHaveBeenCalledTimes(3);
  await f.render(false);
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(f.read).toHaveBeenCalledTimes(3);
  await f.render(true);
  expect(f.read).toHaveBeenCalledTimes(4);
  await act(async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(f.read).toHaveBeenCalledTimes(4);
  await act(async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(f.read).toHaveBeenCalledTimes(5);
});
it("ignores retired responses and serializes requests through rapid pause/resume", async () => {
  let resolve!: (r: ExplorerLogTail) => void;
  const read = vi
    .fn()
    .mockReturnValueOnce(
      new Promise<ExplorerLogTail>((done) => {
        resolve = done;
      }),
    )
    .mockResolvedValue(result("fresh\n"));
  const f = await fixture(read);
  await f.render(false);
  await f.render(true);
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => resolve(result("stale\n")));
  expect(read).toHaveBeenCalledTimes(2);
  expect(f.container.querySelector("pre")!.textContent).toBe("fresh\n");
});
it("retains output after failures and retries on demand without an error polling loop", async () => {
  const f = await fixture();
  f.read.mockRejectedValueOnce(new Error("log missing"));
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(f.container.textContent).toContain("log missing");
  expect(f.container.querySelector("pre")!.textContent).toBe("line\n");
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(f.read).toHaveBeenCalledTimes(2);
  f.read.mockResolvedValue(result("recovered\n"));
  await act(async () => f.container.querySelector("button")!.click());
  expect(f.container.querySelector("pre")!.textContent).toBe("recovered\n");
});

it("restores one inactive transfer snapshot and waits for ownership before following", async () => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });
  const f = await fixture(undefined, false, true);
  expect(f.read).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(f.ready).toHaveBeenCalledOnce();
  expect(f.container.querySelector("pre")!.textContent).toBe("line\n");
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(f.read).toHaveBeenCalledTimes(1);
  f.read.mockResolvedValue(result("next\n", false, 5));
  await act(async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await f.render(true, false);
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(f.container.querySelector("pre")!.textContent).toBe("line\nnext\n");
});
it("does not read an ordinary hidden view before activation", async () => {
  const f = await fixture(undefined, false, false);
  expect(f.read).not.toHaveBeenCalled();
  await f.render(true);
  expect(f.read).toHaveBeenCalledTimes(1);
});
