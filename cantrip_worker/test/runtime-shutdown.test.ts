import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { stopRuntimeProcess } from "../src/managed-runtimes/process.js";

it.each(
  ["searxng", "playwright", "codegraph"].flatMap((component) =>
    ["headers", "body"].map((phase) => ({ component, phase })),
  ),
)(
  "exits naturally after closing $component during manifest $phase",
  async ({ component, phase }) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cantrip-runtime-shutdown-"),
    );
    const sockets = new Set<Socket>();
    let received = false;
    const peer = createServer((_request, response) => {
      if (phase === "body") {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"unfinished":');
      }
      // Keep the real connection open until the production client cancels it.
      received = true;
    });
    peer.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(peer.address() as { port: number }).port}`;
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(
          new URL("./fixtures/runtime-shutdown.ts", import.meta.url),
        ),
        component,
        directory,
        origin,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const exited = once(child, "close");
    try {
      await expect.poll(() => received, { timeout: 10_000 }).toBe(true);
      child.stdin.end("close\n");
      await expect
        .poll(() => child.exitCode, { timeout: 5_000 })
        .not.toBeNull();
      const [code, signal] = await exited;
      expect({ code, signal }, output).toEqual({ code: 0, signal: null });
      expect(output).toContain("RUNTIME_CLOSED");
      await expect.poll(() => sockets.size).toBe(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited;
      await new Promise<void>((resolve) => peer.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
  20_000,
);

it.each([false, true])(
  "observes owned child closure (ignores SIGTERM: %s)",
  async (ignore) => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
    if (${ignore}) process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
    process.stdout.write("READY");
  `,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const exited = once(child, "close");
    try {
      await once(child.stdout, "data");
      let closed = false;
      child.once("close", () => {
        closed = true;
      });
      await stopRuntimeProcess(child, 100);
      expect(closed).toBe(true);
      const [, signal] = await exited;
      expect(signal).toBe(
        ignore && process.platform !== "win32" ? "SIGKILL" : "SIGTERM",
      );
      expect(() => process.kill(child.pid!, 0)).toThrow();
      await stopRuntimeProcess(child, 100);
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited;
    }
  },
);
