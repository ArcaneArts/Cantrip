import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";

export interface GuardedProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  ownerPid?: number;
  stdin?: "ignore";
}

export interface PipedGuardedProcessOptions extends Omit<
  GuardedProcessOptions,
  "stdin"
> {
  stdin: "pipe";
}

const GUARD_SOURCE = String.raw`
import { spawn } from "node:child_process";

const parentPid = Number(process.env.CANTRIP_GUARD_PARENT_PID);
const command = process.env.CANTRIP_GUARD_COMMAND;
const args = JSON.parse(process.env.CANTRIP_GUARD_ARGUMENTS ?? "[]");
const cwd = process.env.CANTRIP_GUARD_CWD;
const useShell = process.env.CANTRIP_GUARD_SHELL === "1";

if (!Number.isSafeInteger(parentPid) || parentPid <= 0 || !command || !cwd) {
  process.stderr.write("Cantrip process guard received invalid launch metadata.\n");
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
let stopFailureReported = false;

const reportStopFailure = () => {
  if (stopFailureReported) return;
  stopFailureReported = true;
  process.stderr.write("Cantrip process guard is still waiting for subprocess termination.\n");
};

const forceStop = () => {
  if (process.platform === "win32") {
    if (child.pid) {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      let finished = false;
      const retry = () => {
        if (finished) return;
        finished = true;
        reportStopFailure();
        forceTimer = setTimeout(forceStop, 2_000);
      };
      killer.once("error", retry);
      killer.once("exit", (code) => {
        // The taskkill helper exiting is not proof that our subprocess exited.
        // Only the captured child's exit handler may retire this guard.
        if (code !== 0) retry();
      });
      return;
    }
  } else {
    try {
      process.kill(-process.pid, "SIGKILL");
      return;
    } catch {
      try { child.kill("SIGKILL"); } catch {}
      reportStopFailure();
      forceTimer = setTimeout(forceStop, 2_000);
      return;
    }
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
      }).once("error", reportStopFailure);
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

child.on("error", (error) => {
  // A failed launch has no child. A later signal error does not establish death.
  if (!child.pid) {
    process.stderr.write("Cantrip process guard could not launch the subprocess: " + error.message + "\n");
    process.exit(1);
  }
  reportStopFailure();
  stopTree();
});
child.once("exit", (code, signal) => {
  if (forceTimer) clearTimeout(forceTimer);
  process.exit(code ?? (stopping && signal ? 0 : 1));
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
  options: PipedGuardedProcessOptions,
): ChildProcessWithoutNullStreams;
export function spawnGuardedProcess(
  command: string,
  args: string[],
  options: GuardedProcessOptions,
): ChildProcess;
export function spawnGuardedProcess(
  command: string,
  args: string[],
  options: GuardedProcessOptions | PipedGuardedProcessOptions,
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
        CANTRIP_GUARD_PARENT_PID: String(options.ownerPid ?? process.pid),
        CANTRIP_GUARD_SHELL: useShell ? "1" : "0",
      },
      stdio: [options.stdin ?? "ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
}
