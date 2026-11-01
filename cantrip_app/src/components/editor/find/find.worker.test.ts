import { beforeEach, expect, it, vi } from "vitest";
import type { FindRequest, FindResult } from "./index";
const worker = {
  onmessage: null as null | ((event: MessageEvent<FindRequest>) => void),
  postMessage: vi.fn(),
};
beforeEach(async () => {
  vi.resetModules();
  worker.postMessage.mockReset();
  vi.stubGlobal("self", worker);
  await import("./find.worker");
});
function send(data: FindRequest) {
  worker.onmessage!({ data } as MessageEvent<FindRequest>);
}
it("handles search and ordered navigation without returning document text", () => {
  send({
    type: "search",
    requestId: 1,
    text: "private private private",
    query: "private",
    anchor: 0,
  });
  expect(worker.postMessage).toHaveBeenLastCalledWith({
    requestId: 1,
    action: "search",
    count: 3,
    index: 0,
    match: { from: 0, to: 7 },
  });
  send({ type: "move", requestId: 1, direction: -1 });
  const result = worker.postMessage.mock.lastCall![0] as FindResult;
  expect(result.index).toBe(2);
  expect(JSON.stringify(result)).not.toContain("private");
});
it("ignores navigation from an earlier query", () => {
  send({ type: "search", requestId: 2, text: "a b a", query: "b", anchor: 0 });
  send({ type: "move", requestId: 1, direction: 1 });
  expect(worker.postMessage).toHaveBeenCalledOnce();
});
