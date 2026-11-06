import * as p from "../../packages/protocol/dist/index.js";
import { vectorCases, outcome } from "./security-oracle.mjs";
import { label, stamp } from "./project-target-state.mjs";
const id = "33333333-3333-4333-8333-000000000001",
  attachmentId = "44444444-4444-4444-8444-000000000001";
const attachment = {
  id: attachmentId,
  sourceAttachmentId: "a".repeat(64),
  itemId: "user",
  sizeBytes: 128,
  status: "available",
  protectedMetadata: label("chat").protectedLabel,
};
const transcript = p.externalChatTranscriptSchema.parse({
  sourceId: "b".repeat(64),
  sourceThreadId: "external",
  titleProtection: label("chat"),
  metadata: {
    sourceThreadId: "external",
    preview: "History 😀 \ud800\u2028",
    cwd: "/project",
    createdAt: stamp,
    updatedAt: stamp,
    source: "vscode",
    status: "not-loaded",
    modelProvider: "openai",
    cliVersion: "0.149.0",
    git: null,
    match: {
      kind: "worktree-path",
      projectReplicaId: "replica",
      worktreeId: "tree",
    },
  },
  sync: {
    threadId: "external",
    status: "idle",
    turns: [
      {
        id: "turn",
        status: "completed",
        startedAt: 1,
        completedAt: 2,
        durationMs: 1000,
        items: [
          {
            type: "userMessage",
            id: "user",
            text: "User 😀 \ud800\u2029",
            externalAttachmentIds: [attachmentId],
          },
        ],
      },
    ],
  },
  attachments: [attachment],
});
const placement = {
  projectId: "project",
  workerId: "worker",
  projectReplicaId: "replica",
  worktreeId: "tree",
  surface: null,
};
const job = {
  id,
  projectId: "project",
  chatId: null,
  sourceKind: "chatgpt-codex",
  sourceWorkerId: "worker",
  sourceId: "b".repeat(64),
  sourceThreadId: "external",
  targetPlacement: placement,
  managedThreadId: null,
  targetModelRouteId: null,
  targetProviderAccountId: null,
  state: "queued",
  stateRevision: 1,
  idempotencyKey: "key",
  attempt: 0,
  progress: { stage: "queued", percent: 0, updatedAt: stamp },
  error: null,
  sourceMetadata: null,
  attachmentCount: 0,
  attachmentWarningCount: 0,
  createdAt: stamp,
  updatedAt: stamp,
  startedAt: null,
  completedAt: null,
};
const selection = {
  sourceKind: "chatgpt-codex",
  sourceWorkerId: "worker",
  sourceId: "b".repeat(64),
  sourceThreadId: "external",
  idempotencyKey: "key",
};
const samples = {
  chatImportJobSummarySchema: [job],
  chatImportJobListSchema: [[job]],
  chatImportCreateSchema: [{ imports: [selection] }],
  chatImportJobRetrySchema: [{ stateRevision: 1 }],
  externalChatImportReferenceSchema: [
    { jobId: id, projectId: "project", chatId: null, state: "queued" },
  ],
  externalChatAttachmentSchema: [attachment],
  externalChatTranscriptSchema: [transcript],
  externalChatReadWorkerResultSchema: [{ transcript }],
  externalChatAttachmentReadResultSchema: [
    { status: "unavailable", reasonCode: "changed" },
    {
      status: "available",
      sizeBytes: 128,
      chunk: {
        sequence: 0,
        plaintextBytes: 128,
        eof: true,
        envelope: label("chat").protectedLabel.envelope,
      },
    },
  ],
  externalChatDiscoveryWorkerResultSchema: [{ sources: [], truncated: false }],
  projectExternalChatDiscoverySchema: [
    {
      projectId: "project",
      observedAt: stamp,
      partial: false,
      truncated: false,
      workers: [],
    },
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
if (name === "externalChatAttachmentSchema")
  for (const status of ["available", "missing", "unsafe", "unsupported"])
    for (const sizeBytes of [0, 1, 128])
      add({ ...attachment, status, sizeBytes });
if (
  name === "externalChatTranscriptSchema" ||
  name === "externalChatReadWorkerResultSchema"
) {
  const addTranscript = (value) =>
    add(
      name === "externalChatReadWorkerResultSchema"
        ? { transcript: value }
        : value,
    );
  const mutate = (fn) => {
    const value = structuredClone(transcript);
    fn(value);
    addTranscript(value);
  };
  mutate((v) => {
    v.titleProtection = label("project");
  });
  mutate((v) => {
    v.attachments.push(structuredClone(v.attachments[0]));
  });
  mutate((v) => {
    v.attachments[0].sizeBytes = 0;
  });
  mutate((v) => {
    v.sync.turns[0].items[0].externalAttachmentIds.push(attachmentId);
  });
  mutate((v) => {
    v.sync.turns[0].items.push({
      ...structuredClone(v.sync.turns[0].items[0]),
      id: "another-user",
    });
  });
  mutate((v) => {
    v.attachments[0].itemId = "other";
  });
  mutate((v) => {
    v.attachments = [];
  });
  mutate((v) => {
    v.sync.turns[0].items[0].externalAttachmentIds = [];
  });
  mutate((v) => {
    v.titleProtection = label("project");
    v.attachments.push(structuredClone(v.attachments[0]));
    v.sync.turns[0].items[0].externalAttachmentIds.push(attachmentId);
    v.attachments[0].itemId = "other";
  });
  mutate((v) => {
    v.attachments = Array.from({ length: 21 }, () =>
      structuredClone(attachment),
    );
  });
  mutate((v) => {
    v.sync.turns[0].items[0].text = "";
  });
  mutate((v) => {
    v.sync.turns[0].items[0].externalAttachmentIds = [null];
  });
}
if (name === "chatImportCreateSchema")
  for (const count of [0, 1, 50, 51])
    add({ imports: Array.from({ length: count }, () => selection) });
if (name === "chatImportJobListSchema")
  for (const count of [0, 1000, 1001])
    add(Array.from({ length: count }, () => job));
console.log(JSON.stringify({ schema: name, cases }));
