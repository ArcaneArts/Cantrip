// Expectations execute the real protocol, including configured refinement paths.
import * as p from "../../packages/protocol/dist/index.js";
import { vectorCases, outcome } from "./security-oracle.mjs";
const operationId = "33333333-3333-4333-8333-000000000001";
const target = { kind: "codex-local" };
const chat = {
  chatId: "chat",
  threadId: "thread",
  destinationLabel: "Codex home",
  messageCount: 2,
  reused: false,
};
const request = { operationId, target, worktreeId: "tree", chatIds: ["chat"] };
const exported = { ...chat, status: "exported" };
const failed = {
  status: "failed",
  chatId: "other",
  code: "worker-error",
  message: "Failure",
};
const mapping = {
  id: "project-folder",
  label: "Project folder",
  description: "Files stay on the worker.",
};
const inspection = {
  target,
  available: true,
  destinationLabel: "Codex home",
  message: null,
  platform: "linux",
};
const preview = {
  target,
  targetLabel: "Codex",
  available: true,
  destinationLabel: "Codex home",
  message: null,
  worker: { workerId: "worker", name: "Worker", platform: "linux" },
  worktree: { worktreeId: "tree", name: "main", displayPath: "/project" },
  maxChats: 20,
  supportedChatExperiences: ["agent"],
  preserves: [mapping],
  flattens: [mapping],
};
const samples = {
  projectExportTargetSchema: [target],
  projectExportMappingSchema: [mapping],
  projectExportPreviewRequestSchema: [{ target, worktreeId: "tree" }],
  projectExportTargetInspectionSchema: [
    inspection,
    {
      ...inspection,
      available: false,
      destinationLabel: null,
      message: "Offline",
    },
  ],
  projectExportPreviewSchema: [preview],
  projectExportCreateSchema: [request],
  projectExportChatResultSchema: [chat],
  projectExportItemOutcomeSchema: [exported, failed],
  projectExportResultSchema: [
    {
      operationId,
      target,
      workerId: "worker",
      worktreeId: "tree",
      outcomes: [exported, failed],
    },
  ],
  projectExportChatBeginResultSchema: [
    { status: "upload" },
    { ...exported, reused: true },
  ],
};
const name = process.argv[2],
  cases = [...vectorCases(name, samples[name])];
const add = (input) => {
  const value = outcome(p[name], input);
  cases.push({
    input,
    outcome: value,
    ...(value.issues
      ? { errorMessage: p[name].safeParse(input).error.message }
      : {}),
  });
};
if (name === "projectExportCreateSchema") {
  for (const count of [0, 1, 20, 21]) {
    add({
      ...request,
      chatIds: Array.from({ length: count }, (_, index) => "chat-" + index),
    });
    add({ ...request, chatIds: Array.from({ length: count }, () => "same") });
  }
  for (const chatIds of [
    ["\ud800", "\ud800"],
    ["\ud800", "\ufffd"],
    ["e\u0301", "é"],
    ["", ""],
    [null, null],
    [1, 1],
    ["😀", "😀"],
    ["\ud800", "\ud801"],
    ["a".repeat(201), "a".repeat(201)],
  ])
    add({ ...request, chatIds });
  add({
    ...request,
    operationId: "bad",
    chatIds: ["same", "same"],
    extra: true,
  });
}
console.log(JSON.stringify({ schema: name, cases }));
