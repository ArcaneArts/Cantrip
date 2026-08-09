import { spawn, type ChildProcess } from "node:child_process";

export interface GuardedProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

const GUARD_SOURCE = String.raw`
import { spawn } from "node:child_process";

const parentPid = Number(process.env.CANTRIP_GUARD_PARENT_PID);
const command = process.env.CANTRIP_GUARD_COMMAND;
const args = JSON.parse(process.env.CANTRIP_GUARD_ARGUMENTS ?? "[]");
const cwd = process.env.CANTRIP_GUARD_CWD;
const useShell = process.env.CANTRIP_GUARD_SHELL === "1";

if (!Number.isSafeInteger(parentPid) || parentPid <= 0 || !command || !cwd) {
  process.stderr.write("Cantrip Code process guard received invalid launch metadata.\n");
  process.exit(1);
}

const child = spawn(command, args, {
  cwd,
  detached: false,
  env: process.env,
  shell: useShell,
  stdio: "inherit",
  windowsHide: true,
});

let stopping = false;
let forceTimer;

const forceStop = () => {
  if (process.platform === "win32") {
    if (child.pid) {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      }).once("exit", () => process.exit(1));
      return;
    }
  } else {
    try {
      process.kill(-process.pid, "SIGKILL");
      return;
    } catch {}
  }
  process.exit(1);
};

const stopTree = (signal = "SIGTERM") => {
  if (stopping) return;
  stopping = true;
  if (process.platform === "win32") {
    if (child.pid) {
      spawn("taskkill", ["/PID", String(child.pid), "/T"], {
        stdio: "ignore",
        windowsHide: true,
      });
    }
  } else {
    try {
      process.kill(-process.pid, signal);
    } catch {
      child.kill(signal);
    }
  }
  forceTimer = setTimeout(forceStop, 2_000);
};

process.on("SIGINT", () => stopTree("SIGINT"));
process.on("SIGTERM", () => stopTree("SIGTERM"));
process.on("SIGHUP", () => stopTree("SIGHUP"));

child.once("error", (error) => {
  process.stderr.write(
    "Cantrip Code process guard could not launch the editor: " +
      error.message +
      "\\n",
  );
  process.exit(1);
});
child.once("exit", (code, signal) => {
  if (forceTimer) clearTimeout(forceTimer);
  process.exitCode = code ?? (signal ? 1 : 0);
});

const parentWatch = setInterval(() => {
  try {
    process.kill(parentPid, 0);
  } catch {
    clearInterval(parentWatch);
    stopTree("SIGTERM");
  }
}, 500);
parentWatch.unref();
`;

export function spawnGuardedProcess(
  command: string,
  args: string[],
  options: GuardedProcessOptions,
): ChildProcess {
  const useShell =
    process.platform === "win32" &&
    [".bat", ".cmd"].some((extension) =>
      command.toLowerCase().endsWith(extension),
    );
  return spawn(
    process.execPath,
    ["--input-type=module", "--eval", GUARD_SOURCE],
    {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: {
        ...options.env,
        CANTRIP_GUARD_ARGUMENTS: JSON.stringify(args),
        CANTRIP_GUARD_COMMAND: command,
        CANTRIP_GUARD_CWD: options.cwd,
        CANTRIP_GUARD_PARENT_PID: String(process.pid),
        CANTRIP_GUARD_SHELL: useShell ? "1" : "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
}
