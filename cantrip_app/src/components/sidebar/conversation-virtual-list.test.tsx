// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationVirtualList } from "./conversation-virtual-list";
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const rows = Array.from({ length: 1000 }, (_, i) => ({ id: `chat-${i}` }));
const archived = Array.from({ length: 1000 }, (_, i) => ({
  id: `archive-${i}`,
}));
async function render(items = rows, showArchive = false) {
  await act(async () =>
    root.render(
      <div data-slot="conversation-list-scroll">
        <div>
          <ConversationVirtualList rows={items} estimate={32} label="Active">
            {(row) => <button>{row.id}</button>}
          </ConversationVirtualList>
          {showArchive ? (
            <ConversationVirtualList
              rows={archived}
              estimate={50}
              label="Archive"
            >
              {(row) => <button>{row.id}</button>}
            </ConversationVirtualList>
          ) : null}
        </div>
      </div>,
    ),
  );
}
const viewport = () =>
  host.querySelector<HTMLElement>('[data-slot="conversation-list-scroll"]')!;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(callback, 0),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("bounds mounted rows and reaches the oldest item without mounting the intervening catalog", async () => {
  await render();
  expect(host.querySelectorAll("button").length).toBeLessThan(30);
  expect(host.textContent).toContain("chat-0");
  await act(async () => {
    viewport().scrollTop = 31616;
    viewport().dispatchEvent(new Event("scroll"));
  });
  expect(host.textContent).toContain("chat-999");
  expect(host.querySelectorAll("button").length).toBeLessThan(30);
  expect(
    host.querySelector('[aria-posinset="1000"]')?.getAttribute("aria-setsize"),
  ).toBe("1000");
});
it("preserves the visible resource and offset when recency changes above it", async () => {
  await render();
  await act(async () => {
    viewport().scrollTop = 16003;
    viewport().dispatchEvent(new Event("scroll"));
  });
  await render([{ id: "new" }, ...rows]);
  expect(viewport().scrollTop).toBe(16035);
  expect(host.textContent).toContain("chat-500");
  await render([{ id: "new" }, ...rows.slice(1)]);
  expect(viewport().scrollTop).toBe(16003);
});
it("keeps a focused row mounted when scrolling and moves keyboard focus across virtual boundaries", async () => {
  await render();
  const first = host.querySelector("button")!;
  await act(async () => first.focus());
  await act(async () => {
    viewport().scrollTop = 16000;
    viewport().dispatchEvent(new Event("scroll"));
  });
  expect(document.activeElement).toBe(first);
  expect(host.querySelectorAll("button").length).toBeLessThan(32);
  await act(async () => {
    first.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(document.activeElement?.textContent).toBe("chat-999");
});

it("windows each list at its own offset in the common scroll region", async () => {
  await render(rows, true);
  const archive = host.querySelector('[aria-label="Archive"]')!;
  const archiveOffset = rows.length * 32 + 48;
  Object.defineProperty(archive, "offsetTop", { value: archiveOffset });
  Object.defineProperty(viewport(), "clientHeight", { value: 400 });
  await act(async () => {
    viewport().scrollTop = archiveOffset + 500 * 50;
    viewport().dispatchEvent(new Event("scroll"));
  });
  expect(host.querySelector('[aria-label="Active"] button')).toBeNull();
  const middle = archive.querySelector<HTMLButtonElement>(
    '[data-virtual-conversation="archive-500"] button',
  )!;
  expect(middle.textContent).toBe("archive-500");
  expect(archive.querySelectorAll("button").length).toBeLessThan(25);
  await act(async () => {
    middle.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(viewport().scrollTop).toBe(archiveOffset);
  expect(document.activeElement?.textContent).toBe("archive-0");
});
