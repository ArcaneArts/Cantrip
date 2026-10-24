import { expect, it, vi } from "vitest";
import { bindWorkspaceRefreshChannel } from "./workspace-refresh-channel";
import type { WorkspaceCommandClient } from "./workspace-command-client";
import type { ClientSessionIdentitySnapshot } from "./client-session";

function fixture() {
  const state = {
    disposed: false,
    authoritative: { id: "workspace", projectId: "project", revision: 2 },
  } as ReturnType<WorkspaceCommandClient["getSnapshot"]>;
  let receive!: (event: MessageEvent<unknown>) => void;
  let publish!: () => void;
  const port = {
    postMessage: vi.fn(),
    close: vi.fn(),
    removeEventListener: vi.fn(),
    addEventListener: vi.fn(
      (_name: string, callback: EventListenerOrEventListenerObject) => {
        receive = callback as typeof receive;
      },
    ),
  };
  const controller = {
    getSnapshot: () => state,
    subscribe: (callback: () => void) => {
      publish = callback;
      return vi.fn();
    },
    refresh: vi.fn(async () => {}),
  };
  const create = vi.fn(() => port);
  const identity = {
    serverId: "server",
    userId: "owner",
  } as ClientSessionIdentitySnapshot;
  const close = bindWorkspaceRefreshChannel(controller, identity, create);
  return {
    state,
    port,
    controller,
    create,
    close,
    publish: () => publish(),
    receive: (data: unknown) => receive({ data } as MessageEvent),
  };
}

it("scopes hints to server, account, project and device workspace without sending layout", () => {
  const f = fixture();
  expect(f.create).toHaveBeenCalledWith(
    'cantrip-workspace-refresh:["server","owner","project","workspace"]',
  );
  f.state.authoritative.revision = 3;
  f.publish();
  f.publish();
  expect(f.port.postMessage.mock.calls).toEqual([[3]]);
  f.close();
});

it("only requests authoritative reads for newer valid revisions", async () => {
  const f = fixture();
  for (const value of [null, {}, "3", -1, 2, 2.5, Infinity, NaN])
    f.receive(value);
  expect(f.controller.refresh).not.toHaveBeenCalled();
  f.receive(3);
  await Promise.resolve();
  expect(f.controller.refresh).toHaveBeenCalledOnce();
  expect(f.state.authoritative.revision).toBe(2);
  f.close();
});

it("coalesces a burst but reads again when a hint arrives during a read", async () => {
  const f = fixture();
  let finish!: () => void;
  f.controller.refresh.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  f.receive(3);
  f.receive(4);
  f.receive(5);
  expect(f.controller.refresh).toHaveBeenCalledOnce();
  finish();
  await Promise.resolve();
  await Promise.resolve();
  expect(f.controller.refresh).toHaveBeenCalledTimes(2);
  f.close();
});

it("does not retry forever on failed reads or impossible hinted revisions", async () => {
  const f = fixture();
  f.controller.refresh.mockRejectedValue(new Error("offline"));
  f.receive(Number.MAX_SAFE_INTEGER);
  await Promise.resolve();
  await Promise.resolve();
  expect(f.controller.refresh).toHaveBeenCalledOnce();
  f.close();
});

it("disposes idempotently and ignores late events", () => {
  const f = fixture();
  f.close();
  f.close();
  f.receive(3);
  f.state.authoritative.revision = 4;
  f.publish();
  expect(f.port.close).toHaveBeenCalledOnce();
  expect(f.controller.refresh).not.toHaveBeenCalled();
  expect(f.port.postMessage).not.toHaveBeenCalled();
});

it("does not start a queued read after disposal during an in-flight read", async () => {
  const f = fixture();
  let finish!: () => void;
  f.controller.refresh.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  f.receive(3);
  f.receive(4);
  f.close();
  finish();
  await Promise.resolve();
  await Promise.resolve();
  expect(f.controller.refresh).toHaveBeenCalledOnce();
});

it("ignores messages and publications after the controller is disposed", () => {
  const f = fixture();
  f.state.disposed = true;
  f.receive(3);
  f.state.authoritative.revision = 4;
  f.publish();
  expect(f.controller.refresh).not.toHaveBeenCalled();
  expect(f.port.postMessage).not.toHaveBeenCalled();
  f.close();
});

it("channel failures never reject successful controller changes", () => {
  const f = fixture();
  f.port.postMessage.mockImplementation(() => {
    throw new Error("closed");
  });
  f.state.authoritative.revision = 3;
  expect(f.publish).not.toThrow();
  f.close();
  expect(() =>
    bindWorkspaceRefreshChannel(
      f.controller,
      {} as ClientSessionIdentitySnapshot,
      () => {
        throw new Error("unavailable");
      },
    )(),
  ).not.toThrow();
});
