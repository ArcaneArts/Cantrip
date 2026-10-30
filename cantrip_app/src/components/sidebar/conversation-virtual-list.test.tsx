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
async function render(items = rows) {
  await act(async () =>
    root.render(
      <ConversationVirtualList rows={items} estimate={32} label="Conversations">
        {(row) => <button>{row.id}</button>}
      </ConversationVirtualList>,
    ),
  );
}
const viewport = () => host.querySelector<HTMLElement>('[role="list"]')!;
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
