// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorDocumentSession } from "../document-session";
import { useEditorFind, type EditorFindState } from "./use-editor-find";
import type { FindRequest, FindResponse } from "./index";
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
class FindWorker {
  static instances: FindWorker[] = [];
  onmessage: ((event: MessageEvent<FindResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage = vi.fn<(message: FindRequest) => void>();
  terminate = vi.fn();
  constructor() {
    FindWorker.instances.push(this);
  }
  reply(
    requestId: number,
    index = 0,
    count = 3,
    action: "search" | "move" = "search",
  ) {
    this.onmessage?.({
      data: {
        requestId,
        action,
        index,
        count,
        match: count ? { from: index * 4, to: index * 4 + 3 } : null,
      },
    } as MessageEvent<FindResponse>);
  }
}
const roots: ReturnType<typeof createRoot>[] = [];
beforeEach(() => {
  FindWorker.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal("Worker", FindWorker);
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function fixture() {
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  let state!: EditorFindState;
  const session = new EditorDocumentSession("file", "one one one", "version");
  let active = true,
    ready = true;
  function Probe() {
    state = useEditorFind(session, active, ready);
    return null;
  }
  const render = async (nextActive = active, nextReady = ready) => {
    active = nextActive;
    ready = nextReady;
    await act(async () => root.render(<Probe />));
  };
  await render();
  return {
    get state() {
      return state;
    },
    session,
    render,
  };
}
it("starts only on demand, debounces queries, and does no work for ordinary rerenders", async () => {
  const f = await fixture();
  expect(FindWorker.instances).toHaveLength(0);
  await act(async () => f.state.show("one"));
  const worker = FindWorker.instances[0]!;
  await act(async () => vi.advanceTimersByTimeAsync(75));
  expect(worker.postMessage).toHaveBeenCalledOnce();
  const request = worker.postMessage.mock.lastCall![0];
  expect(request).toMatchObject({
    type: "search",
    text: "one one one",
    query: "one",
  });
  await act(async () => worker.reply(request.requestId));
  expect(f.state.result?.count).toBe(3);
  await f.render();
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(worker.postMessage).toHaveBeenCalledOnce();
  await act(async () => {
    f.state.setQuery("t");
    f.state.setQuery("two");
  });
  expect(f.state.result).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(75));
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
  expect(worker.postMessage.mock.lastCall![0]).toMatchObject({ query: "two" });
});
it("rejects stale responses after query, document edits and hidden/closed views", async () => {
  const f = await fixture();
  await act(async () => f.state.show("one"));
  await act(async () => vi.advanceTimersByTimeAsync(75));
  const worker = FindWorker.instances[0]!,
    id = worker.postMessage.mock.lastCall![0].requestId;
  f.session.edit("one two");
  await f.render();
  await act(async () => worker.reply(id));
  expect(f.state.result).toBeNull();
  await f.render(false);
  expect(worker.terminate).toHaveBeenCalledOnce();
  await f.render(true);
  expect(FindWorker.instances).toHaveLength(2);
  await act(async () => worker.reply(id));
  expect(f.state.result).toBeNull();
  await act(async () => f.state.close());
  expect(FindWorker.instances[1]!.terminate).toHaveBeenCalledOnce();
});
it("queues Enter presses until the matching query finishes", async () => {
  const f = await fixture();
  await act(async () => f.state.show("one"));
  await act(async () => {
    f.state.move(1);
    f.state.move(1);
    f.state.move(-1);
  });
  await act(async () => vi.advanceTimersByTimeAsync(75));
  const worker = FindWorker.instances[0]!,
    id = worker.postMessage.mock.lastCall![0].requestId;
  await act(async () => worker.reply(id));
  expect(worker.postMessage).toHaveBeenLastCalledWith({
    type: "move",
    requestId: id,
    direction: 1,
  });
  await act(async () => worker.reply(id, 1));
  expect(f.state.result?.index).toBe(1);
});
it("keeps the editor available if the search worker cannot start", async () => {
  vi.stubGlobal(
    "Worker",
    class {
      constructor() {
        throw new Error("unavailable");
      }
    },
  );
  const f = await fixture();
  await act(async () => f.state.show("one"));
  expect(f.state.failed).toBe(true);
  expect(f.session.text).toBe("one one one");
});

it("updates counts after editing without moving the caret until explicit navigation", async () => {
  const f = await fixture();
  await act(async () => f.state.show("one"));
  await act(async () => vi.advanceTimersByTimeAsync(75));
  const worker = FindWorker.instances[0]!;
  await act(async () =>
    worker.reply(worker.postMessage.mock.lastCall![0].requestId),
  );
  expect(f.state.result?.reveal).toBe(true);
  f.session.edit("one two one");
  await f.render();
  await act(async () => vi.advanceTimersByTimeAsync(75));
  const id = worker.postMessage.mock.lastCall![0].requestId;
  await act(async () => worker.reply(id, 1, 2));
  expect(f.state.result?.reveal).toBe(false);
  await act(async () => f.state.move(1));
  await act(async () => worker.reply(id, 0, 2, "move"));
  expect(f.state.result?.reveal).toBe(true);
});

it("waits for a complete paged snapshot and preserves explicit search navigation", async () => {
  const f = await fixture();
  await f.render(true, false);
  await act(async () => f.state.show("one"));
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  const worker = FindWorker.instances[0]!;
  expect(worker.postMessage).not.toHaveBeenCalled();
  f.session.edit("one two one");
  await f.render(true, false);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(worker.postMessage).not.toHaveBeenCalled();
  await f.render(true, true);
  await act(async () => vi.advanceTimersByTimeAsync(75));
  const request = worker.postMessage.mock.lastCall![0];
  expect(request).toMatchObject({ text: "one two one" });
  await act(async () => worker.reply(request.requestId, 0, 2));
  expect(f.state.result?.reveal).toBe(true);
});
