import { spawn } from "node:child_process";

// The just-built native executable holds a kernel file lock until this pipe
// closes. Killing a development process cannot leave a stale lock directory.
export async function withInstallationLock(binary, lockPath, action) {
  const child = spawn(binary, ["--installation-lock", lockPath], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  child.stdin.on("error", () => {});
  const closed = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error("CUA installation lock helper did not respond.")),
        10_000,
      );
      const finish = (error) => {
        clearTimeout(timer);
        child.off("error", onError);
        child.off("close", onClose);
        child.stdout.off("data", onData);
        error ? reject(error) : resolve();
      };
      const onError = () =>
        finish(new Error("Could not launch the CUA installation lock helper."));
      const onClose = () =>
        finish(
          new Error(
            "Could not lock the CUA installation; another build may be installing this profile.",
          ),
        );
      const onData = (bytes) =>
        finish(
          bytes.length === 1 && bytes[0] === 1
            ? null
            : new Error("Invalid CUA installation lock response."),
        );
      child.once("error", onError);
      child.once("close", onClose);
      child.stdout.once("data", onData);
    });
    return await action();
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    await closed;
    clearTimeout(timer);
  }
}
