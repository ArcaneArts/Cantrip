import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it, vi } from "vitest";

import {
  CODEGRAPH_MANAGED_ENVIRONMENT,
  managedCodeGraphMcpServer,
} from "../src/codegraph/mcp.js";

// Opt-in against the installed standalone runtime. All indexing and MCP calls
// use a temporary project/home; no account, model turn, or live index is used.
const launcher = process.env.CANTRIP_CODEGRAPH_TEST_LAUNCHER?.trim();
const node =
  process.env.CANTRIP_CODEGRAPH_TEST_NODE?.trim() || process.execPath;
const run = promisify(execFile);

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "cantrip-shared-graph-"));
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  const clients: Client[] = [];
  const environment: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    ...CODEGRAPH_MANAGED_ENVIRONMENT,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: path.join(home, "codex"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
  };
  const index = path.join(workspace, ".codegraph-cantrip");
  const writer = async () =>
    JSON.parse(await readFile(path.join(index, "writer.pid"), "utf8")) as {
      pid: number;
      mode: string;
    };
  const cleanup = async () => {
    try {
      await Promise.all(clients.map((client) => client.close()));
    } finally {
      // The shared daemon is detached. Stop only the daemon recorded inside
      // this fixture's uniquely-created project, not any production process.
      try {
        const daemon = JSON.parse(
          await readFile(path.join(index, "daemon.pid"), "utf8"),
        ) as { pid: number };
        if (Number.isInteger(daemon.pid) && daemon.pid > 0) {
          process.kill(daemon.pid, "SIGTERM");
          await vi.waitFor(
            () => {
              try {
                process.kill(daemon.pid, 0);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
                throw error;
              }
              throw new Error("Fixture daemon is still stopping");
            },
            { timeout: 5_000, interval: 25 },
          );
        }
      } catch (error) {
        if (
          !["ENOENT", "ESRCH"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  };
  try {
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(home, { recursive: true }),
    ]);
    await writeFile(
      path.join(workspace, "greeting.ts"),
      'export function cantripGreeting(): string { return "fixture greeting"; }\n',
    );
    await run(node, [launcher!, "init", workspace, "--yes"], {
      cwd: workspace,
      env: environment,
      timeout: 30_000,
    });
    return {
      cleanup,
      writer,
      async connect(direct = false) {
        const server = managedCodeGraphMcpServer(node, [launcher!], workspace);
        const transport = new StdioClientTransport({
          command: server.command!,
          args: server.args,
          cwd: workspace,
          env: {
            ...environment,
            ...server.environment,
            ...(direct ? { CODEGRAPH_NO_DAEMON: "1" } : {}),
          },
          stderr: "pipe",
        });
        let stderr = "";
        transport.stderr?.on("data", (chunk) => {
          stderr = `${stderr}${String(chunk)}`.slice(-8_000);
        });
        const client = new Client({
          name: "cantrip-shared-graph-test",
          version: "1",
        });
        clients.push(client);
        try {
          await client.connect(transport, { timeout: 10_000 });
        } catch (error) {
          throw new Error(`CodeGraph initialize failed: ${stderr}`, {
            cause: error,
          });
        }
        return client;
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function explore(client: Client) {
  const catalog = await client.listTools();
  expect(catalog.tools.some((tool) => tool.name === "codegraph_explore")).toBe(
    true,
  );
  const result = await client.callTool(
    { name: "codegraph_explore", arguments: { query: "cantripGreeting" } },
    undefined,
    { timeout: 20_000 },
  );
  expect(result.isError).not.toBe(true);
  expect(JSON.stringify(result.content)).toContain("fixture greeting");
}

describe.skipIf(!launcher)("native shared CodeGraph MCP", () => {
  it("serves concurrent chats and keeps the survivor usable after disconnect", async () => {
    const graph = await fixture();
    try {
      const [first, second] = await Promise.all([
        graph.connect(),
        graph.connect(),
      ]);
      await explore(first);
      const owner = await graph.writer();
      expect(owner.mode).toBe("daemon");

      await explore(second);
      expect(await graph.writer()).toMatchObject({
        pid: owner.pid,
        mode: owner.mode,
      });
      await first.close();
      await explore(second);
    } finally {
      await graph.cleanup();
    }
  }, 45_000);

  it("can read alongside a still-live direct-mode session from an older release", async () => {
    const graph = await fixture();
    try {
      const previous = await graph.connect(true);
      await explore(previous);
      const owner = await graph.writer();
      expect(owner.mode).toBe("direct");

      const next = await graph.connect();
      await explore(next);
      expect(await graph.writer()).toMatchObject({
        pid: owner.pid,
        mode: owner.mode,
      });
      await explore(previous);
    } finally {
      await graph.cleanup();
    }
  }, 45_000);
});
