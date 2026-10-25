import { act, create } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
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
