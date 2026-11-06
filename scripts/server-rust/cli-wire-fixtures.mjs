import { cantripCliCommandNameSchema } from "../../packages/protocol/dist/cantrip-cli.js";
export function cliWireFixtures() {
  const base = { command: "status", context: {}, arguments: {} };
  const worker = { ...base, workerId: "worker", requestId: "cli-request" };
  const map = (length) =>
    Object.fromEntries(Array.from({ length }, (_, i) => [`argument${i}`, i]));
  return {
    cantripCliCommandNameSchema: [...cantripCliCommandNameSchema.options],
    cantripCliContextSchema: [
      {},
      { cwd: "/private/\ud800/path", selection: "cwd" },
      { terminalId: "terminal", codexThreadId: "thread", selection: "lane" },
    ],
    cantripCliCommandRequestSchema: [
      base,
      { ...base, command: "terminal.send", arguments: map(20) },
    ],
    workerCliCommandCallSchema: [
      worker,
      {
        ...worker,
        chatContext: { chatId: "chat", executionLaneId: "lane" },
        context: { cwd: "C:\\Private\\\ud800", selection: "auto" },
      },
      { ...worker, arguments: map(20) },
    ],
    cantripCliCommandResultSchema: [
      { summary: "Connected." },
      {
        summary: "Changed.",
        mutated: true,
        continuationScheduled: true,
        data: { original: "\ud800", missing: null },
      },
    ],
  };
}

export function* cliWireCases(name) {
  if (name === "cantripCliCommandNameSchema") {
    yield "worktree.acquire";
    yield "shell.run";
    return;
  }
  if (
    name !== "cantripCliCommandRequestSchema" &&
    name !== "workerCliCommandCallSchema"
  )
    return;
  const base = {
    command: "status",
    context: {},
    arguments: {},
    ...(name === "workerCliCommandCallSchema"
      ? { workerId: "worker", requestId: "cli-request" }
      : {}),
  };
  for (const count of [0, 19, 20, 21, 32, 33])
    yield {
      ...base,
      arguments: Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`argument${i}`, i]),
      ),
    };
  for (const key of [
    "",
    "k".repeat(100),
    "k".repeat(101),
    "\ud800",
    "\ufffd",
    "__proto__",
  ])
    yield { ...base, arguments: Object.fromEntries([[key, "value"]]) };
  for (const command of ["worktree.acquire", "shell.run", null, false])
    yield { ...base, command };
  for (const selection of ["auto", "cwd", "lane", "invalid", null])
    yield { ...base, context: { selection } };
  yield { ...base, context: { unknown: true } };
  yield { ...base, unknown: true };
}
