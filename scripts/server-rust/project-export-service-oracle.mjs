// Invoke the actual Source service and route handlers. Only repository/worker
// boundaries are controlled here; the real-socket suite qualifies integration.
import assert from "node:assert/strict";
import {
  exportCanonicalChat,
  projectExportTargetDefinition,
} from "../../cantrip_server/src/project-exports/service.ts";
import { installProjectExportRoutes } from "../../cantrip_server/src/app/routes/project-exports.ts";
import { projectExportChatResultSchema } from "../../packages/protocol/dist/index.js";
import { label } from "./project-target-state.mjs";
const target = { kind: "codex-local" },
  operationId = "33333333-3333-4333-8333-000000000001";
const chat = {
  chatId: "chat",
  threadId: "exported-thread",
  destinationLabel: "Codex home",
  messageCount: 1,
  reused: false,
};
const input = (
  payload = {
    version: 1,
    kind: "chat-encrypted",
    messages: [],
    attachments: [],
  },
) => ({
  operationId,
  target,
  workerId: "worker",
  chatId: "chat",
  cwd: "/project",
  titleProtection: label("chat"),
  payload,
});
const fixtures = [{ input: input() }];
for (const size of [262143, 262144, 262145, 524288, 524289]) {
  const payload = {
    version: 1,
    kind: "chat-encrypted",
    messages: [],
    attachments: [],
    opaque: "",
  };
  payload.opaque = "A".repeat(
    size - Buffer.byteLength(JSON.stringify(payload)),
  );
  fixtures.push({ input: input(payload) });
}
fixtures.push({
  input: input({
    version: 1,
    kind: "chat-encrypted",
    messages: [],
    attachments: [],
    opaque: { "😀": "\ud800\u2028", "\uffff": "last", 2: -0, 1: 1e21, e: 1e-7 },
  }),
});
for (const begin of [
  { ...chat, status: "exported", reused: true },
  { ...chat, status: "exported", reused: false },
  { status: "upload", extra: true },
  null,
  {},
])
  fixtures.push({
    input: input(),
    responses: { "project.export.chat.begin": begin },
  });
for (const complete of [
  { ...chat, chatId: "worker-chosen-chat" },
  { ...chat, extra: true },
  { ...chat, messageCount: -1 },
  {},
  null,
])
  fixtures.push({
    input: input(),
    responses: { "project.export.chat.complete": complete },
  });
fixtures.push({
  input: input(),
  responses: { "project.export.chat.chunk": { arbitrary: [null, 1] } },
});
for (const failType of [
  "project.export.chat.begin",
  "project.export.chat.chunk",
  "project.export.chat.complete",
])
  fixtures.push({
    input: input(),
    failType,
    failureMessage: "Controlled \ud800 😀 failure",
  });
fixtures.push(
  { input: input(), omit: "project.export.chat.begin" },
  { input: input(), omit: "project.export.chat.complete" },
);
const relays = [];
for (const fixture of fixtures) {
  const trace = [];
  const bridge = {
    async request(worker, command, options) {
      trace.push({ worker, command, deadlineMs: options.timeoutMs });
      if (fixture.failType === command.type)
        throw new Error(fixture.failureMessage);
      if (fixture.omit === command.type) return undefined;
      if (fixture.responses && Object.hasOwn(fixture.responses, command.type))
        return fixture.responses[command.type];
      if (command.type === "project.export.chat.begin")
        return { status: "upload" };
      if (command.type === "project.export.chat.chunk") return null;
      if (command.type === "project.export.chat.complete") return chat;
      throw new Error("Unexpected command");
    },
  };
  let outcome;
  try {
    outcome = {
      value: await exportCanonicalChat({ ...fixture.input, bridge }),
    };
  } catch (error) {
    outcome = { error: error.message };
  }
  relays.push({ fixture, outcome, trace });
}
const handlers = new Map();
let failure;
installProjectExportRoutes(
  {
    post(route, handler) {
      handlers.set(route, handler);
    },
  },
  {
    applicationOwnerId: () => "owner",
    bridge: {
      isConnected: () => true,
      request: async () => {
        throw failure;
      },
    },
    repository: {
      async getProjectWorktreeContext() {
        return {
          workerId: "worker",
          worktree: { id: "tree", path: "/project" },
        };
      },
      async listWorkers() {
        return [
          {
            workerId: "worker",
            name: "Worker",
            platform: "linux",
            online: true,
            externalCodexHistory: true,
          },
        ];
      },
      async listChats() {
        return [
          {
            id: "chat",
            experience: "agent",
            status: "idle",
            titleProtection: label("chat"),
          },
        ];
      },
      async listEncryptedMessages() {
        return [];
      },
    },
  },
);
const phrases = [
  "encrypt",
  "decrypt",
  "key revision",
  "private label",
  "external codex home",
  "export target",
  "worktree",
  "worker is offline",
  "codex",
  "thread/start",
  "thread/inject_items",
  "thread/read",
  "thread/name",
  "runtime",
];
const messages = [
  "",
  "plain failure",
  "x".repeat(1999) + "😀encrypt",
  "\ud800".repeat(2001),
  "x".repeat(2000) + "encrypt",
  "ENCRİPT",
  "worKer iſ offline",
];
for (const phrase of phrases)
  for (const form of [
    phrase,
    phrase.toUpperCase(),
    phrase.replaceAll("s", "ſ").replaceAll("k", "K"),
  ])
    for (const prefix of ["", "\ud800 😀 ", "x".repeat(2000)])
      messages.push(prefix + form);
for (const left of phrases)
  for (const right of phrases) messages.push(left + " / " + right);
const errors = [];
for (const message of messages) {
  failure = new Error(message);
  let result;
  const reply = {
    code() {
      return this;
    },
    send(value) {
      result = value;
      return value;
    },
  };
  await handlers.get("/api/projects/:projectId/exports")(
    {
      body: { operationId, target, worktreeId: "tree", chatIds: ["chat"] },
      params: { projectId: "project" },
    },
    reply,
  );
  assert.equal(result.outcomes.length, 1);
  errors.push({ message, outcome: result.outcomes[0] });
}
const invalid = projectExportChatResultSchema.safeParse({});
assert.equal(invalid.success, false);
console.log(
  JSON.stringify({
    relays,
    errors,
    definition: projectExportTargetDefinition(target),
  }),
);
