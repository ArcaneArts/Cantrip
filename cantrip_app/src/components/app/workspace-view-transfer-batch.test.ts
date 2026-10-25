import { expect, it, vi } from "vitest";
import {
  prepareWorkspaceViewTransferBatch,
  stageWorkspaceViewTransferBatch,
} from "./workspace-view-transfer-batch";
import type { TerminalViewState } from "@/components/terminal/terminal-view-state";
import type { BrowserViewState } from "@/components/browser/browser-view-state";
import type { RemoteDesktopViewState } from "@/components/remote-desktop/remote-desktop-view-state";

it("captures remote desktop state in a mixed pane and validates its reservation", async () => {
  const state: RemoteDesktopViewState = {
    version: 1,
    desktopId: "desktop",
    projectId: "project",
    workerId: "worker",
    viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
    fleetOpen: true,
    targetSearch: "Editor",
  };
  const release = vi.fn();
  const desktop = {
    tabId: "desktop-tab",
    ...state,
    lifecycle: {
      suspendTransfer: vi.fn(() => release),
      captureTransfer: vi.fn(async () => state),
      retireTransfer: vi.fn(async () => {}),
    },
  };
  const f = fixture();
  const batch = prepareWorkspaceViewTransferBatch(
    [f.editor],
    [f.terminal],
    [],
    [],
    [desktop],
  );
  const bytes = await batch.captureBytes();
  expect(
    stageWorkspaceViewTransferBatch(
      bytes,
      [f.editor],
      [f.terminal],
      [],
      [],
      [desktop],
    ).desktops,
  ).toEqual([{ tabId: desktop.tabId, state }]);
  expect(() =>
    stageWorkspaceViewTransferBatch(bytes, [f.editor], [f.terminal]),
  ).toThrow("Invalid remote desktop transfer batch");
  expect(() =>
    stageWorkspaceViewTransferBatch(
      bytes,
      [f.editor],
      [f.terminal],
      [],
      [],
      [{ ...desktop, workerId: "other" }],
    ),
  ).toThrow("does not match its reservation");
  expect(() =>
    prepareWorkspaceViewTransferBatch(
      [f.editor],
      [],
      [],
      [],
      [{ ...desktop, tabId: f.editor.tabId }],
    ),
  ).toThrow("Duplicate transfer tab identity");
  await batch.retire();
  await batch.retire();
  expect(desktop.lifecycle.retireTransfer).toHaveBeenCalledOnce();
  batch.resume();
  batch.resume();
  expect(release).toHaveBeenCalledOnce();
});

it("validates browser ownership, stages private drafts, and retires one mixed pane", async () => {
  const state: BrowserViewState = {
    version: 1,
    browserId: "browser",
    projectId: "project",
    workerId: "worker",
    address: "unfinished",
    addressDirty: true,
    currentUrl: "https://example.com/",
    invalidAddress: false,
    serviceSearch: "local",
    viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
  };
  const release = vi.fn();
  const browser = {
    tabId: "browser-tab",
    browserId: "browser",
    projectId: "project",
    workerId: "worker",
    lifecycle: {
      suspendTransfer: vi.fn(() => release),
      captureTransfer: vi.fn(async () => state),
      retireTransfer: vi.fn(async () => {}),
    },
  };
  const f = fixture();
  const batch = prepareWorkspaceViewTransferBatch(
    [f.editor],
    [f.terminal],
    [browser],
  );
  const bytes = await batch.captureBytes();
  expect(
    stageWorkspaceViewTransferBatch(bytes, [f.editor], [f.terminal], [browser])
      .browsers,
  ).toEqual([{ tabId: browser.tabId, state }]);
  expect(() =>
    stageWorkspaceViewTransferBatch(
      bytes,
      [f.editor],
      [f.terminal],
      [{ ...browser, workerId: "other" }],
    ),
  ).toThrow(/does not match/);
  expect(() =>
    stageWorkspaceViewTransferBatch(bytes, [f.editor], [f.terminal], []),
  ).toThrow(/Invalid browser/);
  expect(() =>
    prepareWorkspaceViewTransferBatch(
      [f.editor],
      [],
      [{ ...browser, tabId: f.editor.tabId }],
    ),
  ).toThrow(/Duplicate/);
  await batch.retire();
  await batch.retire();
  expect(browser.lifecycle.retireTransfer).toHaveBeenCalledOnce();
  batch.resume();
  batch.resume();
  expect(release).toHaveBeenCalledOnce();
});

