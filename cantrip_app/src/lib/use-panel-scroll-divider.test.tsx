// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PanelToolbar } from "@/components/workspace/panel-toolbar";
import { usePanelScrollDivider } from "./use-panel-scroll-divider";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
function Panel({
  id,
  scope = "file",
  initialScroll = 0,
  active = true,
  render = () => {},
}: {
  id: string;
  scope?: string;
  initialScroll?: number;
  active?: boolean;
  render?: () => void;
}) {
  render();
  const ref = usePanelScrollDivider(scope, active);
  return (
    <div ref={ref} data-panel-scroll-root="" data-panel={id}>
      <PanelToolbar scrollDivider>File controls</PanelToolbar>
      <div
        key={scope}
        data-scroller=""
        ref={(node) => {
          if (node) node.scrollTop = initialScroll;
        }}
      />
    </div>
  );
}
const opacity = (element: Element) =>
  (element as HTMLElement).style.getPropertyValue(
    "--panel-scroll-divider-opacity",
  );
function scroll(element: HTMLElement, top: number) {
  element.scrollTop = top;
  element.dispatchEvent(new Event("scroll"));
}

it("keeps scroll chrome local and writes only when crossing the top boundary, without React renders", async () => {
  const node = document.createElement("div");
  const root = createRoot(node);
  const render = vi.fn();
  const writes: MutationRecord[] = [];
  const observer = new MutationObserver((records) => writes.push(...records));
  try {
    await act(async () =>
      root.render(
        <>
          <Panel id="left" render={render} />
          <Panel id="right" />
        </>,
      ),
    );
    const left = node.querySelector('[data-panel="left"]')!;
    const right = node.querySelector('[data-panel="right"]')!;
    const viewport = left.querySelector<HTMLElement>("[data-scroller]")!;
    expect(opacity(left)).toBe("0");
    observer.observe(left, { attributes: true, attributeFilter: ["style"] });
    await act(async () => {
      for (let top = 2; top < 100; top++) scroll(viewport, top);
    });
    expect(opacity(left)).toBe("1");
    expect(opacity(right)).toBe("0");
    expect([...writes, ...observer.takeRecords()]).toHaveLength(1);
    expect(render).toHaveBeenCalledOnce();
    await act(async () => scroll(viewport, 0));
    expect(opacity(left)).toBe("0");
    await act(async () => {
      viewport.scrollLeft = 100;
      viewport.dispatchEvent(new Event("scroll"));
    });
    expect(opacity(left)).toBe("0");
  } finally {
    observer.disconnect();
    await act(async () => root.unmount());
  }
});

it("reads restored scroll positions and resets ownership on file switches and panel activation", async () => {
  const node = document.createElement("div");
  const root = createRoot(node);
  try {
    await act(async () => root.render(<Panel id="file" initialScroll={240} />));
    const panel = node.querySelector("[data-panel]")!;
    expect(opacity(panel)).toBe("1");
    await act(async () => root.render(<Panel id="file" scope="other-file" />));
    expect(opacity(panel)).toBe("0");
    await act(async () =>
      root.render(
        <Panel id="file" scope="restored-file" initialScroll={480} />,
      ),
    );
    expect(opacity(panel)).toBe("1");
    await act(async () =>
      root.render(
        <Panel
          id="file"
          scope="restored-file"
          initialScroll={480}
          active={false}
        />,
      ),
    );
    expect(opacity(panel)).toBe("0");
    await act(async () =>
      root.render(
        <Panel id="file" scope="restored-file" initialScroll={480} active />,
      ),
    );
    expect(opacity(panel)).toBe("1");
  } finally {
    await act(async () => root.unmount());
  }
});
