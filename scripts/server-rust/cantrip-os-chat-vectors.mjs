import * as protocol from "../../packages/protocol/dist/index.js";
import commands from "./worker-command-fixtures.json" with { type: "json" };
import { osDispatchFixtures } from "./cantrip-os-dispatch-fixtures.mjs";
import { fileDocumentWireFixtures } from "./file-document-wire-fixtures.mjs";
import { projectChatWireFixtures } from "./project-chat-wire-fixtures.mjs";
const os = osDispatchFixtures().cantripOsExecutionSchema[0];
const original = commands.commands.find(
  (item) => item.type === "chat.turn",
).input;
const turn = {
  ...original,
  command: {
    ...original.command,
    executionProfile: "cantrip-os",
    osExecution: os,
    cwd: os.scope.guestPath,
    worktreeId: os.scope.worktreeId,
    policyProjectId: os.scope.projectId,
    rootKind: "git-worktree",
  },
};
delete turn.command.computerUseAuthority;
const cases = [];
function add(schema, input) {
  const result = protocol[schema].safeParse(input);
  cases.push({
    schema,
    input,
    outcome: result.success
      ? { ok: result.data }
      : { issues: result.error.issues },
  });
}
add("workerRequestEnvelopeSchema", turn);
for (const override of [
  { executionProfile: "ide" },
  { osExecution: undefined },
  { cwd: "/host/source" },
  { worktreeId: "wrong" },
  { policyProjectId: "wrong" },
  { rootKind: "folder-root" },
])
  add("workerRequestEnvelopeSchema", {
    ...turn,
    command: { ...turn.command, ...override },
  });
add("workerRequestEnvelopeSchema", {
  ...turn,
  command: {
    ...turn.command,
    osExecution: osDispatchFixtures().cantripOsExecutionSchema[1],
  },
});
for (const input of projectChatWireFixtures(
  "2026-11-04T00:00:00.000Z",
).encryptedChatCreateSchema.filter((v) => v.cantripOsBindingId))
  add("encryptedChatCreateSchema", input);
for (const type of [
  "explorer.operation",
  "file-document.operation",
  "terminal.open",
  "project.script-commands",
]) {
  const input = commands.commands.find((item) => item.type === type).input;
  for (const root of [
    os,
    "/host/source",
    { ...os, scope: { ...os.scope, runtimeGeneration: "bad" } },
  ])
    add("workerRequestEnvelopeSchema", {
      ...input,
      command: {
        ...input.command,
        ...(["terminal.open", "project.script-commands"].includes(type)
          ? { worktreePath: root }
          : { root }),
      },
    });
}
const file = fileDocumentWireFixtures().fileDocumentCreateSchema[0];
for (const placement of [
  {},
  { cantripOsBindingId: os.scope.bindingId },
  { cantripOsRuntimeGeneration: os.scope.runtimeGeneration },
  {
    cantripOsBindingId: os.scope.bindingId,
    cantripOsRuntimeGeneration: os.scope.runtimeGeneration,
  },
]) {
  add("fileDocumentCreateSchema", { ...file, ...placement });
  add("encryptedTerminalCreateSchema", {
    id: file.id,
    ...placement,
    titleProtection: {
      classification: { recordKind: "terminal" },
      protectedLabel: file.stateProtection.protectedState,
    },
    stateProtection: {
      classification: { recordKind: "terminal-state" },
      protectedState: file.stateProtection.protectedState,
    },
  });
  add("encryptedExplorerCreateSchema", {
    id: file.id,
    ...placement,
    titleProtection: {
      classification: { recordKind: "explorer" },
      protectedLabel: file.stateProtection.protectedState,
    },
    stateProtection: {
      classification: { recordKind: "explorer-state" },
      protectedState: file.stateProtection.protectedState,
    },
  });
}
if (!cases[0].outcome.ok) throw new Error(JSON.stringify(cases[0].outcome));
console.log(JSON.stringify(cases));
