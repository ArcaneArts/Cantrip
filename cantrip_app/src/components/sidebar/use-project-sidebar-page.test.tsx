// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectSidebarPages } from "./project-sidebar-pages";
import { useProjectSidebarPage } from "./use-project-sidebar-page";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
function Harness({ project }: { project: string }) {
  const { page, setPage } = useProjectSidebarPage();
  return (
    <ProjectSidebarPages
      page={page}
      onChange={setPage}
      files={<p>{project} files</p>}
      conversations={() => <p>{project} chats</p>}
    />
  );
}
function tab(label: "Files" | "Chats") {
  return [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (button) => button.textContent === label,
  )!;
}

beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("keeps the selected tab when switching projects and remounting the sidebar", async () => {
  await act(async () => root.render(<Harness project="Project One" />));
  expect(tab("Files").getAttribute("aria-selected")).toBe("true");
  await act(async () => tab("Chats").click());

  await act(async () => root.render(<Harness project="Project Two" />));
  expect(tab("Chats").getAttribute("aria-selected")).toBe("true");
  expect(
    host.querySelector('[role="tabpanel"]:not([hidden])')?.textContent,
  ).toBe("Project Two chats");

  await act(async () =>
    root.render(<Harness key="remount" project="Project Three" />),
  );
  expect(tab("Chats").getAttribute("aria-selected")).toBe("true");

  await act(async () => tab("Files").click());
  await act(async () => root.render(<Harness project="Project One" />));
  expect(tab("Files").getAttribute("aria-selected")).toBe("true");
});

it("reflects a tab selection written by another window on this client", async () => {
  await act(async () => root.render(<Harness project="Project One" />));
  await act(async () => tab("Chats").click());
  const key = localStorage.key(0)!;
  expect(localStorage.getItem(key)).toBe("conversations");

  await act(async () => {
    localStorage.setItem(key, "files");
    window.dispatchEvent(
      new StorageEvent("storage", { key, newValue: "files" }),
    );
  });
  expect(tab("Files").getAttribute("aria-selected")).toBe("true");
});

it("keeps the tab across project switches when storage is unavailable", async () => {
  await act(async () => root.render(<Harness project="Project One" />));
  const setItem = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementationOnce(() => {
      throw new Error("Storage is unavailable");
    });
  try {
    await act(async () => tab("Chats").click());
    await act(async () => root.render(<Harness project="Project Two" />));
    expect(tab("Chats").getAttribute("aria-selected")).toBe("true");
  } finally {
    setItem.mockRestore();
    await act(async () => tab("Files").click());
  }
});
