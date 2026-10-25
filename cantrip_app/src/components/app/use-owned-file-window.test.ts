import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { openOwnedFile } from "@/lib/open-owned-file";
import { detachWorkspaceEditors } from "./detach-workspace-editors";
import { useOwnedFileWindow } from "./use-owned-file-window";

vi.mock("@/lib/open-owned-file", () => ({ openOwnedFile: vi.fn() }));
vi.mock("./detach-workspace-editors", () => ({
  detachWorkspaceEditors: vi.fn(),
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it.each(["attach", "close", "elsewhere", "failure", "unmount"])(
  "opens an owned file window safely (%s)",
  async (scenario) => {
    vi.clearAllMocks();
    const tab = {
      id: "file-tab",
      resource: {
        kind: "entity",
        definitionId: "project.file",
        resourceId: "document",
      },
    };
    const pane = { id: "pane", tabs: [tab] };
    const layout = { windows: [{ id: "main", panes: [pane] }] };
    const props = {
      workspace: {
        controller: {
          getSnapshot: () => ({ authoritative: layout, disposed: false }),
        },
        windowId: "main",
        focusWindow: vi.fn(),
      },
      queryClient: {},
      surfaces: new Map([["file-tab", { kind: "file" }]]),
      explorers: new Map(),
      lifecycleRevision: 0,
    } as unknown as Parameters<typeof useOwnedFileWindow>[0];
    vi.mocked(openOwnedFile).mockResolvedValue({
      resource: { id: "document" },
      receipt: {
        layout,
        focusWindowId: scenario === "elsewhere" ? "other" : null,
      },
    } as Awaited<ReturnType<typeof openOwnedFile>>);
    vi.mocked(detachWorkspaceEditors).mockImplementation(async (input) => {
      if (scenario === "failure") throw new Error("destination failed");
      if (scenario === "unmount") {
        await new Promise((_, reject) => {
          input.signal!.addEventListener(
            "abort",
            () => reject(input.signal!.reason),
            { once: true },
          );
        });
      }
      return "popout";
    });
    let open!: ReturnType<typeof useOwnedFileWindow>;
    function Probe() {
      open = useOwnedFileWindow(props);
      return null;
    }
    let renderer!: TestRenderer.ReactTestRenderer;
    let result!: Promise<unknown>;
    const explorer = { projectId: "project", worktreeId: "tree" } as Parameters<
      typeof open
    >[0];
    const entry = { path: "a.rs", name: "a.rs" } as Parameters<typeof open>[1];
    try {
      await act(async () => {
        renderer = TestRenderer.create(createElement(Probe));
      });
      await act(async () => {
        const first = open(explorer, entry);
        expect(open(explorer, entry)).toBe(first);
        result = first.catch((error: Error) => error.message);
      });
      expect(openOwnedFile).toHaveBeenCalledOnce();
      expect(detachWorkspaceEditors).not.toHaveBeenCalled();
      if (scenario === "elsewhere") {
        expect(await result).toBeUndefined();
      } else {
        if (scenario === "close") pane.tabs = [];
        else (props.explorers as Map<string, unknown>).set("file-tab", {});
        props.lifecycleRevision++;
        await act(async () => {
          renderer.update(createElement(Probe));
        });
        if (scenario === "close") {
          expect(await result).toBe(
            "The file tab changed before window transfer.",
          );
          expect(detachWorkspaceEditors).not.toHaveBeenCalled();
        } else {
          if (scenario === "unmount") {
            const signal = vi.mocked(detachWorkspaceEditors).mock.calls[0]![0]
              .signal!;
            expect(signal.aborted).toBe(false);
            await act(async () => renderer.unmount());
            expect(signal.aborted).toBe(true);
          }
          expect(await result).toBe(
            scenario === "failure"
              ? "destination failed"
              : scenario === "unmount"
                ? "File window context changed."
                : undefined,
          );
          expect(detachWorkspaceEditors).toHaveBeenCalledOnce();
          expect(detachWorkspaceEditors).toHaveBeenCalledWith(
            expect.objectContaining({
              tabId: "file-tab",
              paneId: "pane",
              windowId: "main",
            }),
          );
          expect(pane.tabs).toEqual([tab]);
        }
      }
    } finally {
      await act(async () => renderer?.unmount());
    }
  },
);
