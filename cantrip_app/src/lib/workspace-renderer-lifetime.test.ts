import { expect, it, vi } from "vitest";
import {
  createWorkspaceRendererLifetimes,
  createWorkspaceRendererConnections,
} from "./workspace-renderer-lifetime";

it("shares overlapping connections but replaces an attachment after the final disconnect", () => {
  let serial = 0;
  const retain = createWorkspaceRendererConnections(
    () => `attachment-${++serial}`,
  );
  const context = {
    rendererId: "context",
    signal: new AbortController().signal,
  };
  const first = retain(context);
  const overlapping = retain(context);
  expect(first.rendererId).toBe(overlapping.rendererId);
  first.releaseConnection!();
  const stillLive = retain(context);
  expect(stillLive.rendererId).toBe(overlapping.rendererId);
  overlapping.releaseConnection!();
  stillLive.releaseConnection!();
  const returned = retain(context);
  expect(returned.rendererId).not.toBe(first.rendererId);
  first.releaseConnection!();
  expect(retain(context).rendererId).toBe(returned.rendererId);
});

it("does not retain a connection to an ended context", () => {
  const ended = new AbortController();
  ended.abort(new Error("context ended"));
  expect(() =>
    createWorkspaceRendererConnections()({
      rendererId: "context",
      signal: ended.signal,
    }),
  ).toThrow("context ended");
});

it("waits for an actual lock grant and reuses it across component reconnects", async () => {
  let grant!: () => Promise<void>;
  const request = vi.fn((_name: string, hold: () => Promise<void>) => {
    grant = hold;
    return new Promise<void>(() => {});
  });
  const ended = new AbortController();
  const acquire = createWorkspaceRendererLifetimes(
    { request },
    ended.signal,
    () => "renderer",
  );
  const pending = acquire("workspace-window");
  const resolved = vi.fn();
  void pending.then(resolved);
  await Promise.resolve();
  expect(resolved).not.toHaveBeenCalled();
  expect(acquire("workspace-window")).toBe(pending);
  void grant();
  const lifetime = await pending;
  expect(lifetime.rendererId).toBe("renderer");
  expect(request).toHaveBeenCalledTimes(1);
  expect(lifetime.signal.aborted).toBe(false);
  ended.abort(new Error("page ended"));
  expect(lifetime.signal.aborted).toBe(true);
  await expect(acquire("workspace-window")).rejects.toThrow("page ended");
});

it("does not turn a failed lock request into ownership and permits a real retry", async () => {
  const request = vi.fn(async (_name: string, _hold: () => Promise<void>) => {
    throw new Error("lock service unavailable");
  });
  const acquire = createWorkspaceRendererLifetimes(
    { request },
    new AbortController().signal,
  );
  await expect(acquire("window")).rejects.toThrow("lock service unavailable");
  await expect(acquire("window")).rejects.toThrow("lock service unavailable");
  expect(request).toHaveBeenCalledTimes(2);
});

it("rejects a late grant after pagehide instead of attaching a dead renderer", async () => {
  let grant!: () => Promise<void>;
  const ended = new AbortController();
  const acquire = createWorkspaceRendererLifetimes(
    {
      request: (_name, hold) => {
        grant = hold;
        return new Promise<void>(() => {});
      },
    },
    ended.signal,
  );
  const pending = acquire("window");
  const result = expect(pending).rejects.toThrow("page ended");
  await Promise.resolve();
  ended.abort(new Error("page ended"));
  await result;
  await expect(grant()).rejects.toThrow("page ended");
});
