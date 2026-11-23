import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const selected = (event) =>
  [
    "chat.worktree.update.failed",
    "chat.compaction.started",
    "chat.compaction.completed",
  ].includes(event);
export function expectedControlLogs({
  path,
  observation,
  body,
  commands,
  before,
  mode,
}) {
  if (
    path.endsWith("/worktree") &&
    observation.status === 500 &&
    body.error ===
      "Could not update the agent worktree. Try again or reload the agent."
  )
    return [
      {
        level: "error",
        message: "Log event",
        context: {
          event: "chat.worktree.update.failed",
          chatId: path.split("/")[3],
          errorClass: "Error",
        },
      },
    ];
  const compact = commands.find((c) => c.type === "chat.compact");
  if (!compact) return [];
  const row = before.chats.find((c) => c.id === compact.chatId);
  const context = {
    subsystem: "chat-execution",
    operation: "compact",
    chatId: row.id,
    projectId: row.project_id,
    workerId: row.active_worker_id,
  };
  return [
    {
      level: "info",
      message: "Chat compaction started",
      context: {
        ...context,
        event: "chat.compaction.started",
        status: "running",
      },
    },
    ...(mode === "compact-error"
      ? []
      : [
          {
            level: "info",
            message: "Chat compaction completed",
            context: {
              ...context,
              event: "chat.compaction.completed",
              status: "completed",
              durationMs: "<verified nonnegative duration>",
            },
          },
        ]),
  ];
}

export async function readControlLogs(file) {
  const actual = [];
  // An ongoing capture may end in the middle of the last write.
  const lines = (await readFile(file, "utf8")).split("\n");
  lines.pop();
  for (const line of lines) {
    let record;
    if (line.startsWith("{")) {
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!selected(record.context?.event)) continue;
      assert.ok(Number.isFinite(Date.parse(record.timestamp)));
      record = {
        level: record.level,
        message: record.message,
        context: record.context,
      };
    } else {
      if (
        !/event=chat\.(?:compaction\.(?:started|completed)|worktree\.update\.failed)(?: |$)/.test(
          line,
        )
      )
        continue;
      const matched = line.match(
        /^\[server\] \d{2}:\d{2}: (?:(ERROR|WARN|DEBUG|TRACE) )?(.*?) · (.*)$/,
      );
      assert.ok(matched, "parse actual Source service-log presentation");
      const context = Object.fromEntries(
        matched[3].split(" ").map((item) => {
          const at = item.indexOf("=");
          assert.ok(at > 0);
          const value = item.slice(at + 1);
          return [
            item.slice(0, at),
            value === "null"
              ? null
              : /^\d+$/.test(value)
                ? Number(value)
                : value,
          ];
        }),
      );
      record = {
        level: matched[1]?.toLowerCase() ?? "info",
        message: matched[2],
        context,
      };
    }
    if (record.context.event === "chat.compaction.completed") {
      assert.ok(
        Number.isFinite(record.context.durationMs) &&
          record.context.durationMs >= 0,
        "actual compaction duration",
      );
      record.context.durationMs = "<verified nonnegative duration>";
    }
    actual.push(record);
  }
  return actual;
}
export async function verifyControlLogs(file, expected) {
  const actual = await readControlLogs(file);
  assert.deepEqual(
    actual,
    expected,
    "exact ordered control operational logs including completed-before-invalid-ack and absent completion on worker failure",
  );
  return actual;
}
