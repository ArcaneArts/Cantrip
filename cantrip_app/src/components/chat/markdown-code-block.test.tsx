// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./markdown";
import { markdownCodeBlockText } from "./markdown-code-block";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const writeText = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  writeText.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function render(content: string) {
  await act(async () => root.render(<Markdown>{content}</Markdown>));
}
async function copy(index = 0) {
  await act(async () => {
    host
      .querySelectorAll<HTMLButtonElement>('button[aria-label="Copy code"]')
      [index]!.click();
  });
}

describe("Markdown code block copying", () => {
  it("extracts text without token markup, commas, or lost whitespace", () => {
    expect(
      markdownCodeBlockText(<code>{["  first\n", "\tsecond\n\n"]}</code>),
    ).toBe("  first\n\tsecond\n\n");
    expect(markdownCodeBlockText(<code />)).toBe("");
    expect(
      markdownCodeBlockText([
        null,
        false,
        createPortal("not code", document.body),
      ]),
    ).toBe("");
  });
  it("copies only the selected block's original code and confirms success temporarily", async () => {
    await render(
      '```rust\nfn main() {\n  println!("<hello>");\n}\n```\n\n```\nsecond\n``` ',
    );
    await copy();
    expect(writeText).toHaveBeenLastCalledWith(
      'fn main() {\n  println!("<hello>");\n}\n',
    );
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "Code copied",
    );
    await copy(1);
    expect(writeText).toHaveBeenLastCalledWith("second\n");
    await act(async () => vi.advanceTimersByTime(1500));
    expect(host.textContent).not.toContain("Code copied");
  });
  it("reports a clipboard failure and allows retrying the same block", async () => {
    writeText.mockRejectedValueOnce(new Error("Permission denied"));
    await render("```\ntry again\n```");
    await copy();
    expect(host.textContent).toContain("Unable to copy code. Try again.");
    expect(host.textContent).not.toContain("Code copied");
    await copy();
    expect(host.textContent).toContain("Code copied");
  });
  it("copies updated streaming content and ignores a stale clipboard completion", async () => {
    let resolve!: () => void;
    writeText.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    await render("```\nold\n```");
    await copy();
    await render("```\nnew\n```");
    await act(async () => resolve());
    expect(host.textContent).not.toContain("Code copied");
    await copy();
    expect(writeText).toHaveBeenLastCalledWith("new\n");
  });
  it("does not leave a feedback timer after unmounting during a pending copy", async () => {
    let resolve!: () => void;
    writeText.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    await render("```\ncopy\n```");
    await copy();
    await act(async () => root.render(null));
    await act(async () => resolve());
    expect(vi.getTimerCount()).toBe(0);
  });
});
