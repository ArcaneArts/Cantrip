import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

async function lifecycle(
  mode: "managed" | "standalone",
  signal: "SIGINT" | "SIGTERM",
) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(
        new URL("./fixtures/desktop-lifecycle.ts", import.meta.url),
      ),
      mode,
      signal,
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  let diagnostics = "";
  child.stdout.on("data", (chunk) => (diagnostics += String(chunk)));
  child.stderr.on("data", (chunk) => (diagnostics += String(chunk)));
  const events: { event: string; added?: Record<string, number> }[] = [];
  const completed = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = await new Promise<Record<string, number>>(
      (resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`Desktop client did not initialize: ${diagnostics}`),
            ),
          10000,
        );
        child.once("error", reject);
        child.once("exit", (code, signal) =>
          reject(
            new Error(
              `Desktop client exited (${code ?? signal}): ${diagnostics}`,
            ),
          ),
        );
        child.on("message", (message) => {
          const event = message as (typeof events)[number];
          events.push(event);
          if (event.event === "ready") resolve(event.added!);
        });
      },
    );
    clearTimeout(timer);
    timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    if (process.platform === "win32") child.send("terminate");
    else child.kill(signal);
    return { ...(await completed), ready, events, diagnostics };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await completed;
  }
}

describe("desktop automation process ownership", () => {
  it.each(["SIGINT", "SIGTERM"] as const)(
    "lets Cantrip finish %s shutdown while retaining the session exit cleanup",
    async (signal) => {
      const result = await lifecycle("managed", signal);
      expect(result.code, result.diagnostics).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.events.map(({ event }) => event)).toContain(
        "host-shutdown-completed",
      );
      expect(result.ready).toEqual({ exit: 1, SIGINT: 0, SIGTERM: 0 });
    },
  );

  it.each(["SIGINT", "SIGTERM"] as const)(
    "preserves the library's standalone %s behavior by default",
    async (signal) => {
      const result = await lifecycle("standalone", signal);
      expect(result.code, result.diagnostics).toBe(
        signal === "SIGINT" ? 130 : 143,
      );
      expect(result.signal).toBeNull();
      expect(result.events.map(({ event }) => event)).not.toContain(
        "host-shutdown-completed",
      );
      expect(result.ready).toEqual({ exit: 1, SIGINT: 1, SIGTERM: 1 });
    },
  );
});
