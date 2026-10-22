import type { ChatSummary } from "@cantrip/protocol";
import { useState } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

const history = vi.hoisted(() =>
  vi.fn(() => ({ data: [], nativeTurnSettings: [] })),
);
vi.mock("@/lib/use-chat-message-history", () => ({
  useChatMessageHistory: history,
}));
vi.mock("@/components/chat/agent-trajectory", () => ({
  AgentTrajectory: () => <div data-trajectory />,
}));
vi.mock("@/components/chat/agent-inspect-content", () => ({
  AgentInspectStateContent: () => <div data-state />,
}));
vi.mock("./task-interaction-requests", () => ({
  TaskInteractionRequests: () => <div data-task-requests />,
}));
import { TaskDetailTabs } from "./task-detail-tabs";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function Overview({ visible }: { visible: boolean }) {
  const [draft, setDraft] = useState("Original plan");
  return (
    <input
      data-overview-visible={visible}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
    />
  );
}

describe("Task detail tabs", () => {
  it("opens Overview first and switches full views without dropping the saved overview/editor", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <TaskDetailTabs
          chat={{ id: "task", status: "running" } as ChatSummary}
          chatContent={<div data-chat>Actual chat slot</div>}
          overview={(visible) => <Overview visible={visible} />}
          visible
        />,
      );
    });
    const tabs = () =>
      renderer.root
        .findAllByProps({ role: "tab" })
        .filter((node) => node.type === "button");
    expect(
      tabs().map((tab) =>
        tab.children.filter((child) => typeof child === "string").join(""),
      ),
    ).toEqual(["Overview", "Trajectory", "State", "Chat"]);
    expect(tabs().map((tab) => tab.props["aria-selected"])).toEqual([
      true,
      false,
      false,
      false,
    ]);
    const overview = renderer.root.findByType("input");
    await act(async () =>
      overview.props.onChange({ target: { value: "Unsaved task edit" } }),
    );
    await act(async () => tabs()[1]!.props.onClick());
    expect(
      renderer.root.findAllByProps({ "data-trajectory": true }),
    ).toHaveLength(1);
    expect(
      renderer.root.findAllByProps({ "data-task-requests": true }),
    ).toHaveLength(1);
    expect(
      renderer.root.findByType("input").props["data-overview-visible"],
    ).toBe(false);
    await act(async () => tabs()[2]!.props.onClick());
    expect(renderer.root.findAllByProps({ "data-state": true })).toHaveLength(
      1,
    );
    await act(async () => tabs()[3]!.props.onClick());
    expect(renderer.root.findAllByProps({ "data-chat": true })).toHaveLength(1);
    await act(async () => tabs()[0]!.props.onClick());
    expect(renderer.root.findByType("input").props.value).toBe(
      "Unsaved task edit",
    );
    expect(
      renderer.root.findByType("input").props["data-overview-visible"],
    ).toBe(true);
    expect(tabs().map((tab) => tab.props["aria-selected"])).toEqual([
      true,
      false,
      false,
      false,
    ]);
    await act(async () => renderer.unmount());
  });
});
