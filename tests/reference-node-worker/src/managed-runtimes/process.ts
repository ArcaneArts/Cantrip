import type { ChildProcess } from "node:child_process";

/** Retire an owned runtime child and observe exit before removing its files. */
export async function stopRuntimeProcess(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    timeout.unref();
    child.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
