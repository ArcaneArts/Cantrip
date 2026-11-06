import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { eventually } from "./full-worker.mjs";

export function completedSessionCommand() {
  return {
    cmd: "printf 'DURABLE_TOOL_RESULT\\n' | tee -a durable-cold-marker; while [ ! -e durable-session-release ]; do sleep 0.05; done; printf 'DURABLE_SESSION_TAIL\\n'; printf 'done\\n' > durable-session-complete",
    yield_time_ms: 1000,
    max_output_tokens: 1000,
  };
}

export function retainedSuspensionSession(boundary) {
  const outputs = boundary.request.input.input.filter(
    (item) =>
      item.type === "function_call_output" &&
      item.call_id === "task-fixture-response-0-call-0",
  );
  assert.equal(outputs.length, 1);
  const match = JSON.stringify(outputs[0].output).match(/session ID (\d+)/i);
  assert.ok(match, JSON.stringify(outputs[0]));
  return { sessionId: Number(match[1]), pollCallId: null };
}

export async function completeSuspensionSession(directory) {
  await writeFile(path.join(directory, "durable-session-release"), "release\n");
  await eventually(
    async () =>
      readFile(path.join(directory, "durable-session-complete"), "utf8").catch(
        (error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      ),
    (value) => assert.equal(value, "done\n"),
  );
}

export async function completedSuspensionSession(boundary, directory) {
  const session = retainedSuspensionSession(boundary);
  await completeSuspensionSession(directory);
  return session;
}

export function completedSessionPoll(model, tools, session) {
  const command = tools.find(
    (tool) =>
      tool.name === "write_stdin" || tool.name.endsWith("__write_stdin"),
  );
  assert.ok(command, "The actual native runtime advertises write_stdin");
  const next = model.reply({
    text: "DURABLE_SESSION_POLL",
    calls: [
      {
        ...command,
        arguments: {
          session_id: session.sessionId,
          chars: "",
          yield_time_ms: 1000,
          max_output_tokens: 1000,
        },
      },
    ],
  });
  const afterPoll = model.reply({ text: "DURABLE_BOUNDARY_TWO", hold: true });
  return { next, afterPoll };
}

export function assertCompletedSessionResult(items, session) {
  const outputs = items.filter(
    (item) =>
      item.type === "function_call_output" &&
      item.call_id === session.pollCallId,
  );
  assert.equal(
    outputs.length,
    1,
    "The restored session poll result occurs once",
  );
  const output = JSON.stringify(outputs[0].output);
  assert.match(output, /Process exited with code 0/);
  assert.equal(output.split("DURABLE_SESSION_TAIL").length - 1, 1);
  assert.equal(
    output.includes("DURABLE_TOOL_RESULT"),
    false,
    "Previously drained terminal output is not repeated",
  );
}

export async function observeCompletedSessionPoll(afterPoll, session) {
  await eventually(
    () => afterPoll.entered,
    (value) => assert.equal(value, true),
  );
  const calls = afterPoll.request.input.input.filter(
    (item) =>
      item.type === "function_call" && item.name.endsWith("write_stdin"),
  );
  assert.equal(calls.length, 1);
  session.pollCallId = calls[0].call_id;
  assertCompletedSessionResult(afterPoll.request.input.input, session);
  session.restored = true;
}
