// Explicit, development-only crash capture. The actual fixture protocol,
// requested stack size, database, operations and assertions are unchanged.
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { repositoryRoot } from "./build.mjs";
export async function repositoryDebugger(executable, args) {
  const debuggerPath = process.env.CANTRIP_FIXTURE_GDB;
  if (!debuggerPath) return { command: executable, args };
  const directory = path.join(repositoryRoot, ".qa/rust-server/native-stack");
  await mkdir(directory, { recursive: true });
  const log = path.join(directory, randomUUID() + ".log").replaceAll("\\", "/");
  return {
    command: debuggerPath,
    args: [
      "--batch",
      "--quiet",
      "--nx",
      "--return-child-result",
      "-ex",
      "set pagination off",
      "-ex",
      "set confirm off",
      "-ex",
      "set print thread-events off",
      "-ex",
      "set logging file " + log,
      "-ex",
      "set logging overwrite on",
      "-ex",
      "set logging redirect on",
      "-ex",
      "set logging enabled on",
      "-ex",
      "run",
      "-ex",
      "thread apply all bt 80",
      "-ex",
      "python exec(" +
        JSON.stringify(`import gdb
frame = gdb.newest_frame()
previous = None
previous_name = None
for index in range(80):
    if frame is None:
        break
    try:
        address = int(frame.read_register('rsp'))
        if previous is not None:
            print('NATIVE_STACK_FRAME bytes=%d sp=0x%x function=%s' % (address-previous, previous, previous_name))
        previous = address
        previous_name = frame.name()
        frame = frame.older()
    except Exception as error:
        print('NATIVE_STACK_FRAME unavailable: %s' % error)
        break
`) +
        ")",
      "-ex",
      "info registers",
      "--args",
      executable,
      ...args,
    ],
  };
}
