import type { TerminalSummary } from "@cantrip/protocol";
import { createElement, useEffect, useRef, type ReactNode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({
  created: [] as string[],
  nextInstance: 0,
  released: [] as string[],
}));

vi.mock("./terminal-view", () => ({
  TerminalView: ({
    terminal,
    visible,
  }: {
    terminal: TerminalSummary;
    visible: boolean;
  }) => {
    const instance = useRef(lifecycle.nextInstance++).current;
    useEffect(() => {
      lifecycle.created.push(terminal.id);
      return () => {
        lifecycle.released.push(terminal.id);
      };
    }, [terminal.id]);
    return createElement("div", {
      "data-instance": instance,
      "data-mock-terminal-view": true,
      "data-terminal-id": terminal.id,
      "data-visible": visible,
    });
  },
}));
vi.mock("@/lib/client-log-relay", () => ({
  clientLogger: { info: vi.fn() },
}));
vi.mock("react-dom", async () => {
  const React = await import("react");
  return {
    createPortal: (
      child: ReactNode,
      target: { dataset?: { persistentSurfaceOwner?: string } },
      key?: string,
    ) =>
      React.createElement(
        "mock-portal",
        {
          "data-persistent-surface-owner":
            target.dataset?.persistentSurfaceOwner,
          key,
        },
        child,
      ),
  };
});

import {
  MAX_RETAINED_TERMINAL_VIEWS,
  PersistentTerminalViews,
  retainTerminalSurfaceTabs,
} from "./persistent-terminal-views";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function terminal(id: string, linkedChatId: string | null = null) {
  return {
    activeWorkerId: "worker-one",
    createdAt: "2026-08-30T00:00:00.000Z",
    directoryPath: null,
    id,
    kind: linkedChatId ? "chat-console" : "interactive",
    linkedChatId,
    position: 0,
    projectId: "project-one",
    runConfigurationId: null,
    runConfigurationRuntimeId: null,
    service: { command: "", enabled: false },
    status: "running",
    title: id,
    updatedAt: "2026-08-30T00:00:00.000Z",
    worktreeId: "worktree-one",
  } satisfies TerminalSummary;
}

function render(
  selectedTerminal: TerminalSummary | null,
  ownedTerminals: TerminalSummary[],
  active = true,
  excludedIds: ReadonlySet<string> = new Set(),
) {
  return createElement(PersistentTerminalViews, {
    active,
    commandPaletteTerminalId: null,
    onCommandPaletteOpenChange: vi.fn(),
    onLinkedConsoleExit: vi.fn(),
    onPendingInputSent: vi.fn(),
    onServicePanelOpenChange: vi.fn(),
    ownedTerminals,
    pendingInputs: [],
    selectedTerminal,
    servicePanelTerminalId: null,
    excludedIds,
  });
}

