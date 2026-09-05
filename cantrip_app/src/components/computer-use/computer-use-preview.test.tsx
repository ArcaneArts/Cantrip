import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ComputerUsePreviewPanel } from "./computer-use-preview";
import type {
  ComputerUsePreviewController,
  PreviewState,
} from "./preview-controller";

function fixture(patch: Partial<PreviewState> = {}) {
  const target = {
    id: "screen",
    generation: 1,
    kind: "monitor" as const,
    title: "Fake monitor",
    application: null,
    processId: null,
    bounds: { x: -320, y: -90, width: 320, height: 180 },
    pixelWidth: 640,
    pixelHeight: 360,
    scaleFactor: 2,
    focused: null,
    minimized: null,
  };
  const session = {
    binding: {
      workerId: "worker",
      chatId: "chat",
      taskId: null,
      threadId: null,
      turnId: null,
      sessionId: "session",
    },
    target,
    cursor: {
      appearance: {
        version: 1 as const,
        style: "arrow" as const,
        size: 24,
        color: "#00ff00",
        label: null,
        trail: false,
        visible: true,
      },
      position: { x: 10, y: 10 },
      trailPoints: [],
      updatedAtMs: 1,
      revision: 1,
    },
    observationRevision: 1,
  };
  const state: PreviewState = {
    phase: "connected",
    busy: false,
    stopping: false,
    lease: {
      leaseId: "00000000-0000-4000-8000-000000000001",
      workerId: "worker",
      chatId: "chat",
      generation: 1,
    },
    capabilities: null,
    targets: [target],
    session,
    observation: {
      url: "blob:fixture",
      metadata: {
        session,
        image: {
          mediaType: "image/png",
          width: 640,
          height: 360,
          byteCount: 10,
          sha256: "a".repeat(64),
          cursorIncluded: true,
        },
      },
    },
    error: null,
    ...patch,
  };
  const controller = {
    getSnapshot: () => state,
    subscribe: () => () => {},
    connect: vi.fn(),
    stop: vi.fn(),
    refreshTargets: vi.fn(),
    selectTarget: vi.fn(),
    snapshot: vi.fn(),
    detach: vi.fn(),
    configure: vi.fn(),
    move: vi.fn(),
  };
  return {
    controller,
    state,
    target,
    props: {
      controller: controller as unknown as ComputerUsePreviewController,
      onReviewApproval: vi.fn(),
    },
  };
}

describe("ComputerUsePreviewPanel", () => {
  it("has a responsive shared layout and marks snapshots as non-live logical input", () => {
    const { props } = fixture();
    const markup = renderToStaticMarkup(<ComputerUsePreviewPanel {...props} />);
    expect(markup).toContain("lg:grid-cols");
    expect(markup).toContain("flex-wrap");
    expect(markup).toContain("No system mouse or keyboard input");
    expect(markup).toContain("already rendered in the image");
    expect(markup.match(/<img /gu) ?? []).toHaveLength(1);
    expect(markup).toContain(
      "Stop ends computer use for all preview observers",
    );
  });
  it("keeps Stop enabled while an operation is busy", async () => {
    const { props, controller } = fixture({ busy: true });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ComputerUsePreviewPanel {...props} />);
    });
    const buttons = renderer.root.findAllByType("button");
    const stop = buttons.find((button) =>
      button.props.children?.some?.(
        (child: unknown) => child === "Stop computer use",
      ),
    )!;
    expect(stop.props.disabled).toBe(false);
    await act(async () => stop.props.onClick());
    expect(controller.stop).toHaveBeenCalledOnce();
    await act(async () => renderer.unmount());
  });
  it("maps click coordinates from the actual image, not a letterboxed container or screen origin", async () => {
    const { props, controller } = fixture();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ComputerUsePreviewPanel {...props} />);
    });
    const button = renderer.root.findByProps({
      "aria-label": "Move logical agent cursor on snapshot",
    });
    await act(async () =>
      button.props.onClick({
        detail: 1,
        clientX: 180,
        clientY: 85,
        currentTarget: {
          querySelector: () => ({
            getBoundingClientRect: () => ({
              left: 100,
              top: 40,
              width: 160,
              height: 90,
            }),
          }),
        },
      }),
    );
    expect(controller.move).toHaveBeenCalledWith({ x: 160, y: 90 });
    await act(async () => renderer.unmount());
  });
  it("dismisses to the existing approval UI only on user request", async () => {
    const { props, controller } = fixture({
      error: { code: "approval-required", message: "Approval required" },
    });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ComputerUsePreviewPanel {...props} />);
    });
    expect(props.onReviewApproval).not.toHaveBeenCalled();
    const review = renderer.root
      .findAllByType("button")
      .find((button) => button.props.children === "Review approval in chat")!;
    await act(async () => review.props.onClick());
    expect(props.onReviewApproval).toHaveBeenCalledOnce();
    expect(controller.connect).not.toHaveBeenCalled();
    expect(controller.snapshot).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });
  it("is inert before the user connects on any client platform", () => {
    const { props, controller } = fixture({
      phase: "idle",
      lease: null,
      session: null,
      observation: null,
      targets: [],
    });
    const markup = renderToStaticMarkup(<ComputerUsePreviewPanel {...props} />);
    expect(markup).toContain("Connect to agent worker");
    expect(markup).not.toContain("blob:fixture");
    expect(controller.connect).not.toHaveBeenCalled();
  });
  it("selects the current target generation rather than sending a display title", async () => {
    const { props, controller, target } = fixture();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ComputerUsePreviewPanel {...props} />);
    });
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "Monitor or window" })
        .props.onChange({ currentTarget: { value: "screen:1" } }),
    );
    expect(controller.selectTarget).toHaveBeenCalledWith(target);
    await act(async () => renderer.unmount());
  });
});
