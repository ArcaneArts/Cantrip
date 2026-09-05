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
    mode: "manual",
    sources: [],
    sourceId: null,
    agentSource: null,
    phase: "connected",
    busy: false,
    stopping: false,
    lease: {
      leaseId: "00000000-0000-4000-8000-000000000001",
      contentDomain: "chat" as const,
      workerId: "worker",
      chatId: "chat",
      generation: 1,
    },
    capabilities: null,
    targets: [target],
    targetsTruncated: false,
    targetPage: { after: null, nextCursor: null, previous: [] },
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
    setMode: vi.fn(),
    selectSource: vi.fn(),
    refreshSources: vi.fn(),
    refreshObservation: vi.fn(),
    stop: vi.fn(),
    refreshTargets: vi.fn(),
    firstTargets: vi.fn(),
    nextTargets: vi.fn(),
    previousTargets: vi.fn(),
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
  it("shows the attached target outside the page and offers bounded navigation without switching it", async () => {
    const { props, controller, state } = fixture({
      targets: [],
      targetsTruncated: true,
      targetPage: { after: "page-0", nextCursor: "page-1", previous: [null] },
    });
    const markup = renderToStaticMarkup(<ComputerUsePreviewPanel {...props} />);
    expect(markup).toContain("Attached: Fake monitor (outside this page)");
    expect(markup).toContain("More native targets are available");
    expect(markup).toContain('aria-label="Target pages"');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ComputerUsePreviewPanel {...props} />);
    });
    const select = renderer.root.findByProps({
      "aria-label": "Monitor or window",
    });
    expect(select.props.value).toBe(`${state.session!.target!.id}:1`);
    for (const [label, method] of [
      ["First page", "firstTargets"],
      ["Previous page", "previousTargets"],
      ["Next page", "nextTargets"],
    ] as const) {
      const button = renderer.root
        .findAllByType("button")
        .find((button) => button.props.children === label)!;
      expect(button.props.disabled).toBe(false);
      await act(async () => button.props.onClick());
      expect(controller[method]).toHaveBeenCalledOnce();
    }
    expect(controller.selectTarget).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });

  it.each(["target-not-found", "stale-target"])(
    "offers explicit reselection for %s",
    (code) => {
      const { props } = fixture({
        error: { code, message: "Native target closed." },
      });
      const markup = renderToStaticMarkup(
        <ComputerUsePreviewPanel {...props} />,
      );
      expect(markup).toContain(
        "Refresh targets and select the current window or monitor",
      );
      expect(markup).toContain("No other target was captured as a fallback");
    },
  );
  it("discloses a bounded native target inventory without hiding existing targets", () => {
    const { props } = fixture({ targetsTruncated: true });
    const markup = renderToStaticMarkup(<ComputerUsePreviewPanel {...props} />);
    expect(markup).toContain("Some native targets were omitted");
    expect(markup).toContain("Fake monitor");
    const complete = fixture();
    expect(
      renderToStaticMarkup(<ComputerUsePreviewPanel {...complete.props} />),
    ).not.toContain("Some native targets were omitted");
  });
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

it("offers Follow agent with real attribution, one baked image, explicit reads and no cursor controls", async () => {
  const item = fixture({ mode: "agent" });
  const source = {
    sourceId: "00000000-0000-4000-8000-000000000002",
    rootThreadId: "root-thread",
    binding: {
      ...item.state.session!.binding,
      threadId: "child-thread",
      turnId: "actual-turn",
    },
    target: item.target,
    cursorRevision: 1,
    observationRevision: 1,
    observedAtMs: 1000,
  };
  item.state.sources = [source];
  item.state.sourceId = source.sourceId;
  item.state.agentSource = source;
  item.state.observation!.nativeImage = {
    ...item.state.observation!.metadata.image,
    width: 1280,
    height: 720,
  };
  const markup = renderToStaticMarkup(
    <ComputerUsePreviewPanel {...item.props} />,
  );
  for (const text of [
    "Manual preview",
    "Follow agent",
    "root-thread",
    "child-thread",
    "actual-turn",
    "session",
    "worker",
    "Fake monitor",
    "Last completed observation",
    "Native 1280",
    "Refresh observation",
  ])
    expect(markup).toContain(text);
  expect(markup.match(/<img /gu) ?? []).toHaveLength(1);
  expect(markup).not.toContain("Monitor or window");
  expect(markup).not.toContain("Keyboard cursor movement");
  expect(markup).not.toContain("Detach target");
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<ComputerUsePreviewPanel {...item.props} />);
  });
  const imageButton = renderer.root.findByProps({
    "aria-label": "Latest completed agent observation",
  });
  expect(imageButton.props.disabled).toBe(true);
  await act(async () => imageButton.props.onClick({}));
  expect(item.controller.move).not.toHaveBeenCalled();
  await act(async () =>
    renderer.root
      .findByProps({ "aria-label": "Agent observation source" })
      .props.onChange({ currentTarget: { value: source.sourceId } }),
  );
  expect(item.controller.selectSource).toHaveBeenCalledWith(source.sourceId);
  await act(async () =>
    renderer.root
      .findAllByType("button")
      .find((button) => button.props.children === "Refresh observation")!
      .props.onClick(),
  );
  expect(item.controller.refreshObservation).toHaveBeenCalledOnce();
  await act(async () =>
    renderer.root
      .findByProps({ "aria-label": "Preview mode" })
      .props.onChange({ currentTarget: { value: "manual" } }),
  );
  expect(item.controller.setMode).toHaveBeenCalledWith("manual");
  expect(item.controller.stop).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
});
