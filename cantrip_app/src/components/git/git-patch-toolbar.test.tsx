// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installNativeTooltipSuppression } from "@/lib/native-tooltip-suppression";
import { openExternalUrl } from "@/lib/external-url";
import { GitPatchView } from "./git-patch-view";

vi.mock("@/lib/external-url", () => ({
  openExternalUrl: vi.fn(async () => {}),
}));
const patch = [
  "@@ -38,3 +38,3 @@",
  " line38",
  "-old40",
  "+new40",
  " line41",
  "@@ -73,3 +73,3 @@",
  " line73",
  "-old75",
  "+new75",
  " line76",
].join("\n");
const labels = [
  "Previous change",
  "Next change",
  "Open file",
  "Copy path",
  "Copy patch",
];
let root: Root, container: HTMLDivElement, stop: () => void;
const open = vi.fn();
const writeText = vi.fn(async (_text: string) => {});
const scroll = vi.fn();
const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollIntoView",
);
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: scroll,
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  stop = installNativeTooltipSuppression(document);
});
afterEach(async () => {
  stop();
  await act(async () => root.unmount());
  container.remove();
  if (originalScrollIntoView)
    Object.defineProperty(
      Element.prototype,
      "scrollIntoView",
      originalScrollIntoView,
    );
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function render(remote = false, path = "notes/two-hunks.txt") {
  await act(async () => {
    root.render(
      <GitPatchView
        error={null}
        loading={false}
        oldLabel="Before"
        newLabel="After"
        onClose={() => {}}
        onOpenFile={remote ? undefined : open}
        openFileUrl={remote ? "https://example.com/source.txt" : null}
        patch={patch}
        path={path}
        subtitle="WIP"
        truncated={false}
        commentTargets={[{ line: 40, side: "RIGHT" }]}
        onCommentRange={() => {}}
      />,
    );
  });
}
function button(label: string) {
  const found = container.querySelectorAll<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  expect(found).toHaveLength(1);
  return found[0]!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}

describe("Git patch toolbar after native tooltip suppression", () => {
  it("keeps all five named controls usable after observer settlement and rerender", async () => {
    await render();
    for (const label of labels)
      expect(button(label).hasAttribute("title")).toBe(false);
    expect(container.querySelectorAll("[title]")).toHaveLength(0);
    const review = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Next review comment",
    );
    expect(review).toBeDefined();
    expect(review!.hasAttribute("title")).toBe(false);
    await click("Next change");
    expect(scroll.mock.instances[0]).toBe(
      container.querySelectorAll("[data-diff-hunk]")[1],
    );
    await click("Previous change");
    expect(scroll.mock.instances[1]).toBe(
      container.querySelectorAll("[data-diff-hunk]")[0],
    );
    await click("Open file");
    expect(open).toHaveBeenCalledTimes(1);
    await click("Copy path");
    expect(writeText).toHaveBeenLastCalledWith("notes/two-hunks.txt");
    await click("Copy patch");
    expect(writeText).toHaveBeenLastCalledWith(patch);
    await render(false, "notes/renamed-hunks.txt");
    for (const label of labels)
      expect(button(label).hasAttribute("title")).toBe(false);
    await click("Copy path");
    expect(writeText).toHaveBeenLastCalledWith("notes/renamed-hunks.txt");
  });
  it("names the GitHub open action distinctly and keeps it usable after a mode change", async () => {
    await render();
    await render(true);
    expect(
      container.querySelector('button[aria-label="Open file"]'),
    ).toBeNull();
    expect(button("Open file on GitHub").hasAttribute("title")).toBe(false);
    await click("Open file on GitHub");
    expect(openExternalUrl).toHaveBeenCalledWith(
      "https://example.com/source.txt",
    );
    expect(open).not.toHaveBeenCalled();
  });
});
