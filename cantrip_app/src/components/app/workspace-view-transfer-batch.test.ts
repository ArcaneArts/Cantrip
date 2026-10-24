import { expect, it, vi } from "vitest";
import {
  prepareWorkspaceViewTransferBatch,
  stageWorkspaceViewTransferBatch,
} from "./workspace-view-transfer-batch";
import type { TerminalViewState } from "@/components/terminal/terminal-view-state";

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
