import { act, create } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRecoveryBanner } from "./workspace-recovery-banner";

function fixture() {
  return {
    loading: false,
    error: null as Error | null,
    controllerState: {
      disposed: false,
      error: null as Error | null,
      refreshError: null as Error | null,
    },
    presentation: { error: null as Error | null },
    retry: vi.fn(),
    refresh: vi.fn(),
    retryCommand: vi.fn(),
    retryLabels: vi.fn(),
  };
}
it("renders nothing when healthy and a status while loading", () => {
  const workspace = fixture();
  expect(
    renderToStaticMarkup(<WorkspaceRecoveryBanner workspace={workspace} />),
  ).toBe("");
  workspace.loading = true;
  expect(
    renderToStaticMarkup(<WorkspaceRecoveryBanner workspace={workspace} />),
  ).toContain("Loading workspace");
});

it("offers a migration retry without reconnecting or replaying workspace commands", async () => {
  const workspace = fixture();
  const migration = {
    error: new Error("Migration checkpoint failed"),
    retry: vi.fn(),
  };
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <WorkspaceRecoveryBanner workspace={workspace} migration={migration} />,
    );
  });
  await act(async () => renderer.root.findByType("button").props.onClick());
  expect(migration.retry).toHaveBeenCalledOnce();
  expect(workspace.retry).not.toHaveBeenCalled();
  expect(workspace.retryCommand).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
});
it("shows transfer progress until commit and prioritizes actionable errors", () => {
  const workspace = fixture();
  const render = (transferPending: boolean) =>
    renderToStaticMarkup(
      <WorkspaceRecoveryBanner
        workspace={workspace}
        transferPending={transferPending}
      />,
    );
  expect(render(true)).toContain("Moving views into this window");
  expect(render(false)).toBe("");
  workspace.error = new Error("Connection lost");
  expect(render(true)).toContain("Reconnect");
  expect(render(true)).not.toContain("Moving views");
});
it.each(["read", "command", "labels", "bootstrap", "disposed"] as const)(
  "routes %s recovery without replaying other actions",
  async (kind) => {
    const workspace = fixture();
    const failure = new Error("Connection lost");
    if (kind === "read") workspace.controllerState.refreshError = failure;
    if (kind === "command") workspace.controllerState.error = failure;
    if (kind === "labels") workspace.presentation.error = failure;
    if (kind === "bootstrap") workspace.error = failure;
    if (kind === "disposed") workspace.controllerState.disposed = true;
    const expected =
      kind === "read"
        ? "refresh"
        : kind === "command"
          ? "retryCommand"
          : kind === "labels"
            ? "retryLabels"
            : "retry";
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<WorkspaceRecoveryBanner workspace={workspace} />);
    });
    await act(async () => renderer.root.findByType("button").props.onClick());
    for (const action of [
      "refresh",
      "retryCommand",
      "retryLabels",
      "retry",
    ] as const) {
      expect(workspace[action]).toHaveBeenCalledTimes(
        action === expected ? 1 : 0,
      );
    }
    await act(async () => renderer.unmount());
  },
);