describe("Persistent terminal views", () => {
  beforeEach(() => {
    lifecycle.created.length = 0;
    lifecycle.nextInstance = 0;
    lifecycle.released.length = 0;
    vi.stubGlobal("document", {
      createElement: () => ({
        className: "",
        dataset: {} as Record<string, string>,
        parentElement: null as unknown,
        remove() {},
      }),
    });
  });

  it("preserves an emulator instance across tab switches and releases it only after ownership closes", async () => {
    const first = terminal("terminal-one");
    const second = terminal("terminal-two");
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(render(first, [first, second]));
    });
    const firstInstance = renderer.root.findByProps({
      "data-mock-terminal-view": true,
      "data-terminal-id": first.id,
    }).props["data-instance"];
    expect(lifecycle.created).toEqual([first.id]);

    await act(async () => renderer.update(render(second, [first, second])));
    expect(lifecycle.created).toEqual([first.id, second.id]);
    expect(lifecycle.released).toEqual([]);
    expect(
      renderer.root.findByProps({
        "data-mock-terminal-view": true,
        "data-terminal-id": first.id,
      }).props["data-instance"],
    ).toBe(firstInstance);
    expect(
      renderer.root.findByProps({
        "data-mock-terminal-view": true,
        "data-terminal-id": first.id,
      }).props["data-visible"],
    ).toBe(false);
    expect(
      renderer.root.findByProps({
        "data-slot": "persistent-terminal-surface",
        "data-terminal-id": first.id,
      }).props.className,
    ).toContain("min-w-0");
    expect(
      renderer.root.findByProps({
        "data-slot": "persistent-terminal-surface",
        "data-terminal-id": first.id,
      }).props.className,
    ).toContain("overflow-hidden");
    expect(
      renderer.root.findByProps({
        "data-mock-terminal-view": true,
        "data-terminal-id": second.id,
      }).props["data-visible"],
    ).toBe(true);

    await act(async () =>
      renderer.update(render(second, [first, second], false)),
    );
    expect(lifecycle.released).toEqual([]);
    expect(
      renderer.root.findByProps({
        "data-mock-terminal-view": true,
        "data-terminal-id": second.id,
      }).props["data-visible"],
    ).toBe(false);

    await act(async () => renderer.update(render(second, [second])));
    expect(lifecycle.released).toEqual([first.id]);

    await act(async () => renderer.unmount());
    expect(lifecycle.released).toEqual([first.id, second.id]);
  });

  it("releases a retained terminal owner when its pane transfers to a pop-out", async () => {
    const detached = terminal("terminal-detached");
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(render(detached, [detached]));
    });
    expect(lifecycle.created).toEqual([detached.id]);

    await act(async () =>
      renderer.update(
        render(detached, [detached], true, new Set([detached.id])),
      ),
    );

    expect(lifecycle.released).toEqual([detached.id]);
    expect(
      renderer.root.findAllByProps({ "data-mock-terminal-view": true }),
    ).toHaveLength(0);
  });

  it("keeps a bounded least-recently-selected pool", () => {
    const retained = Array.from(
      { length: MAX_RETAINED_TERMINAL_VIEWS },
      (_, index) => terminal(`terminal-${index}`),
    );
    const selected = terminal("terminal-new");
    const result = retainTerminalSurfaceTabs(
      retained,
      [...retained, selected],
      selected,
    );

    expect(result).toHaveLength(MAX_RETAINED_TERMINAL_VIEWS);
    expect(result[0]?.id).toBe("terminal-1");
    expect(result.at(-1)?.id).toBe(selected.id);
  });

  it("never retains synthetic run-configuration terminals", () => {
    const runTerminal = {
      ...terminal("run-terminal"),
      kind: "run-configuration",
    } as TerminalSummary;

    expect(retainTerminalSurfaceTabs([], [runTerminal], runTerminal)).toEqual(
      [],
    );
  });

  it("mounts every visible pane terminal once and moves its wrapper without replacing the owner", async () => {
    const center = terminal("terminal-center");
    const bottom = terminal("terminal-bottom");
    const renderVisible = (bottomArea: string) =>
      createElement(PersistentTerminalViews, {
        active: false,
        commandPaletteTerminalId: null,
        onCommandPaletteOpenChange: vi.fn(),
        onLinkedConsoleExit: vi.fn(),
        onPendingInputSent: vi.fn(),
        onServicePanelOpenChange: vi.fn(),
        ownedTerminals: [center, bottom],
        pendingInputs: [],
        selectedTerminal: null,
        servicePanelTerminalId: null,
        visiblePlacements: [
          {
            focused: true,
            gridArea: "center-body",
            paneId: "pane-center",
            terminal: center,
          },
          {
            focused: false,
            gridArea: bottomArea,
            paneId: "pane-bottom",
            terminal: bottom,
          },
        ],
      });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(renderVisible("bottom-body"));
    });
    expect(lifecycle.created).toEqual([center.id, bottom.id]);
    const bottomInstance = renderer.root.findByProps({
      "data-mock-terminal-view": true,
      "data-terminal-id": bottom.id,
    }).props["data-instance"];
    expect(
      renderer.root.findByProps({
        "data-slot": "persistent-terminal-surface",
        "data-terminal-id": bottom.id,
      }).props.style,
    ).toEqual({ gridArea: "bottom-body" });

    await act(async () => renderer.update(renderVisible("right-body")));
    expect(lifecycle.created).toEqual([center.id, bottom.id]);
    expect(
      renderer.root.findByProps({
        "data-mock-terminal-view": true,
        "data-terminal-id": bottom.id,
      }).props["data-instance"],
    ).toBe(bottomInstance);
    expect(
      renderer.root.findByProps({
        "data-slot": "persistent-terminal-surface",
        "data-terminal-id": bottom.id,
      }).props.style,
    ).toEqual({ gridArea: "right-body" });
  });

  it("parks one center owner until its host exists and does not remount it for split-only rerenders", async () => {
    const center = terminal("terminal-center-portal");
    const attached: unknown[] = [];
    const target = {
      appendChild(child: { parentElement: unknown }) {
        child.parentElement = target;
        attached.push(child);
      },
    } as unknown as Element;
    const renderPortal = (portalTarget: Element | null) =>
      createElement(PersistentTerminalViews, {
        active: false,
        commandPaletteTerminalId: null,
        onCommandPaletteOpenChange: vi.fn(),
        onLinkedConsoleExit: vi.fn(),
        onPendingInputSent: vi.fn(),
        onServicePanelOpenChange: vi.fn(),
        ownedTerminals: [center],
        pendingInputs: [],
        selectedTerminal: null,
        servicePanelTerminalId: null,
        visiblePlacements: [
          {
            focused: true,
            gridArea: "center-body",
            paneId: "pane-center",
            portalTarget,
            terminal: center,
          },
        ],
      });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(renderPortal(null));
    });
    expect(lifecycle.created).toEqual([center.id]);
    expect(attached).toHaveLength(0);

    await act(async () => renderer.update(renderPortal(target)));
    const instance = renderer.root.findByProps({
      "data-mock-terminal-view": true,
      "data-terminal-id": center.id,
    }).props["data-instance"];
    expect(
      renderer.root.findByProps({
        "data-persistent-surface-owner": center.id,
      }).props,
    ).toMatchObject({ "data-persistent-surface-owner": center.id });
    expect(attached).toHaveLength(1);
    expect(lifecycle.created).toEqual([center.id]);
    expect(lifecycle.released).toEqual([]);

    // The recursive split fraction changes outside the persistent manager;
    // its paneId-keyed host and owner props remain stable.
    await act(async () => renderer.update(renderPortal(target)));
    expect(
      renderer.root.findByProps({
        "data-mock-terminal-view": true,
        "data-terminal-id": center.id,
      }).props["data-instance"],
    ).toBe(instance);
    expect(lifecycle.created).toEqual([center.id]);
    expect(lifecycle.released).toEqual([]);
  });
});
