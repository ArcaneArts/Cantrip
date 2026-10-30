// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { ProjectSidebarPages } from "./project-sidebar-pages";
import type { ProjectSidebarPage } from "./use-project-sidebar-page";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
});
it("switches by keyboard while preserving edits, mounted panels, and file scroll", async () => {
  function Harness() {
    const [page, setPage] = useState<ProjectSidebarPage>("files");
    return (
      <ProjectSidebarPages
        page={page}
        onChange={setPage}
        files={<input aria-label="File name" defaultValue="draft.ts" />}
        conversations={<button>Agent one</button>}
      />
    );
  }
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
  const tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  const files = host.querySelector<HTMLElement>('[role="tabpanel"]')!;
  const input = host.querySelector("input")!;
  input.value = "unsaved.ts";
  files.scrollTop = 140;
  await act(async () =>
    files.dispatchEvent(new Event("scroll", { bubbles: true })),
  );
  tabs[0]!.focus();
  await act(async () =>
    tabs[0]!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    ),
  );
  expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(tabs[1]);
  expect(files.hidden).toBe(true);
  expect(host.querySelector("input")).toBe(input);
  files.scrollTop = 0;
  await act(async () =>
    tabs[1]!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    ),
  );
  expect(document.activeElement).toBe(tabs[0]);
  expect(files.hidden).toBe(false);
  expect(input.value).toBe("unsaved.ts");
  expect(files.scrollTop).toBe(140);
});

it("restores file scroll after asynchronous directory content becomes available", async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const onChange = () => {};
  await act(async () =>
    root.render(
      <ProjectSidebarPages
        page="files"
        onChange={onChange}
        files={<p>Loaded files</p>}
        conversations={null}
      />,
    ),
  );
  const panel = host.querySelector<HTMLElement>('[role="tabpanel"]')!;
  let offset = 200;
  let maximum = 300;
  Object.defineProperty(panel, "scrollTop", {
    get: () => offset,
    set: (value) => {
      offset = Math.min(maximum, value);
    },
  });
  await act(async () =>
    panel.dispatchEvent(new Event("scroll", { bubbles: true })),
  );
  await act(async () =>
    root.render(
      <ProjectSidebarPages
        page="conversations"
        onChange={onChange}
        files={null}
        conversations={null}
      />,
    ),
  );
  maximum = 0;
  offset = 0;
  await act(async () =>
    root.render(
      <ProjectSidebarPages
        page="files"
        onChange={onChange}
        files={<p>Loading</p>}
        conversations={null}
      />,
    ),
  );
  await act(async () =>
    panel.dispatchEvent(new Event("scroll", { bubbles: true })),
  );
  maximum = 300;
  await act(async () =>
    root.render(
      <ProjectSidebarPages
        page="files"
        onChange={onChange}
        files={<div>Directory contents</div>}
        conversations={null}
      />,
    ),
  );
  expect(panel.scrollTop).toBe(200);
});
