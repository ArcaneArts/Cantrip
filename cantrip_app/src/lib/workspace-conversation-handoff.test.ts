import { expect, it, vi } from "vitest";
import {
  createConversationHandoff,
  type ConversationHandoffRequest,
} from "./workspace-conversation-handoff";
function ports() {
  const listeners = [new Set<EventListener>(), new Set<EventListener>()];
  return listeners.map((own, index) => ({
    postMessage: vi.fn((data: unknown) => {
      for (const listener of listeners[1 - index]!)
        listener({ data } as MessageEvent);
    }),
    addEventListener: (_: string, listener: EventListener) => own.add(listener),
    removeEventListener: (_: string, listener: EventListener) =>
      own.delete(listener),
    close: vi.fn(),
  }));
}
const scope = {
  serverId: "server",
  ownerId: "owner",
  workspaceId: "workspace",
};
const request = {
  sourceWindowId: "popout",
  sourceGeneration: 4,
  viewId: "view",
  chatId: "chat",
};
it("waits for the source's protected handoff before reporting completion", async () => {
  const [mainPort, sourcePort] = ports();
  let complete!: () => void;
  const receive = vi.fn(
    (_request: ConversationHandoffRequest) =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  const main = createConversationHandoff({
    ...scope,
    windowId: "main",
    port: mainPort!,
    receive: vi.fn(),
  });
  const source = createConversationHandoff({
    ...scope,
    windowId: "popout",
    port: sourcePort!,
    receive,
  });
  try {
    const done = vi.fn();
    const pending = main.request(request).then(done);
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce());
    expect(receive.mock.calls[0]?.[0]).toMatchObject(request);
    expect(done).not.toHaveBeenCalled();
    complete();
    await pending;
    expect(done).toHaveBeenCalledOnce();
    expect(mainPort!.postMessage.mock.calls[0]![0]).not.toHaveProperty("title");
  } finally {
    main.dispose();
    source.dispose();
  }
});
it("reports source failure without a successful ownership acknowledgement", async () => {
  const [mainPort, sourcePort] = ports();
  const main = createConversationHandoff({
    ...scope,
    windowId: "main",
    port: mainPort!,
    receive: vi.fn(),
  });
  const source = createConversationHandoff({
    ...scope,
    windowId: "popout",
    port: sourcePort!,
    receive: async () => {
      throw new Error("Draft checkpoint failed");
    },
  });
  try {
    await expect(main.request(request)).rejects.toThrow(
      "Draft checkpoint failed",
    );
  } finally {
    main.dispose();
    source.dispose();
  }
});
it("does not execute duplicate requests twice", async () => {
  const [mainPort, sourcePort] = ports();
  const receive = vi.fn(async () => {});
  const source = createConversationHandoff({
    ...scope,
    windowId: "popout",
    port: sourcePort!,
    receive,
  });
  try {
    mainPort!.postMessage({
      ...request,
      kind: "request",
      id: "same-operation",
    });
    mainPort!.postMessage({
      ...request,
      kind: "request",
      id: "same-operation",
    });
    await vi.waitFor(() =>
      expect(sourcePort!.postMessage).toHaveBeenCalledTimes(2),
    );
    expect(receive).toHaveBeenCalledOnce();
  } finally {
    source.dispose();
  }
});
it("rejects pending requests on context disposal and ignores a different source", async () => {
  const [mainPort, sourcePort] = ports();
  const receive = vi.fn(async () => {});
  const main = createConversationHandoff({
    ...scope,
    windowId: "main",
    port: mainPort!,
    receive: vi.fn(),
  });
  const source = createConversationHandoff({
    ...scope,
    windowId: "another-window",
    port: sourcePort!,
    receive,
  });
  const outcome = expect(main.request(request)).rejects.toThrow(
    "context changed",
  );
  main.dispose();
  await outcome;
  expect(receive).not.toHaveBeenCalled();
  source.dispose();
});
it("cancels a local acknowledgement wait without sending a second handoff", async () => {
  const [port] = ports();
  const main = createConversationHandoff({
    ...scope,
    windowId: "main",
    port: port!,
    receive: vi.fn(),
  });
  const controller = new AbortController();
  try {
    const pending = main.request(request, controller.signal);
    const rejected = expect(pending).rejects.toThrow("ownership confirmed");
    controller.abort(new Error("ownership confirmed"));
    await rejected;
    expect(port!.postMessage).toHaveBeenCalledOnce();
  } finally {
    main.dispose();
  }
});
