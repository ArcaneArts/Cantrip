// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFileChangeActivity } from "./use-file-change-activity";
import {
  publishFileChangeActivity,
  type FileChange,
} from "@/lib/file-change-activity";
import {
  saveFileChangeShimmer,
  readFileChangeShimmer,
} from "@/lib/file-change-preference";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let reducedMotion: boolean;
const animations: Array<{
  element: HTMLElement;
  cancel: ReturnType<typeof vi.fn>;
  onfinish: (() => void) | null;
  oncancel: (() => void) | null;
}> = [];
function Preview({ worktreeId = "worktree" }: { worktreeId?: string }) {
  const ref = useFileChangeActivity({
    workerId: "worker",
    projectId: "project",
    worktreeId,
  });
  return (
    <section ref={ref}>
      <span data-file-change-path="">Files</span>
      <span data-file-change-path="src">src</span>
      <span data-file-change-path="src/app.ts">app.ts</span>
    </section>
  );
}
async function mount(worktreeId = "worktree") {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Preview worktreeId={worktreeId} />
      </QueryClientProvider>,
    ),
  );
}
async function publish(changes: FileChange[], workerId = "worker") {
  await act(async () => {
    publishFileChangeActivity(client, {
      workerId,
      notification: {
        type: "worktree.filesystem.changed",
        projectId: "project",
        worktreeId: "worktree",
        sourcePath: "/repo",
        worktreePath: "/repo",
        changes,
      },
    });
    vi.advanceTimersByTime(80);
  });
}
beforeEach(async () => {
  vi.useFakeTimers();
  window.localStorage.clear();
  reducedMotion = false;
  animations.length = 0;
  vi.stubGlobal("matchMedia", () => ({ matches: reducedMotion }));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 100,
    height: 20,
    top: 10,
    bottom: 30,
    left: 0,
    right: 100,
    x: 0,
    y: 10,
    toJSON: () => ({}),
  });
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: vi.fn(function (this: HTMLElement) {
      const animation = {
        element: this,
        cancel: vi.fn(),
        onfinish: null,
        oncancel: null,
      };
      animations.push(animation);
      return animation;
    }),
  });
  client = new QueryClient();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await mount();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("file change shimmer lifecycle", () => {
  it("does not animate initial render, runs once per changed name, and clears on completion", async () => {
    expect(animations).toHaveLength(0);
    await publish([
      { path: "src/app.ts", kind: "modified" },
      { path: "src/app.ts", kind: "modified" },
    ]);
    expect(animations).toHaveLength(1);
    expect(animations[0]!.element.dataset.fileChangeKind).toBe("modified");
    expect(HTMLElement.prototype.animate).toHaveBeenCalledWith(
      expect.any(Array),
      { duration: 1200, easing: "ease-in-out", iterations: 1 },
    );
    animations[0]!.onfinish!();
    expect(container.querySelector("[data-file-change-kind]")).toBeNull();
  });
  it("routes collapsed descendants and deletions to visible parents", async () => {
    await publish([{ path: "src/hidden/new.ts", kind: "added" }]);
    expect(animations[0]!.element.dataset.fileChangePath).toBe("src");
    await publish([{ path: "src/app.ts", kind: "deleted" }]);
    expect(animations[0]!.cancel).toHaveBeenCalledOnce();
    expect(animations[1]!.element.dataset.fileChangeKind).toBe("deleted");
  });
  it("uses a visible ancestor when the file is outside the viewport", async () => {
    const file = container.querySelector<HTMLElement>(
      '[data-file-change-path="src/app.ts"]',
    )!;
    Object.defineProperty(file, "getBoundingClientRect", {
      value: () => ({
        width: 100,
        height: 20,
        top: 10000,
        bottom: 10020,
        left: 0,
        right: 100,
        x: 0,
        y: 10000,
        toJSON: () => ({}),
      }),
    });
    await publish([{ path: "src/app.ts", kind: "modified" }]);
    expect(animations[0]!.element.dataset.fileChangePath).toBe("src");
  });

  it("defaults on, persists disabling, cancels active shimmer and ignores later events", async () => {
    expect(readFileChangeShimmer()).toBe(true);
    await publish([{ path: "src/app.ts", kind: "modified" }]);
    await act(async () => saveFileChangeShimmer(false));
    expect(readFileChangeShimmer()).toBe(false);
    expect(animations[0]!.cancel).toHaveBeenCalledOnce();
    expect(container.querySelector("[data-file-change-kind]")).toBeNull();
    await publish([{ path: "src/app.ts", kind: "modified" }]);
    expect(animations).toHaveLength(1);
    await mount();
    expect(readFileChangeShimmer()).toBe(false);
    await act(async () => saveFileChangeShimmer(true));
    await publish([{ path: "src/app.ts", kind: "modified" }]);
    expect(animations).toHaveLength(2);
  });
  it("isolates workers and worktrees and honors reduced motion", async () => {
    await publish([{ path: "src/app.ts", kind: "modified" }], "another-worker");
    expect(animations).toHaveLength(0);
    reducedMotion = true;
    await publish([{ path: "src/app.ts", kind: "modified" }]);
    expect(animations).toHaveLength(0);
    reducedMotion = false;
    await mount("other-worktree");
    await publish([{ path: "src/app.ts", kind: "modified" }]);
    expect(animations).toHaveLength(0);
  });
});
