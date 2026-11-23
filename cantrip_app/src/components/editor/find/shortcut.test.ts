// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { registerFindEditor } from "./shortcut";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
});
function editor(pane: string) {
  const wrapper = document.createElement("div");
  wrapper.dataset.projectPaneId = pane;
  const root = document.createElement("div"),
    open = vi.fn();
  wrapper.append(root);
  document.body.append(wrapper);
  root.getClientRects = () =>
    [{ width: 800, height: 600 }] as unknown as DOMRectList;
  cleanups.push(registerFindEditor(root, open));
  return { wrapper, root, open };
}
function find(
  target: Element = document.body,
  options: KeyboardEventInit = {},
) {
  const event = new KeyboardEvent("keydown", {
    key: "f",
    metaKey: true,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}
it("routes from the sidebar to the last activated visible editor", () => {
  const first = editor("center"),
    second = editor("right");
  const tree = document.createElement("div");
  tree.setAttribute("role", "tree");
  tree.setAttribute("aria-label", "Project files");
  document.body.append(tree);
  expect(find(tree)).toBe(true);
  expect(second.open).toHaveBeenCalledOnce();
  expect(first.open).not.toHaveBeenCalled();
  first.root.dispatchEvent(new Event("focusin", { bubbles: true }));
  find(tree);
  expect(first.open).toHaveBeenCalledOnce();
});
it("respects the focused pane and leaves unrelated text fields and panes alone", () => {
  const first = editor("center"),
    second = editor("right");
  const header = document.createElement("button");
  first.wrapper.append(header);
  find(header);
  expect(first.open).toHaveBeenCalledOnce();
  expect(second.open).not.toHaveBeenCalled();
  const input = document.createElement("textarea");
  document.body.append(input);
  expect(find(input)).toBe(false);
  const other = document.createElement("div");
  other.dataset.projectPaneId = "bottom";
  document.body.append(other);
  expect(find(other)).toBe(false);
});
it("skips hidden editors and does not take Ctrl+Shift+F or plain typing", () => {
  const first = editor("center"),
    second = editor("right");
  second.wrapper.setAttribute("inert", "");
  expect(find()).toBe(true);
  expect(first.open).toHaveBeenCalledOnce();
  expect(second.open).not.toHaveBeenCalled();
  expect(find(document.body, { shiftKey: true })).toBe(false);
  expect(find(document.body, { metaKey: false })).toBe(false);
  expect(find(document.body, { metaKey: false, ctrlKey: true })).toBe(true);
});
it("unregisters the window shortcut when the last editor retires", () => {
  const entry = editor("center");
  cleanups.pop()!();
  expect(find()).toBe(false);
  expect(entry.open).not.toHaveBeenCalled();
});