describe("automatic workspace reconnection", () => {
  const renderers: ReturnType<typeof create>[] = [];
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "performance",
      ],
    });
  });
  afterEach(async () => {
    for (const renderer of renderers) await act(async () => renderer.unmount());
    renderers.length = 0;
    vi.useRealTimers();
  });
  async function mount(
    workspace: ReturnType<typeof fixture> = {
      ...fixture(),
      error: new Error("The window attachment is no longer current."),
    },
  ) {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<WorkspaceRecoveryBanner workspace={workspace} />);
    });
    renderers.push(renderer);
    return { renderer, workspace };
  }
  const advance = (ms: number) =>
    act(async () => {
      vi.advanceTimersByTime(ms);
    });
  const area = (renderer: ReturnType<typeof create>) =>
    renderer.root.findByProps({ "data-workspace-reconnect": "" });

  it.each(["bootstrap", "disposed"])(
    "reconnects a %s failure after five seconds, once per attempt",
    async (kind) => {
      const workspace = fixture();
      if (kind === "bootstrap") workspace.error = new Error("Connection lost");
      else workspace.controllerState.disposed = true;
      await mount(workspace);
      await advance(4999);
      expect(workspace.retry).not.toHaveBeenCalled();
      await advance(1);
      expect(workspace.retry).toHaveBeenCalledOnce();
      await advance(10000);
      expect(workspace.retry).toHaveBeenCalledOnce();
    },
  );

  it("freezes progress while hovered and resumes the remaining countdown", async () => {
    const { renderer, workspace } = await mount();
    await advance(2000);
    await act(async () => area(renderer).props.onMouseEnter());
    const progress = () =>
      renderer.root.findByProps({ "data-reconnect-progress": "" }).props.style
        .width;
    expect(progress()).toBe("40%");
    await advance(12000);
    expect(workspace.retry).not.toHaveBeenCalled();
    expect(progress()).toBe("40%");
    expect(JSON.stringify(renderer.toJSON())).toContain("Paused");
    await act(async () => area(renderer).props.onMouseLeave());
    await advance(2999);
    expect(workspace.retry).not.toHaveBeenCalled();
    await advance(1);
    expect(workspace.retry).toHaveBeenCalledOnce();
  });

  it("keeps keyboard focus paused after the pointer leaves", async () => {
    const { renderer, workspace } = await mount();
    await advance(1000);
    await act(async () => {
      area(renderer).props.onMouseEnter();
      area(renderer).props.onFocusCapture();
      area(renderer).props.onMouseLeave();
    });
    await advance(10000);
    expect(workspace.retry).not.toHaveBeenCalled();
    await act(async () =>
      area(renderer).props.onBlurCapture({
        currentTarget: { contains: () => false },
        relatedTarget: null,
      }),
    );
    await advance(4000);
    expect(workspace.retry).toHaveBeenCalledOnce();
  });

  it("reconnects immediately on click without a later duplicate", async () => {
    const { renderer, workspace } = await mount();
    await advance(2000);
    await act(async () => renderer.root.findByType("button").props.onClick());
    expect(workspace.retry).toHaveBeenCalledOnce();
    await advance(10000);
    expect(workspace.retry).toHaveBeenCalledOnce();
  });

  it("cancels a resolved issue and starts a fresh countdown for the next failure", async () => {
    const { renderer, workspace } = await mount();
    await advance(4000);
    await act(async () =>
      renderer.update(<WorkspaceRecoveryBanner workspace={fixture()} />),
    );
    await advance(2000);
    expect(workspace.retry).not.toHaveBeenCalled();
    await act(async () =>
      renderer.update(<WorkspaceRecoveryBanner workspace={workspace} />),
    );
    await advance(5000);
    expect(workspace.retry).toHaveBeenCalledOnce();
  });

  it("replaces the countdown when its connection changes", async () => {
    const { renderer, workspace } = await mount();
    await advance(4000);
    const next = { ...workspace, retry: vi.fn() };
    await act(async () =>
      renderer.update(<WorkspaceRecoveryBanner workspace={next} />),
    );
    await advance(4999);
    expect(workspace.retry).not.toHaveBeenCalled();
    expect(next.retry).not.toHaveBeenCalled();
    await advance(1);
    expect(next.retry).toHaveBeenCalledOnce();
  });

  it("cleans up the pending retry when the banner unmounts", async () => {
    const { renderer, workspace } = await mount();
    await advance(4000);
    await act(async () => renderer.unmount());
    await advance(5000);
    expect(workspace.retry).not.toHaveBeenCalled();
  });

  it.each(["read", "command", "labels", "migration"])(
    "does not automatically replay a %s recovery action",
    async (kind) => {
      const workspace = fixture();
      const error = new Error("Failed");
      if (kind === "read") workspace.controllerState.refreshError = error;
      if (kind === "command") workspace.controllerState.error = error;
      if (kind === "labels") workspace.presentation.error = error;
      const migration = {
        error: kind === "migration" ? error : null,
        retry: vi.fn(),
      };
      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(
          <WorkspaceRecoveryBanner
            workspace={workspace}
            migration={migration}
          />,
        );
      });
      renderers.push(renderer);
      await advance(10000);
      for (const action of [
        "retry",
        "refresh",
        "retryCommand",
        "retryLabels",
      ] as const)
        expect(workspace[action]).not.toHaveBeenCalled();
      expect(migration.retry).not.toHaveBeenCalled();
    },
  );
});
