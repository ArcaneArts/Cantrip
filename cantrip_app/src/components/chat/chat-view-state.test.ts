import { expect, it, vi } from "vitest";
import { parseChatViewState, type ChatViewState } from "./chat-view-state";
import {
  prepareWorkspaceViewTransferBatch,
  stageWorkspaceViewTransferBatch,
} from "@/components/app/workspace-view-transfer-batch";

const owner = { tabId: "tab", chatId: "chat", projectId: "project" };
const state: ChatViewState = {
  version: 1,
  chatId: "chat",
  projectId: "project",
  draft: { text: "unfinished", mode: "plan", reasoningEffort: null },
  nativeModeIntent: "plan",
  composerSelection: { start: 1, end: 4, scrollTop: 0 },
  transcript: { scrollTop: 240, following: false },
  editingPrompt: null,
  editingSentMessage: { id: "message", text: "edited draft", error: null },
  inspectTab: "trajectory",
  trajectoryTargetKey: "turn",
  sidePanelView: { type: "inspect" },
};

it("preserves private draft and view state under the reserved identity", () => {
  expect(parseChatViewState(state, owner)).toEqual(state);
  expect(() =>
    parseChatViewState(state, { ...owner, chatId: "other" }),
  ).toThrow("reservation");
  expect(() =>
    parseChatViewState(state, { ...owner, projectId: "other" }),
  ).toThrow("reservation");
});

it("rejects invalid coordinates, selection and unexpected state", () => {
  for (const scrollTop of [-1, Infinity, NaN])
    expect(() =>
      parseChatViewState(
        { ...state, transcript: { scrollTop, following: false } },
        owner,
      ),
    ).toThrow();
  expect(() =>
    parseChatViewState(
      { ...state, composerSelection: { start: 4, end: 1, scrollTop: 0 } },
      owner,
    ),
  ).toThrow();
  expect(() =>
    parseChatViewState(
      { ...state, composerSelection: { start: 0, end: 500, scrollTop: 0 } },
      owner,
    ),
  ).toThrow();
  expect(() =>
    parseChatViewState({ ...state, plaintextHistory: [] }, owner),
  ).toThrow();
});

it("captures and stages chats in the common batch and retires each view once", async () => {
  const release = vi.fn();
  const lifecycle = {
    suspendTransfer: vi.fn(() => release),
    captureTransfer: vi.fn(async () => state),
    retireTransfer: vi.fn(async () => {}),
  };
  const batch = prepareWorkspaceViewTransferBatch(
    [],
    [],
    [],
    [{ ...owner, lifecycle }],
  );
  const bytes = await batch.captureBytes();
  expect(
    stageWorkspaceViewTransferBatch(bytes, [], [], [], [owner]).chats,
  ).toEqual([{ tabId: owner.tabId, state }]);
  expect(() =>
    stageWorkspaceViewTransferBatch(
      bytes,
      [],
      [],
      [],
      [{ ...owner, chatId: "other" }],
    ),
  ).toThrow("reservation");
  await batch.retire();
  await batch.retire();
  expect(lifecycle.retireTransfer).toHaveBeenCalledOnce();
  batch.resume();
  expect(release).toHaveBeenCalledOnce();
});
