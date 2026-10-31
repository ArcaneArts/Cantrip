// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSyntaxHighlighting } from "./use-syntax-highlighting";
import type { SyntaxRequest, SyntaxResponse } from "./syntax/worker-protocol";
import { initialSyntaxState } from "./syntax/tokenizer";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
class SyntaxWorker {
  static instances: SyntaxWorker[] = [];
  onmessage: ((event: MessageEvent<SyntaxResponse>) => void) | null = null;
  postMessage = vi.fn<(message: SyntaxRequest) => void>();
  terminate = vi.fn();
  constructor() {
    SyntaxWorker.instances.push(this);
  }
  reply(
    first: number,
    last: number,
    documentId = "file",
    revision = 0,
    firstText = "const value = 1;",
  ) {
    this.onmessage?.({
      data: {
        documentId,
        revision,
        first,
        lines: Array.from({ length: last - first }, (_, i) => ({
          number: first + i + 1,
          text: first + i === 0 ? firstText : "const value = 1;",
          tokens: [{ kind: "keyword", from: 0, to: 5 }],
          from: (first + i) * 17,
          state: initialSyntaxState("typescript"),
        })),
      },
    } as MessageEvent<SyntaxResponse>);
  }
}
beforeEach(() => {
  SyntaxWorker.instances = [];
  vi.stubGlobal("Worker", SyntaxWorker);
});
afterEach(() => vi.unstubAllGlobals());
async function fixture() {
  const node = document.createElement("div");
  const root = createRoot(node);
  const props = {
    documentId: "file",
    text: Array(4000).fill("const value = 1;").join("\n"),
    revision: 0,
    first: 0,
    last: 40,
    active: true,
  };
  function Probe() {
    const lines = useSyntaxHighlighting(
      props.documentId,
      "file.ts",
      props.text,
      props.revision,
      props.first,
      props.last,
      props.active,
    );
    return (
      <output data-count={lines.size} data-first-text={lines.get(1)?.text}>
        {Array.from({ length: props.last - props.first }, (_, i) =>
          lines.get(props.first + i + 1)?.tokens.length ? "1" : "0",
        ).join("")}
      </output>
    );
  }
  const render = () => act(async () => root.render(<Probe />));
  await render();
  return { node, props, render, root, worker: SyntaxWorker.instances[0]! };
}
it("retains cached colors while scrolling and accepts useful replies for an earlier viewport", async () => {
  const f = await fixture();
  try {
    expect(f.worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "open", first: 0, last: 256 }),
    );
    await act(async () => f.worker.reply(0, 256));
    expect(f.node.textContent).toBe("1".repeat(40));
    const cached = f.worker.postMessage.mock.calls.length;
    Object.assign(f.props, { first: 16, last: 56 });
    await f.render();
    expect(f.node.textContent).toBe("1".repeat(40));
    expect(f.worker.postMessage).toHaveBeenCalledTimes(cached);
    Object.assign(f.props, { first: 144, last: 184 });
    await f.render();
    expect(f.node.textContent).toBe("1".repeat(40));
    Object.assign(f.props, { first: 272, last: 312 });
    await f.render();
    // This reply was requested before the latest viewport moved to block 128.
    await act(async () => f.worker.reply(0, 384));
    expect(f.node.textContent).toBe("1".repeat(40));
    expect(SyntaxWorker.instances).toHaveLength(1);
    expect(
      f.worker.postMessage.mock.calls.filter(
        ([message]) => message.type === "open",
      ),
    ).toHaveLength(1);
  } finally {
    await act(async () => f.root.unmount());
  }
});
it("keeps current colors during an edit while rejecting stale worker replies and other documents", async () => {
  const f = await fixture();
  try {
    await act(async () => f.worker.reply(0, 256));
    Object.assign(f.props, {
      text: f.props.text.replace("1;", "2;"),
      revision: 1,
    });
    await f.render();
    expect(f.worker.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "edit", baseRevision: 0, revision: 1 }),
    );
    expect(f.node.textContent).toBe("1".repeat(40));
    await act(async () => f.worker.reply(0, 256));
    expect(f.node.textContent).toBe("1".repeat(40));
    expect(f.node.querySelector("output")!.dataset.firstText).toBe(
      "const value = 2;",
    );
    await act(async () =>
      f.worker.reply(0, 256, "file", 1, "const value = 2;"),
    );
    expect(f.node.textContent).toBe("1".repeat(40));
    f.props.documentId = "other";
    await f.render();
    await act(async () => f.worker.reply(0, 256, "file", 1));
    expect(f.node.textContent).toBe("0".repeat(40));
    await act(async () => f.worker.reply(0, 256, "other", 1));
    expect(f.node.textContent).toBe("1".repeat(40));
  } finally {
    await act(async () => f.root.unmount());
  }
});
it("bounds cached token lines and preserves the current viewport across hide/show", async () => {
  const f = await fixture();
  try {
    for (let first = 0; first < 4000; first += 256) {
      Object.assign(f.props, { first, last: first + 40 });
      await f.render();
      await act(async () => f.worker.reply(first, first + 256));
    }
    expect(
      Number(f.node.querySelector("output")!.dataset.count),
    ).toBeLessThanOrEqual(2048);
    expect(f.node.textContent).toBe("1".repeat(40));
    f.props.active = false;
    await f.render();
    expect(f.worker.terminate).toHaveBeenCalledTimes(1);
    f.props.active = true;
    await f.render();
    expect(f.node.textContent).toBe("1".repeat(40));
    expect(SyntaxWorker.instances).toHaveLength(2);
  } finally {
    await act(async () => f.root.unmount());
  }
});
