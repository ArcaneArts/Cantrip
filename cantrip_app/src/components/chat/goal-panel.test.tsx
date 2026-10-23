import type { ThreadGoal } from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { GoalPanel } from "./goal-panel";

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) => (
    <div data-goal-dialog-open={open}>{children}</div>
  ),
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

const goal: ThreadGoal = {
  threadId: "native-thread",
  objective: "Finish implementation",
  status: "active",
  tokenBudget: null,
  tokensUsed: 226675,
  timeUsedSeconds: 1733,
  createdAt: 1,
  updatedAt: 2,
};

describe("Goal automation pause", () => {
  it("exposes pause, resume, clear, and the full editable objective without losing a failed edit", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const onUpdate = vi.fn();
    const onClear = vi.fn();
    const onEdit = vi
      .fn()
      .mockRejectedValueOnce(new Error("Worker disconnected"))
      .mockResolvedValueOnce(undefined);
    const props = { pending: false, onUpdate, onClear, onEdit };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<GoalPanel {...props} goal={goal} />);
    });
    await act(async () =>
      renderer.root
        .findByProps({ title: "Pause goal after the current turn" })
        .props.onClick(),
    );
    expect(onUpdate).toHaveBeenCalledWith("paused");
    await act(async () =>
      renderer.update(
        <GoalPanel {...props} goal={{ ...goal, status: "paused" }} />,
      ),
    );
    await act(async () =>
      renderer.root.findByProps({ title: "Resume goal" }).props.onClick(),
    );
    expect(onUpdate).toHaveBeenCalledWith("active");
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "View and edit goal" })
        .props.onClick(),
    );
    expect(renderer.root.findByType("textarea").props.value).toBe(
      goal.objective,
    );
    const objective =
      "Revised objective\nInclude the complete acceptance criteria.";
    await act(async () =>
      renderer.root
        .findByType("textarea")
        .props.onChange({ target: { value: objective } }),
    );
    const save = () =>
      renderer.root
        .findAllByType("button")
        .find((node) => node.children.includes("Save goal"))!;
    await act(async () => save().props.onClick());
    expect(renderer.root.findByProps({ role: "alert" }).children).toContain(
      "Worker disconnected",
    );
    expect(renderer.root.findByType("textarea").props.value).toBe(objective);
    expect(
      renderer.root.findByProps({ "data-goal-dialog-open": true }),
    ).toBeDefined();
    await act(async () => save().props.onClick());
    expect(onEdit).toHaveBeenLastCalledWith(objective);
    expect(
      renderer.root.findByProps({ "data-goal-dialog-open": false }),
    ).toBeDefined();
    await act(async () =>
      renderer.root.findByProps({ title: "Clear goal" }).props.onClick(),
    );
    expect(onClear).toHaveBeenCalledOnce();
    await act(async () => renderer.unmount());
  });
  it("offers explicit recovery for an existing failed turn without claiming its saved Goal is running", () => {
    const markup = renderToStaticMarkup(
      <GoalPanel
        goal={goal}
        executionFailed
        pending={false}
        onClear={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );
    expect(markup).toContain("Failed");
    expect(markup).toContain("Resume goal");
    expect(markup).not.toContain("Running");
  });

  it("shows Resume instead of a misleading Running badge when chat automation is paused", () => {
    const markup = renderToStaticMarkup(
      <GoalPanel
        goal={goal}
        automationPaused
        pending={false}
        onClear={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );
    expect(markup).toContain("Paused");
    expect(markup).toContain("Resume goal");
    expect(markup).not.toContain("Running");
    expect(markup).not.toContain("Pause goal");
  });

  it("keeps normal active goals running and completed goals hidden", () => {
    const props = { pending: false, onClear: vi.fn(), onUpdate: vi.fn() };
    expect(
      renderToStaticMarkup(<GoalPanel {...props} goal={goal} />),
    ).toContain("Running");
    expect(
      renderToStaticMarkup(
        <GoalPanel
          {...props}
          automationPaused
          goal={{ ...goal, status: "complete" }}
        />,
      ),
    ).toBe("");
  });
});
