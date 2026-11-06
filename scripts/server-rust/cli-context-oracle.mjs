// Execute actual Source CLI and catalog functions with controlled repository
// views. HTTP/database/worker acceptance is a separate required qualification.
import { createCliOperationRuntime } from "../../cantrip_server/src/app/runtime/cli-operation-runtime.ts";
import { ExecutionLaneConflictError } from "../../cantrip_server/src/db/repository/chat-execution-lanes.ts";
import {
  selectExactExecutionTarget,
  selectExplicitExecutionTarget,
  selectExecutionTarget,
} from "../../cantrip_server/src/execution-targets/catalog.ts";
import { cantripCliCommandNameSchema } from "../../packages/protocol/dist/cantrip-cli.js";
import {
  requiredToolString,
  optionalToolString,
} from "../../cantrip_server/src/http/request-helpers.ts";

const chat = (extra = {}) => ({
  contextKind: "project",
  chatId: "chat",
  projectId: "project",
  workerId: "worker",
  worktreeId: "tree",
  executionLaneId: "lane",
  rootKind: "git-worktree",
  worktreeMode: "agent-managed",
  permissionProfileId: ":workspace",
  defaultPermissionProfileId: null,
  nativePermissionPolicy: null,
  nativePermissionPolicyConfirmed: false,
  isPrimary: false,
  worktreePolicy: "agent-managed",
  status: "running",
  ...extra,
});
const root = (path, extra = {}) => ({
  projectId: "project",
  workerId: "worker",
  worktreeId: "tree",
  rootKind: "git-worktree",
  sourcePath: path,
  worktreePath: path,
  ...extra,
});
const call = (extra = {}) => ({
  command: "status",
  context: {
    selection: "auto",
    cwd: null,
    codexThreadId: null,
    terminalId: null,
  },
  chatContext: null,
  workerId: "worker",
  requestId: "cli-oracle",
  arguments: {},
  ...extra,
});
function failure(error) {
  return {
    status:
      error instanceof ExecutionLaneConflictError ? 409 : (error.status ?? 400),
    code:
      error instanceof ExecutionLaneConflictError
        ? "conflict"
        : (error.code ?? "invalid"),
    error: error.message,
  };
}
async function execute(input) {
  const calls = [],
    views = input.views;
  const read = async (method, id, value) => {
    calls.push({ method, id });
    if (views.errors?.[method]) throw new Error(views.errors[method]);
    return value;
  };
  const runtime = createCliOperationRuntime({
    applicationOwnerId: () => "owner",
    bridge: { isConnected: () => true },
    agentOperationExecutor: {
      execute: async (context, request) => ({
        summary: "Selected CLI context.",
        data: { context, request },
      }),
    },
    chatOperationContext: sourceChatContext,
    repository: {
      getChatExecutionContext: async (_owner, id) =>
        read("chat", id, views.chats?.[id] ?? null),
      listChatExecutionContextsByThreadId: async (_owner, worker, thread) =>
        read("thread", [worker, thread], views.threads ?? []),
      getTerminalExecutionContext: async (_owner, id) =>
        read("terminal", id, views.terminal ?? null),
      listWorkerExecutionRootContexts: async (_owner, worker, limit) =>
        read("roots", [worker, limit], views.roots ?? []),
      getWorker: async () => ({ workerId: "worker", name: "Worker" }),
      getProject: async () => ({ capabilities: { worktrees: true } }),
      listProjectWorktrees: async () => views.worktrees ?? [],
      resolveExecutionTargetSelector: async () => ({
        outcome: "selected",
        target: {
          kind: "surface",
          projectId: "project",
          surfaceKind: "explorer",
          surfaceId: "explorer",
        },
      }),
    },
  });
  let outcome;
  try {
    const result = await runtime.executeCliCommand(input.call);
    outcome = {
      ok:
        input.kind === "scope"
          ? result.data.context
          : input.kind === "branch"
            ? result.data.request.arguments.branch
            : result.data.request.arguments.worktreeId,
    };
  } catch (error) {
    outcome = { failure: failure(error) };
  }
  calls.sort((a, b) => a.method.localeCompare(b.method));
  return { ...input, outcome, calls };
}
// The authoritative conversion has no DB/transport dependencies at execution.
import { createAgentOperationRuntime } from "../../cantrip_server/src/app/runtime/agent-operation-runtime.ts";
const { chatOperationContext: sourceChatContext } = createAgentOperationRuntime(
  {},
);
const cases = [];
for (const cwd of [
  null,
  "/src",
  "/src/file",
  "/src//",
  "/src/sub/file",
  "/src/submarine",
  "/SRC/file",
  "/",
  "relative",
  "C:\\Work\\File",
  "c:/work/file",
  "C:/Work/../outside",
  "/src/\ud800",
  "/src/�",
  "/src/\u0000",
  "C:/İ/Σ",
  "c:/i̇/ς",
])
  for (const selection of ["auto", "cwd", "lane"])
    for (const command of ["status", "policy.list", "explorer.write"])
      for (const attached of [null, "chat"]) {
        const input = call({
          command,
          context: { ...call().context, cwd, selection },
          chatContext: attached
            ? { chatId: attached, executionLaneId: "lane" }
            : null,
        });
        cases.push(
          await execute({
            kind: "scope",
            call: input,
            views: {
              chats: { chat: chat() },
              roots: [
                root("/src"),
                root("/src/sub", {
                  worktreeId: "nested",
                  projectId: "nested-project",
                }),
                root("C:/Work", { worktreeId: "windows" }),
                root("C:/İ/Σ", { worktreeId: "unicode-windows" }),
              ],
            },
          }),
        );
      }
