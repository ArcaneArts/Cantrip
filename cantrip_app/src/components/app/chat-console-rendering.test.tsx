import { useEffect, useState } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { updateChatConsoleOpenChats } from "@/components/chat/chat-console-state";
import { PersistentSurfaceLayer } from "./persistent-surface-layer";

const lifecycle = vi.hoisted(() => ({ mounts: vi.fn(), unmounts: vi.fn() }));
vi.mock("@/components/app/application-shell-surfaces", async () => ({
  PersistentTerminalViews: (
    await import("@/components/terminal/persistent-terminal-views")
  ).PersistentTerminalViews,
  PersistentCodeViews: () => null,
  PersistentExplorerViews: () => null,
}));
vi.mock("@/components/terminal/linked-console-controls", () => ({
  LinkedConsoleControls: () => null,
}));
vi.mock("@/components/terminal/terminal-view", () => ({
  TerminalView: ({
    terminal,
    visible,
  }: {
    terminal: { id: string };
    visible: boolean;
  }) => {
    useEffect(() => {
      lifecycle.mounts(terminal.id);
      return () => lifecycle.unmounts(terminal.id);
    }, [terminal.id]);
    return (
      <pre data-cli={terminal.id} hidden={!visible}>
        Attached CLI
      </pre>
    );
  },
}));
vi.mock("@/lib/client-log-relay", () => ({ clientLogger: { info: vi.fn() } }));

it("renders linked terminal owners when toggled in chat panes, including an unfocused pane", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const terminals = ["one", "two"].map((id) => ({
    id: `cli-${id}`,
    linkedChatId: id,
    kind: "chat-console",
  }));
  const panes = ["one", "two"].map((id) => ({
    activeSurface: { kind: "chat", entity: { id } },
    focused: id === "one",
    gridArea: `${id}-body`,
    pane: { id },
    portalTarget: {},
  }));
  function Harness() {
    const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
    return (
      <>
        {terminals.map(({ linkedChatId: id }) => (
          <button
            key={id}
            onClick={() =>
              setOpen((current) =>
                updateChatConsoleOpenChats(current, id, !current.has(id)),
              )
            }
          >
            {id}
          </button>
        ))}
        <PersistentSurfaceLayer
          bindings={{
            appMode: "ide",
            openExplorers: [],
            pendingTerminalInputs: [],
            selectedProjectId: "project",
            chatConsoleOpenChats: open,
            dockPanePresentations: panes,
            terminals: { data: terminals },
            ownedTerminals: terminals,
          }}
        />
      </>
    );
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Harness />);
  });
  const owners = () =>
    renderer.root.findAll(
      (node) => node.props["data-slot"] === "persistent-terminal-surface",
    );
  const visible = () =>
    owners().filter((node) => node.props["data-active"] === "true");
  const toggle = async (index: number) =>
    act(async () =>
      renderer.root.findAllByType("button")[index]!.props.onClick(),
    );
  try {
    expect(visible()).toHaveLength(0);
    await toggle(0);
    expect(visible().map((node) => node.props["data-terminal-id"])).toEqual([
      "cli-one",
    ]);
    expect(visible()[0]?.props["data-project-pane-id"]).toBe("one");
    expect(
      renderer.root.findByProps({ "data-cli": "cli-one" }).props.hidden,
    ).toBe(false);
    await toggle(1);
    expect(visible().map((node) => node.props["data-terminal-id"])).toEqual([
      "cli-one",
      "cli-two",
    ]);
    await toggle(0);
    expect(visible().map((node) => node.props["data-terminal-id"])).toEqual([
      "cli-two",
    ]);
    expect(
      renderer.root.findByProps({ "data-cli": "cli-one" }).props.hidden,
    ).toBe(true);
    await toggle(0);
    expect(lifecycle.mounts).toHaveBeenCalledTimes(2);
    expect(lifecycle.unmounts).not.toHaveBeenCalled();
  } finally {
    await act(async () => renderer.unmount());
  }
});
