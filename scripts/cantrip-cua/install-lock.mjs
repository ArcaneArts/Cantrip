import { spawn } from "node:child_process";

// The just-built native executable holds a kernel file lock until this pipe
// closes. Killing a development process cannot leave a stale lock directory.
export async function withInstallationLock(
  binary,
  lockPath,
  action,
  { spawnProcess = spawn } = {},
) {
  const child = spawnProcess(binary, ["--installation-lock", lockPath], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  const lifetime = new AbortController();
  let releasing = false;
  let acquired = false;
  child.stdin.on("error", () => {
    if (!releasing)
      lifetime.abort(new Error("CUA installation lock pipe failed."));
  });
  child.once("error", () =>
    lifetime.abort(
      new Error("Could not launch the CUA installation lock helper."),
    ),
  );
  const closed = new Promise((resolve) =>
    child.once("close", () => {
      if (!releasing)
        lifetime.abort(
          new Error(
            acquired
              ? "CUA installation lock was lost before replacement completed."
              : "Could not lock the CUA installation; another build may be installing this profile.",
          ),
        );
      resolve();
    }),
  );
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          lifetime.abort(
            new Error("CUA installation lock helper did not respond."),
          ),
        10_000,
      );
      const finish = (error) => {
        clearTimeout(timer);
        lifetime.signal.removeEventListener("abort", onAbort);
        child.stdout.off("data", onData);
        error ? reject(error) : resolve();
      };
      const onAbort = () => finish(lifetime.signal.reason);
      const onData = (bytes) => {
        if (bytes.length !== 1 || bytes[0] !== 1) {
          lifetime.abort(new Error("Invalid CUA installation lock response."));
          return;
        }
        acquired = true;
        finish();
      };
      lifetime.signal.addEventListener("abort", onAbort, { once: true });
      child.stdout.once("data", onData);
    });
    const result = await action(lifetime.signal);
    lifetime.signal.throwIfAborted();
    return result;
  } finally {
    releasing = true;
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    await closed;
    clearTimeout(timer);
  }
}
