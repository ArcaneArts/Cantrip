// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorsSettings } from "@/components/settings/editors-settings";
import {
  FILE_VIEWERS,
  resolveFileOpeningMode,
} from "@/components/files/file-viewers";
import { defaultExplorerFileMode } from "@/components/explorer/explorer-file-language";
import { ExplorerImageViewport } from "@/components/explorer/explorer-image-viewport";
import { desktopExplorerWindowInitialMode } from "./desktop-explorer-window-protocol";
import { useMediaLoopDefault } from "./use-media-loop-default";
import {
  readEditorBoolean,
  readEditorOpeningMode,
  saveEditorBoolean,
  saveEditorOpeningMode,
} from "./editor-preferences";

let node: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("preserves all registered defaults and ignores corrupt or unsupported stored modes", () => {
  for (const viewer of FILE_VIEWERS) {
    expect(
      readEditorOpeningMode(
        viewer.id,
        viewer.defaultMode,
        viewer.openingModes ?? [],
      ),
    ).toBe(viewer.defaultMode);
  }
  localStorage.setItem("cantrip:editors:v1:mode:markdown", "visual");
  localStorage.setItem("cantrip:editors:v1:mode:json", "invalid");
  localStorage.setItem("cantrip:editors:v1:mode:image", "edit");
  expect(defaultExplorerFileMode("README.md")).toBe("preview");
  expect(defaultExplorerFileMode("a.json")).toBe("edit");
  expect(defaultExplorerFileMode("a.png")).toBe("preview");
  localStorage.setItem("cantrip:editors:v1:image-fit", "invalid");
  expect(readEditorBoolean("image-fit")).toBe(true);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw Error("Unavailable");
  });
  expect(defaultExplorerFileMode("a.json")).toBe("edit");
  expect(readEditorBoolean("nbt-view-mode")).toBe(true);
});

it.each([
  ["markdown", "README.md", "edit"],
  ["license", "LICENSE.md", "edit"],
  ["log", "daemon.log.1", "edit"],
  ["text", "source.rs", "preview"],
  ["json", "config.json", "visual"],
  ["toml", "Cargo.toml", "visual"],
  ["yaml", "compose.yml", "visual"],
  ["csv", "rows.csv", "visual"],
  ["env", ".env", "visual"],
  ["properties", "gradle.properties", "visual"],
] as const)(
  "opens %s in the selected mode across normal and desktop paths",
  (id, path, mode) => {
    saveEditorOpeningMode(id, mode);
    expect(defaultExplorerFileMode(path)).toBe(mode);
    expect(desktopExplorerWindowInitialMode(path)).toBe(mode);
  },
);

it("respects explicit Open As, and Automatic returns to the selected default", () => {
  saveEditorOpeningMode("markdown", "edit");
  saveEditorOpeningMode("json", "preview");
  saveEditorOpeningMode("text", "preview");
  expect(resolveFileOpeningMode("README.md")).toBe("edit");
  expect(resolveFileOpeningMode("README.md", "markdown")).toBe("preview");
  expect(resolveFileOpeningMode("README.md", "text")).toBe("edit");
  expect(resolveFileOpeningMode("odd.xyz", "json")).toBe("visual");
  expect(resolveFileOpeningMode("config.json", null)).toBe("preview");
});

it("edits defaults inline, persists them on remount, and follows another window's changes", async () => {
  await act(async () => root.render(<EditorsSettings />));
  const markdown = node.querySelector<HTMLInputElement>(
    '[aria-label="Open Markdown files in view mode"]',
  )!;
  const json = node.querySelector<HTMLSelectElement>(
    '[aria-label="JSON default mode"]',
  )!;
  expect(markdown.checked).toBe(true);
  expect(json.value).toBe("edit");
  await act(async () => {
    markdown.click();
    json.value = "visual";
    json.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(defaultExplorerFileMode("README.md")).toBe("edit");
  expect(defaultExplorerFileMode("settings.json")).toBe("visual");
  await act(async () => root.render(null));
  await act(async () => root.render(<EditorsSettings />));
  expect(
    node.querySelector<HTMLInputElement>(
      '[aria-label="Open Markdown files in view mode"]',
    )!.checked,
  ).toBe(false);
  expect(
    node.querySelector<HTMLSelectElement>('[aria-label="JSON default mode"]')!
      .value,
  ).toBe("visual");
  await act(async () => {
    localStorage.setItem("cantrip:editors:v1:mode:json", "preview");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "cantrip:editors:v1:mode:json" }),
    );
  });
  expect(
    node.querySelector<HTMLSelectElement>('[aria-label="JSON default mode"]')!
      .value,
  ).toBe("preview");
  await act(async () => {
    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
  });
  expect(
    node.querySelector<HTMLSelectElement>('[aria-label="JSON default mode"]')!
      .value,
  ).toBe("edit");
});

it("reports a failed save and keeps the last saved mode", async () => {
  await act(async () => root.render(<EditorsSettings />));
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw Error("Full");
  });
  await act(async () =>
    node
      .querySelector<HTMLInputElement>(
        '[aria-label="Open Markdown files in view mode"]',
      )!
      .click(),
  );
  expect(node.querySelector('[role="alert"]')!.textContent).toContain(
    "Could not save",
  );
  expect(
    node.querySelector<HTMLInputElement>(
      '[aria-label="Open Markdown files in view mode"]',
    )!.checked,
  ).toBe(true);
});

it("uses the image sizing default without changing an existing viewport", async () => {
  const image = (source: string) => (
    <ExplorerImageViewport alt="photo" source={source} />
  );
  await act(async () => root.render(image("one")));
  expect(node.querySelector("img")!.className).toContain("max-w-full");
  await act(async () => saveEditorBoolean("image-fit", false));
  await act(async () => root.render(image("one")));
  expect(node.querySelector("img")!.className).toContain("max-w-full");
  await act(async () => root.render(image("two")));
  expect(node.querySelector("img")!.className).toContain("max-w-none");
});

it("keeps media looping off by default and uses new defaults for the next source", async () => {
  function Media({ source }: { source: string }) {
    return (
      <>
        <audio loop={useMediaLoopDefault("audio", source)} />
        <video loop={useMediaLoopDefault("video", source)} />
      </>
    );
  }
  await act(async () => root.render(<Media source="one" />));
  expect(node.querySelector("audio")!.loop).toBe(false);
  expect(node.querySelector("video")!.loop).toBe(false);
  await act(async () => {
    saveEditorBoolean("audio-loop", true);
    saveEditorBoolean("video-loop", true);
    root.render(<Media source="one" />);
  });
  expect(node.querySelector("audio")!.loop).toBe(false);
  await act(async () => root.render(<Media source="two" />));
  expect(node.querySelector("audio")!.loop).toBe(true);
  expect(node.querySelector("video")!.loop).toBe(true);
  expect(renderToStaticMarkup(<Media source="new" />)).toContain('loop=""');
});
