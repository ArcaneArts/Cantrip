// @vitest-environment jsdom
import { useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ProjectOverviewWorkspace } from "./project-overview-workspace";

vi.mock("@/components/projects/project-overview", () => ({
  ProjectOverview: ({ onOpenSurface }: { onOpenSurface(id: string): void }) => (
    <button onClick={() => onOpenSurface("terminal:1")}>Open terminal</button>
  ),
}));

let node: HTMLDivElement;
let root: Root;
const close = vi.fn();
const select = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  vi.unstubAllGlobals();
});

async function openOverview() {
  function Workspace() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Project Overview</button>
        <div data-background>Selected file and workspace</div>
        {open ? (
          <ProjectOverviewWorkspace
            bindings={{
              selectedProject: { id: "project" },
              repositoryStats: {},
              projectTokenUsage: {},
              workers: {},
              worktrees: {},
              projectSurfaces: [],
              creatingSurfaceKinds: new Set(),
              setShowProjectOverview: (value: boolean) => {
                close(value);
                setOpen(value);
              },
              selectTopTab: select,
            }}
          />
        ) : null}
      </>
    );
  }
  await act(async () => root.render(<Workspace />));
  const trigger = node.querySelector("button")!;
  trigger.focus();
  await act(async () => trigger.click());
  return trigger;
}

it("opens as a modal above the retained workspace and closes without changing selection", async () => {
  const trigger = await openOverview();
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(dialog.textContent).toContain("Overview");
  expect(document.querySelector("[data-background]")?.textContent).toContain(
    "Selected file",
  );
  expect(document.body.textContent).not.toContain("Back to Project");
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>('[aria-label="Close Overview"]')!
      .click(),
  );
  expect(close).toHaveBeenCalledExactlyOnceWith(false);
  expect(select).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
});

it("supports Escape dismissal and returns focus to the opener", async () => {
  const trigger = await openOverview();
  await act(async () =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(close).toHaveBeenCalledExactlyOnceWith(false);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
});

it("closes the dialog when opening an existing surface", async () => {
  await openOverview();
  const open = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
  ].find((button) => button.textContent === "Open terminal")!;
  await act(async () => open.click());
  expect(close).toHaveBeenCalledExactlyOnceWith(false);
  expect(select).toHaveBeenCalledExactlyOnceWith("terminal:1");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
