import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each(["healthy", "offline", "partial"])(
  "retires local authority and sockets with %s worker revocation during signal shutdown",
  async (mode) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cantrip-server-shutdown-"),
    );
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(
          new URL("./fixtures/server-shutdown.ts", import.meta.url),
        ),
        mode,
        directory,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          CANTRIP_SERVICE_LOG_DIR: path.join(directory, "logs"),
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    // Wait for stdio to drain as well, so fatal diagnostics cannot arrive after assertions.
    const exited = once(child, "close");
    const sockets: ReturnType<typeof createConnection>[] = [];
    try {
      await expect
        .poll(
          () => {
            if (child.exitCode !== null || child.signalCode !== null)
              throw new Error(
                `Fixture exited before startup: ${stdout}\n${stderr}`,
              );
            return stdout;
          },
          { timeout: 10_000 },
        )
        .toContain("CANTRIP_SHUTDOWN_READY:");
      const ready = JSON.parse(
        stdout.match(/CANTRIP_SHUTDOWN_READY:(.+)\n/u)![1]!,
      ) as { address: string; relayPorts: number[] };
      expect(await (await fetch(ready.address + "/ready")).json()).toEqual({
        transports: 2,
        sessionAttachments: 2,
      });
      const closed = [];
      for (const port of ready.relayPorts) {
        const socket = createConnection({ host: "127.0.0.1", port });
        sockets.push(socket);
        await once(socket, "connect");
        closed.push(
          new Promise<void>((resolve) => socket.once("close", () => resolve())),
        );
        socket.on("error", () => {}); // A reset during actual retirement also closes the socket.
      }
      if (process.platform === "win32") child.stdin.end("shutdown\n");
      else {
        child.stdin.end();
        child.kill("SIGTERM");
      }
      await expect
        .poll(() => child.exitCode, { timeout: 10_000 })
        .not.toBeNull();
      const [code, signal] = await exited;
      expect(signal).toBeNull();
      expect(code, stderr).toBe(mode === "healthy" ? 0 : 1);
      await Promise.all(closed);
      const state = JSON.parse(
        await readFile(path.join(directory, "closed.json"), "utf8"),
      );
      expect(state).toMatchObject({
        stats: { transports: 0, sessionAttachments: 0 },
        renewals: [null, null],
        managed: 0,
        cleaned: 2,
        listening: false,
        sockets: 0,
      });
      const revocations = state.attempts.filter((attempt: { type: string }) =>
        attempt.type.endsWith(".revoke"),
      );
      expect(revocations.length).toBeGreaterThan(0);
      expect(
        revocations.some(
          (attempt: { acknowledged: boolean }) => !attempt.acknowledged,
        ),
      ).toBe(mode !== "healthy");
      if (mode === "partial")
        expect(
          revocations.some(
            (attempt: { acknowledged: boolean }) => attempt.acknowledged,
          ),
        ).toBe(true);
      const logs = (
        await Promise.all(
          (await readdir(path.join(directory, "logs"))).map((filename) =>
            readFile(path.join(directory, "logs", filename), "utf8"),
          ),
        )
      ).join("\n");
      expect(logs, stderr).toContain(
        mode === "healthy"
          ? "server.shutdown.completed"
          : "server.shutdown.failed",
      );
      if (mode !== "healthy")
        expect(logs).not.toContain("server.shutdown.completed");
      expect(stderr).not.toContain("CANTRIP_SHUTDOWN_UNCAUGHT:");
      await expect(fetch(ready.address + "/ready")).rejects.toThrow();
    } finally {
      for (const socket of sockets) socket.destroy();
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited;
      await rm(directory, { recursive: true, force: true });
    }
  },
  25_000,
);