function fixture() {
  const state: TerminalViewState = {
    version: 1,
    terminalId: "terminal",
    workerId: "worker",
    buffer: "normal",
    cols: 80,
    viewportY: 0,
    followingOutput: true,
    selection: null,
  };
  const release = vi.fn();
  const terminal = {
    tabId: "terminal-tab",
    terminalId: "terminal",
    workerId: "worker",
    lifecycle: {
      suspendTransfer: vi.fn(() => release),
      captureTransfer: vi.fn(async () => state),
      retireTransfer: vi.fn(async () => {}),
    },
  };
  const editorRelease = vi.fn();
  const editor = {
    tabId: "editor-tab",
    scope: {
      serverId: "server",
      ownerId: "owner",
      explorerId: "editor",
      projectId: "project",
      worktreeId: "tree",
      workerId: "worker",
    },
    lifecycle: {
      suspendTransfer: vi.fn(() => editorRelease),
      captureTransfer: vi.fn(async () => ({
        explorerId: "editor",
        projectId: "project",
        worktreeId: "tree",
        workerId: "worker",
        selectedPath: null,
        fileMode: "edit" as const,
        documents: { scope: '["server","owner"]', documents: [] },
      })),
      retireTransfer: vi.fn(),
    },
  };
  return { terminal, editor, release, editorRelease };
}
it("captures one mixed envelope and waits for terminal retirement", async () => {
  const f = fixture();
  let finish!: () => void;
  f.terminal.lifecycle.retireTransfer.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const batch = prepareWorkspaceViewTransferBatch([f.editor], [f.terminal]);
  const bytes = await batch.captureBytes();
  const staged = stageWorkspaceViewTransferBatch(
    bytes,
    [f.editor],
    [f.terminal],
  );
  expect(staged.editors[0]!.tabId).toBe("editor-tab");
  expect(staged.terminals[0]!.state.terminalId).toBe("terminal");
  let retired = false;
  const retirement = batch.retire().then(() => {
    retired = true;
  });
  await Promise.resolve();
  expect(retired).toBe(false);
  finish();
  await retirement;
  await batch.retire();
  expect(f.terminal.lifecycle.retireTransfer).toHaveBeenCalledOnce();
  batch.resume();
  batch.resume();
  expect(f.release).toHaveBeenCalledOnce();
  expect(f.editorRelease).toHaveBeenCalledOnce();
});
it("releases editor suspensions if terminal preparation fails", () => {
  const f = fixture();
  f.terminal.lifecycle.suspendTransfer.mockImplementation(() => {
    throw new Error("terminal gone");
  });
  expect(() =>
    prepareWorkspaceViewTransferBatch([f.editor], [f.terminal]),
  ).toThrow("terminal gone");
  expect(f.editorRelease).toHaveBeenCalledOnce();
});
it("rejects unexpected sessions, missing tabs, and duplicate identities", async () => {
  const f = fixture();
  const batch = prepareWorkspaceViewTransferBatch([], [f.terminal]);
  try {
    const bytes = await batch.captureBytes();
    expect(() =>
      stageWorkspaceViewTransferBatch(
        bytes,
        [],
        [{ ...f.terminal, workerId: "other" }],
      ),
    ).toThrow(/does not match/);
    expect(() => stageWorkspaceViewTransferBatch(bytes, [], [])).toThrow(
      /Invalid terminal/,
    );
    expect(() =>
      prepareWorkspaceViewTransferBatch(
        [f.editor],
        [{ ...f.terminal, tabId: f.editor.tabId }],
      ),
    ).toThrow(/Duplicate/);
  } finally {
    batch.resume();
  }
});
