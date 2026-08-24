import { spawn } from "node:child_process";

import type * as pty from "node-pty";

const DEFAULT_TASKKILL_TIMEOUT_MS = 2_000;

export type RunConfigurationProcessTreeChild = Pick<pty.IPty, "kill" | "pid">;

interface TaskkillProcess {
  kill(): boolean;
  once(event: "error", listener: (error: Error) => void): TaskkillProcess;
  once(event: "exit", listener: (code: number | null) => void): TaskkillProcess;
}

export interface RunConfigurationProcessTreeControllerOptions {
  killProcessGroup?(pid: number, signal: NodeJS.Signals): void;
  platform?: NodeJS.Platform;
  spawnTaskkill?(arguments_: string[]): TaskkillProcess;
  taskkillTimeoutMs?: number;
}

function spawnTaskkill(arguments_: string[]): TaskkillProcess {
  return spawn("taskkill", arguments_, {
    stdio: "ignore",
    windowsHide: true,
  });
}

export class RunConfigurationProcessTreeController {
  readonly #killProcessGroup: NonNullable<
    RunConfigurationProcessTreeControllerOptions["killProcessGroup"]
  >;
  readonly #platform: NodeJS.Platform;
  readonly #spawnTaskkill: NonNullable<
    RunConfigurationProcessTreeControllerOptions["spawnTaskkill"]
  >;
  readonly #taskkillTimeoutMs: number;

  constructor(options: RunConfigurationProcessTreeControllerOptions = {}) {
    this.#killProcessGroup =
      options.killProcessGroup ??
      ((pid, signal) => {
        process.kill(-pid, signal);
      });
    this.#platform = options.platform ?? process.platform;
    this.#spawnTaskkill = options.spawnTaskkill ?? spawnTaskkill;
    this.#taskkillTimeoutMs =
      options.taskkillTimeoutMs ?? DEFAULT_TASKKILL_TIMEOUT_MS;
  }

  async signal(
    child: RunConfigurationProcessTreeChild,
    force: boolean,
  ): Promise<void> {
    if (this.#platform === "win32") {
      const signaled = await this.#signalWindowsProcessTree(child, force);
      if (!signaled) this.#killChild(child);
      return;
    }

    const signal: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";
    try {
      this.#killProcessGroup(child.pid, signal);
    } catch {
      this.#killChild(child, signal);
    }
  }

  #killChild(
    child: RunConfigurationProcessTreeChild,
    signal?: NodeJS.Signals,
  ): void {
    try {
      child.kill(signal);
    } catch {
      // The process may already have exited while the tree was being signaled.
    }
  }

  async #signalWindowsProcessTree(
    child: RunConfigurationProcessTreeChild,
    force: boolean,
  ): Promise<boolean> {
    const arguments_ = ["/PID", String(child.pid), "/T"];
    if (force) arguments_.push("/F");

    let taskkill: TaskkillProcess;
    try {
      taskkill = this.#spawnTaskkill(arguments_);
    } catch {
      return false;
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (succeeded: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(succeeded);
      };
      const timer = setTimeout(() => {
        try {
          taskkill.kill();
        } catch {
          // The helper may have exited at the same instant as the timeout.
        }
        finish(false);
      }, this.#taskkillTimeoutMs);
      timer.unref();
      taskkill.once("error", () => finish(false));
      taskkill.once("exit", (code) => finish(code === 0));
    });
  }
}