for (const variant of [
  "missing",
  "stale lane",
  "wrong worker",
  "idle",
  "approval",
  "standalone",
  "thread",
  "ambiguous thread",
  "terminal",
  "linked",
  "linked mismatch",
  "foreign terminal",
  "duplicate roots",
  "chat error",
  "roots error",
  "both error",
])
  for (const selection of ["auto", "cwd", "lane"]) {
    const c = chat(),
      views = { chats: { chat: c }, roots: [root("/src")] };
    const input = call({
      context: { ...call().context, cwd: "/src/file", selection },
      chatContext: { chatId: "chat", executionLaneId: "lane" },
    });
    if (variant === "missing") views.chats = {};
    if (variant === "stale lane") input.chatContext.executionLaneId = "old";
    if (variant === "wrong worker") c.workerId = "foreign";
    if (variant === "idle") c.status = "idle";
    if (variant === "approval") c.status = "waiting-for-approval";
    if (variant === "standalone")
      Object.assign(c, {
        contextKind: "standalone",
        projectId: null,
        worktreeId: null,
        rootKind: null,
        scratchRootId: "scratch",
      });
    if (variant.includes("thread")) {
      input.chatContext = null;
      input.context.codexThreadId = "thread";
      views.threads = variant.startsWith("ambiguous")
        ? [c, chat({ chatId: "other" })]
        : [c];
    }
    if (
      ["terminal", "linked", "linked mismatch", "foreign terminal"].includes(
        variant,
      )
    ) {
      input.chatContext = null;
      input.context.terminalId = "terminal";
      views.terminal = {
        terminalId: "terminal",
        projectId: "project",
        workerId: variant === "foreign terminal" ? "foreign" : "worker",
        worktreeId: "tree",
        rootKind: "git-worktree",
        linkedChatId: variant.startsWith("linked") ? "chat" : null,
      };
      if (variant === "linked mismatch") c.worktreeId = "other";
    }
    if (variant === "duplicate roots")
      views.roots.push(root("/src/", { worktreeId: "other" }));
    if (variant.includes("error"))
      views.errors = {
        ...(variant !== "roots error"
          ? { chat: "Controlled chat read failed." }
          : {}),
        ...(variant !== "chat error"
          ? { roots: "Controlled root read failed." }
          : {}),
      };
    cases.push(await execute({ kind: "scope", call: input, views, variant }));
  }
