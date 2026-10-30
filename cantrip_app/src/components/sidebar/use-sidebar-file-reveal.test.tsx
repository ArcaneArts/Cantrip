// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const session = vi.hoisted(() => ({ current: true }));
vi.mock("@/lib/client-session", () => ({
  getClientSessionIdentitySnapshot: () => ({ userId: "owner" }),
  clientSessionIdentityMatches: () => session.current,
}));
import { useSidebarFileReveal } from "./use-sidebar-file-reveal";
import { sidebarFileRevealEvent } from "@/lib/sidebar-file-reveal";
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
it("reveals only an explicit same-project request and fences pending locations by session and view", async () => {
  const reveal = vi.fn();
  let selected: ReturnType<typeof useSidebarFileReveal>;
  function Harness({ view = "file-tab" }: { view?: string }) {
    selected = useSidebarFileReveal("project", view, reveal);
    return null;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<Harness />));
  expect(reveal).not.toHaveBeenCalled();
  const target = {
    projectId: "project",
    worktreeId: "other-tree",
    path: "src/deep/file.ts",
  };
  await act(async () =>
    window.dispatchEvent(
      new CustomEvent(sidebarFileRevealEvent, {
        detail: { ...target, projectId: "foreign" },
      }),
    ),
  );
  expect(reveal).not.toHaveBeenCalled();
  await act(async () =>
    window.dispatchEvent(
      new CustomEvent(sidebarFileRevealEvent, { detail: target }),
    ),
  );
  expect(reveal).toHaveBeenCalledTimes(1);
  expect(selected!).toEqual(target);
  await act(async () => root.render(<Harness view="another-tab" />));
  expect(selected!).toBeNull();
  expect(reveal).toHaveBeenCalledTimes(1);
  session.current = false;
  await act(async () => root.render(<Harness />));
  expect(selected!).toBeNull();
  await act(async () => root.unmount());
});
