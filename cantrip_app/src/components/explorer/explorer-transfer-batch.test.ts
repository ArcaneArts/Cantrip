import { expect, it, vi } from "vitest";
import {
  prepareExplorerTransferBatch,
  stageExplorerTransferBatch,
} from "./explorer-transfer-batch";
import type { ExplorerTransferState } from "./explorer-view";

function entry(tabId: string, events: string[] = []) {
  const scope = {
    serverId: "server",
    ownerId: "owner",
    projectId: "project",
    workerId: "worker",
    worktreeId: "worktree",
    explorerId: tabId,
  };
  const state: ExplorerTransferState = {
    explorerId: tabId,
    projectId: "project",
    workerId: "worker",
    worktreeId: "worktree",
    selectedPath: null,
    fileMode: "edit",
    documents: { scope: '["server","owner"]', documents: [] },
  };
  const release = vi.fn(() => {
    events.push(`resume:${tabId}`);
  });
  const lifecycle = {
    retireTransfer: vi.fn(() => {
      events.push(`retire:${tabId}`);
    }),
    suspendTransfer: vi.fn(() => {
      events.push(`suspend:${tabId}`);
      return release;
    }),
    captureTransfer: vi.fn(async () => {
      events.push(`capture:${tabId}`);
      return state;
    }),
  };
  return { tabId, scope, state, release, lifecycle };
}

it("suspends every editor before capturing, preserves order, and resumes once", async () => {
  const events: string[] = [];
  const entries = [entry("active", events), entry("inactive", events)];
  const batch = prepareExplorerTransferBatch(entries);
  expect((await batch.capture()).map(({ tabId }) => tabId)).toEqual([
    "active",
    "inactive",
  ]);
  expect(events).toEqual([
    "suspend:active",
    "suspend:inactive",
    "capture:active",
    "capture:inactive",
  ]);
  batch.resume();
  batch.resume();
  expect(entries.every(({ release }) => release.mock.calls.length === 1)).toBe(
    true,
  );
  await expect(batch.capture()).rejects.toThrow(/released/);
});

it("releases earlier editors when a later suspension fails", () => {
  const first = entry("first"),
    second = entry("second");
  second.lifecycle.suspendTransfer.mockImplementation(() => {
    throw new Error("editor detached");
  });
  expect(() => prepareExplorerTransferBatch([first, second])).toThrow(
    "editor detached",
  );
  expect(first.release).toHaveBeenCalledOnce();
  expect(first.lifecycle.captureTransfer).not.toHaveBeenCalled();
});

it("retires captured editors once and resumes every owner after partial retirement failure", async () => {
  const first = entry("first"),
    second = entry("second");
  const batch = prepareExplorerTransferBatch([first, second]);
  expect(() => batch.retire()).toThrow(/Capture/);
  await batch.capture();
  second.lifecycle.retireTransfer.mockImplementationOnce(() => {
    throw new Error("retirement failed");
  });
  expect(() => batch.retire()).toThrow("retirement failed");
  expect(first.release).not.toHaveBeenCalled();
  batch.retire();
  expect(first.lifecycle.retireTransfer).toHaveBeenCalledTimes(1);
  expect(second.lifecycle.retireTransfer).toHaveBeenCalledTimes(2);
  batch.resume();
  expect(first.release).toHaveBeenCalledOnce();
  expect(second.release).toHaveBeenCalledOnce();
  expect(() => batch.retire()).toThrow(/released/);
});

it("rejects a duplicate view without leaving an editor suspended", () => {
  const first = entry("same");
  expect(() => prepareExplorerTransferBatch([first, entry("same")])).toThrow(
    /Duplicate/,
  );
  expect(first.release).toHaveBeenCalledOnce();
});

it("validates captured scope and keeps suspension until the coordinator cancels", async () => {
  const first = entry("first");
  first.state.worktreeId = "foreign-worktree";
  const batch = prepareExplorerTransferBatch([first]);
  await expect(batch.capture()).rejects.toThrow(/mismatched/);
  expect(first.release).not.toHaveBeenCalled();
  batch.resume();
});

it("releases all editors even if one release throws", () => {
  const first = entry("first"),
    second = entry("second");
  second.release.mockImplementation(() => {
    throw new Error("release failed");
  });
  const batch = prepareExplorerTransferBatch([first, second]);
  expect(() => batch.resume()).toThrow(/could not be released/);
  expect(first.release).toHaveBeenCalledOnce();
  second.release.mockImplementation(() => {});
  batch.resume();
  expect(second.release).toHaveBeenCalledTimes(2);
  expect(first.release).toHaveBeenCalledOnce();
});

it("does not return a snapshot if released during capture", async () => {
  const first = entry("first");
  const batch = prepareExplorerTransferBatch([first]);
  first.lifecycle.captureTransfer.mockImplementation(async () => {
    batch.resume();
    return first.state;
  });
  await expect(batch.capture()).rejects.toThrow(/released during capture/);
});

it("stages all editors in authoritative order without touching destination lifecycles", async () => {
  const entries = [entry("first"), entry("second")];
  const batch = prepareExplorerTransferBatch(entries);
  const staged = stageExplorerTransferBatch(
    await batch.captureBytes(),
    [...entries].reverse(),
  );
  expect(staged.map(({ tabId }) => tabId)).toEqual(["second", "first"]);
  expect(staged[0]!.state).toEqual(entries[1]!.state);
  expect(staged[0]!.state).not.toBe(entries[1]!.state);
  batch.resume();
});

it.each([
  "missing",
  "duplicate",
  "unexpected",
  "wrong-scope",
  "malformed",
  "wrong-version",
])("rejects the entire %s batch", async (kind) => {
  const entries = [entry("first"), entry("second")];
  const batch = prepareExplorerTransferBatch(entries);
  const payload = JSON.parse(
    new TextDecoder().decode(await batch.captureBytes()),
  );
  if (kind === "missing") payload.editors.pop();
  if (kind === "duplicate") payload.editors[1].tabId = "first";
  if (kind === "unexpected") payload.editors[1].tabId = "other";
  if (kind === "wrong-scope") payload.editors[1].state.workerId = "other";
  if (kind === "malformed") payload.editors[1].state.documents = null;
  if (kind === "wrong-version") payload.version = 2;
  expect(() =>
    stageExplorerTransferBatch(
      new TextEncoder().encode(JSON.stringify(payload)),
      entries,
    ),
  ).toThrow();
  batch.resume();
});

it("rejects duplicate expected identities and malformed UTF-8", async () => {
  const entries = [entry("first"), entry("second")];
  const batch = prepareExplorerTransferBatch(entries);
  expect(() =>
    stageExplorerTransferBatch(new Uint8Array([255]), entries),
  ).toThrow(/Invalid/);
  const bytes = await batch.captureBytes();
  expect(() =>
    stageExplorerTransferBatch(bytes, [entries[0]!, entries[0]!]),
  ).toThrow(/Invalid/);
  batch.resume();
});