const worktrees = [
  { id: "tree", name: "Primary", branch: "main" },
  { id: "alpha-one", name: "Café Σ", branch: "feature/ABC" },
  { id: "alpha-two", name: "Second", branch: "other" },
  { id: "emoji-😀-id", name: "Private \ud800 label", branch: null },
];
for (const selector of [
  null,
  "",
  " ",
  "tree",
  "PRIMARY",
  "café σ",
  "CAFÉ Σ",
  "feature/abc",
  "alpha",
  "alpha-one",
  "unknown",
  "Private \ud800 label",
  "emoji-😀",
  4,
  false,
  {},
  [],
]) {
  const input = call({
    command: "worktree.status",
    chatContext: { chatId: "chat", executionLaneId: "lane" },
    arguments: { worktree: selector },
  });
  cases.push(
    await execute({
      kind: "worktree",
      call: input,
      views: { chats: { chat: chat() }, worktrees },
    }),
  );
}
for (const name of [
  "Fix Café",
  "Ångström Σ",
  "İstanbul",
  "😀",
  "\ud800",
  " ._ ",
  "a".repeat(47) + " -- xx",
  "Ｆｉｘ ①",
  "ﬃ",
  "X\ud800Y",
])
  for (const collisions of [0, 1, 4, 999]) {
    const base = name
      .normalize("NFKD")
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 48);
    const prefix = `cantrip/${base || "worktree"}`;
    const worktrees = Array.from({ length: collisions }, (_, i) => ({
      id: `prior-${i}`,
      name: "Existing",
      branch: i === 0 ? prefix : `${prefix}-${i + 1}`,
    }));
    cases.push(
      await execute({
        kind: "branch",
        call: call({
          command: "worktree.create",
          chatContext: { chatId: "chat", executionLaneId: "lane" },
          arguments: { name, intent: "newBranch" },
        }),
        views: { chats: { chat: chat() }, worktrees },
      }),
    );
  }
const candidates = [
  {
    target: { kind: "worktree", projectId: "project", worktreeId: "tree" },
    resourceKind: "worktree",
    title: "Primary",
    availability: "available",
    placement: { workerId: "worker", worktreeId: "tree" },
  },
  {
    target: {
      kind: "surface",
      projectId: "project",
      surfaceKind: "terminal",
      surfaceId: "terminal-one",
    },
    resourceKind: "terminal",
    title: "Café Σ",
    availability: "available",
    placement: { workerId: "worker", worktreeId: "tree" },
  },
  {
    target: {
      kind: "surface",
      projectId: "project",
      surfaceKind: "terminal",
      surfaceId: "terminal-two",
    },
    resourceKind: "terminal",
    title: "Private \ud800 title",
    availability: "worker-offline",
    placement: { workerId: "other", worktreeId: "other" },
  },
];
const targets = [];
for (const selection of [
  null,
  "tree",
  "TREE",
  "terminal",
  "terminal-two",
  "café σ",
  "private \ud800",
  "",
  "unknown",
])
  for (const resourceKind of [
    null,
    "terminal",
    "worktree",
    "worker",
    "browser",
  ])
    for (const subset of [
      [],
      candidates.slice(0, 1),
      candidates,
      [
        ...candidates,
        {
          ...candidates[1],
          target: { ...candidates[1].target, surfaceId: "terminal-duplicate" },
        },
      ],
    ]) {
      const input = {
        selector: selection,
        resourceKind,
        currentTerminalId: "terminal-two",
        currentWorkerId: "worker",
        currentWorktreeId: "tree",
      };
      targets.push({
        candidates: subset,
        input,
        outcome: selectExecutionTarget(subset, input),
        ...(selection !== null
          ? {
              exact: selectExactExecutionTarget(subset, selection),
              explicit: selectExplicitExecutionTarget(subset, selection),
            }
          : {}),
      });
    }
const strings = [];
for (const value of [
  undefined,
  null,
  "",
  " \ufeff ",
  " private \ud800 ",
  0,
  true,
  [],
  {},
]) {
  const args = value === undefined ? {} : { key: value },
    result = {};
  for (const [kind, fn] of [
    ["required", requiredToolString],
    ["optional", optionalToolString],
  ]) {
    try {
      result[kind] = { ok: fn(args, "key") };
    } catch (e) {
      result[kind] = { error: e.message };
    }
  }
  strings.push({ args, result });
}
const runtime = createCliOperationRuntime({});
process.stdout.write(
  JSON.stringify({
    cases,
    targets,
    strings,
    mutations: cantripCliCommandNameSchema.options.map((command) => ({
      command,
      mutation: runtime.cliCommandIsMutation(command),
    })),
  }),
);
