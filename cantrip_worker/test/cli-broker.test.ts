import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CANTRIP_CLI_CONNECTION_ENV,
  CantripCliBroker,
} from "../src/cli-broker.js";
import { TerminalManager } from "../src/terminal-manager.js";

const directories: string[] = [];
const originalConnection = process.env[CANTRIP_CLI_CONNECTION_ENV];
const pathKey =
  Object.keys(process.env).find((key) => key.toLowerCase() === "path") ??
  "PATH";
const originalPath = process.env[pathKey];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-cli-broker-"),
  );
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  if (originalConnection === undefined) {
    delete process.env[CANTRIP_CLI_CONNECTION_ENV];
  } else {
    process.env[CANTRIP_CLI_CONNECTION_ENV] = originalConnection;
  }
  if (originalPath === undefined) delete process.env[pathKey];
  else process.env[pathKey] = originalPath;
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Cantrip CLI worker broker", () => {
  it.skipIf(process.platform === "win32")(
    "makes the authenticated CLI available in terminal tabs",
    async () => {
      const directory = await temporaryDirectory();
      const binary = path.join(directory, "cantrip");
      await writeFile(
        binary,
        [
          "#!/bin/sh",
          'printf \'CANTRIP_TERMINAL_OK:%s:%s\\n\' "$CANTRIP_CLI_CONNECTION" "$CANTRIP_TERMINAL_ID"',
        ].join("\n"),
      );
      await chmod(binary, 0o755);
      const broker = new CantripCliBroker(
        {
          dataDirectory: path.join(directory, "worker-data"),
          serverUrl: "https://cantrip.example",
          token: "worker-token",
          workerId: "worker-example",
        },
        { binary },
      );
      await broker.start();
      const environment = broker.childEnvironment();

      if (originalConnection === undefined) {
        delete process.env[CANTRIP_CLI_CONNECTION_ENV];
      } else {
        process.env[CANTRIP_CLI_CONNECTION_ENV] = originalConnection;
      }
      if (originalPath === undefined) delete process.env[pathKey];
      else process.env[pathKey] = originalPath;

      const manager = new TerminalManager({ environment });
      let output = "";
      const exited = manager.open(
        "terminal-cli",
        "attachment-cli",
        directory,
        80,
        24,
        { type: "shell" },
        (event) => {
          if (event.type === "terminal.output") output += event.data;
        },
      );
      try {
        manager.input("terminal-cli", "cantrip\r");
        await expect
          .poll(() => output, { timeout: 5_000 })
          .toContain(
            `CANTRIP_TERMINAL_OK:${broker.connectionPath}:terminal-cli`,
          );
        manager.input("terminal-cli", "exit\r");
        await expect(exited).resolves.toMatchObject({
          status: "exited",
          exitCode: 0,
        });
      } finally {
        manager.closeAll();
        await broker.close();
      }
    },
  );

  it("publishes a protected authenticated loopback handshake", async () => {
    const directory = await temporaryDirectory();
    const binary = path.join(
      directory,
      process.platform === "win32" ? "cantrip.exe" : "cantrip",
    );
    await writeFile(binary, "stub");
    if (process.platform !== "win32") await chmod(binary, 0o755);
    const broker = new CantripCliBroker(
      {
        dataDirectory: path.join(directory, "worker-data"),
        serverUrl: "https://cantrip.example",
        token: "worker-token",
        workerId: "worker-example",
      },
      { binary },
    );

    const connection = await broker.start();
    try {
      expect(process.env[CANTRIP_CLI_CONNECTION_ENV]).toBe(
        broker.connectionPath,
      );
      expect((process.env[pathKey] ?? "").split(path.delimiter)[0]).toBe(
        directory,
      );
      expect(new URL(connection.endpoint).hostname).toBe("127.0.0.1");
      const stored = JSON.parse(
        await readFile(broker.connectionPath, "utf8"),
      ) as Record<string, unknown>;
      expect(stored).toMatchObject({
        version: 1,
        endpoint: connection.endpoint,
        serverUrl: "https://cantrip.example",
        workerId: "worker-example",
      });
      expect(stored).not.toHaveProperty("credential");
      if (process.platform !== "win32") {
        expect((await stat(broker.connectionPath)).mode & 0o777).toBe(0o600);
      }

      const unauthorized = await fetch(`${connection.endpoint}/v1/handshake`);
      expect(unauthorized.status).toBe(401);
      const handshake = await fetch(`${connection.endpoint}/v1/handshake`, {
        headers: { authorization: `Bearer ${connection.sessionToken}` },
      });
      expect(handshake.status).toBe(200);
      await expect(handshake.json()).resolves.toEqual({
        protocolVersion: 1,
        serverUrl: "https://cantrip.example",
        workerId: "worker-example",
      });
    } finally {
      await broker.close();
    }
    await expect(access(broker.connectionPath)).rejects.toThrow();
  });

  it("authenticates and relays structured CLI commands", async () => {
    const directory = await temporaryDirectory();
    const binary = path.join(
      directory,
      process.platform === "win32" ? "cantrip.exe" : "cantrip",
    );
    await writeFile(binary, "stub");
    if (process.platform !== "win32") await chmod(binary, 0o755);
    const calls: unknown[] = [];
    const broker = new CantripCliBroker(
      {
        dataDirectory: path.join(directory, "worker-data"),
        serverUrl: "https://cantrip.example",
        token: "worker-token",
        workerId: "worker-example",
      },
      {
        binary,
        execute: async (request, requestId) => {
          calls.push({ request, requestId });
          return {
            summary: "Found the current worktree.",
            target: null,
            worktreeId: "worktree-one",
            continuationScheduled: false,
            mutated: false,
          };
        },
      },
    );

    const connection = await broker.start();
    try {
      const response = await fetch(`${connection.endpoint}/v1/execute`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${connection.sessionToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "worktree.status",
          context: {
            codexThreadId: null,
            terminalId: "terminal-one",
            cwd: "/workspace/project",
          },
          arguments: {},
        }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        summary: "Found the current worktree.",
        worktreeId: "worktree-one",
      });
      expect(calls).toEqual([
        {
          request: expect.objectContaining({
            command: "worktree.status",
            context: expect.objectContaining({ terminalId: "terminal-one" }),
          }),
          requestId: expect.any(String),
        },
      ]);

      const unauthorized = await fetch(`${connection.endpoint}/v1/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(unauthorized.status).toBe(401);
    } finally {
      await broker.close();
    }
  });

  it("reports server transport failures as unavailable", async () => {
    const directory = await temporaryDirectory();
    const binary = path.join(
      directory,
      process.platform === "win32" ? "cantrip.exe" : "cantrip",
    );
    await writeFile(binary, "stub");
    if (process.platform !== "win32") await chmod(binary, 0o755);
    const broker = new CantripCliBroker(
      {
        dataDirectory: path.join(directory, "worker-data"),
        serverUrl: "https://cantrip.example",
        token: "worker-token",
        workerId: "worker-example",
      },
      {
        binary,
        execute: async () => {
          throw new Error("server connection failed");
        },
      },
    );

    const connection = await broker.start();
    try {
      const response = await fetch(`${connection.endpoint}/v1/execute`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${connection.sessionToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "status",
          context: { codexThreadId: null, terminalId: null, cwd: null },
          arguments: {},
        }),
      });
      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({
        code: "unavailable",
        error: "server connection failed",
      });
    } finally {
      await broker.close();
    }
  });
});
