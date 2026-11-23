import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { CodexAppServer } from "../src/codex/app-server.js";
import { discoverCodexRuntime } from "../src/codex/discovery.js";

// Explicit opt-in. Preparation and reads use temporary storage and a local
// stdio fixture; no account credentials or model turns are required.
const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();

describe.skipIf(!binary)("native conversation MCP resources", () => {
  it("reads isolated project resources across refresh/reload and reports removed resources", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-mcp-resource-"));
    const home = path.join(root, "home");
    const projectA = path.join(root, "project-a");
    const projectB = path.join(root, "project-b");
    const script = path.join(root, "fixture.mjs");
    const config = "features.plugins=false\n";
    let modelRequests = 0;
    const server = createServer((_request, response) => {
      modelRequests++;
      response.writeHead(500).end("No inference expected.");
    });
    let runtime: CodexAppServer | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;
    let closed: Promise<unknown> | undefined;
    try {
      await Promise.all([mkdir(home), mkdir(projectA), mkdir(projectB)]);
      await writeFile(path.join(home, "config.toml"), config);
      await writeFile(
        script,
        `import readline from 'node:readline';
const send = x => process.stdout.write(JSON.stringify(x) + '\\n');
for await (const line of readline.createInterface({input: process.stdin})) {
  const q = JSON.parse(line);
  if (q.id === undefined) continue;
  let result;
  switch (q.method) {
    case 'initialize': result = { protocolVersion: q.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'wqa-fixture', version: '1' } }; break;
    case 'tools/list': result = { tools: [] }; break;
    case 'resources/list': result = { resources: [{ uri: 'wqa://marker', name: 'Marker', mimeType: 'text/plain' }] }; break;
    case 'resources/templates/list': result = { resourceTemplates: [] }; break;
    case 'resources/read':
      if (q.params.uri !== 'wqa://marker') { send({ jsonrpc: '2.0', id: q.id, error: { code: -32602, message: 'Unknown fixture resource ' + q.params.uri } }); continue; }
      result = { contents: [{ uri: q.params.uri, mimeType: 'text/plain', text: process.argv[2] }] }; break;
    case 'ping': result = {}; break;
    default: send({ jsonrpc: '2.0', id: q.id, error: { code: -32601, message: 'Unknown fixture method' } }); continue;
  }
  send({ jsonrpc: '2.0', id: q.id, result });
}
`,
      );
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const model = {
        id: "fixture-model",
        routeId: "fixture-route",
        name: "gpt-5",
        reasoningEffort: null,
      };
      const provider = {
        id: "fixture-provider",
        name: "Fixture",
        kind: "openai-compatible" as const,
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        apiKey: "fixture-only",
      };
      runtime = new CodexAppServer(
        binary!,
        path.join(root, "runtime"),
        home,
        await discoverCodexRuntime(binary!, path.join(root, "probe")),
        undefined,
        undefined,
        undefined,
        (file, args, options) => {
          child = spawn(file, args, { ...options, stdio: "pipe" });
          closed = once(child, "close");
          return child;
        },
        [],
      );
      const mcpServers = (marker: string) => [
        {
          name: "wqa_echo52",
          enabled: true,
          transport: "stdio" as const,
          command: process.execPath,
          args: [script, marker],
          url: null,
          environment: {},
        },
      ];
      const prepare = (
        cwd: string,
        marker: string,
        threadId: string | null = null,
        remove = false,
      ) =>
        runtime!.prepareManagedThread({
          cwd,
          model,
          provider,
          threadId,
          executionProfile: "ide",
          permissionProfileId: ":workspace",
          planMode: "default",
          intent: "configure",
          mcpServers: remove ? [] : mcpServers(marker),
        });
      const a = {
        cwd: projectA,
        model,
        provider,
        threadId: (await prepare(projectA, "PROJECT_A")).threadId,
      };
      const b = {
        cwd: projectB,
        model,
        provider,
        threadId: (await prepare(projectB, "PROJECT_B")).threadId,
      };
      const inventory = async (options: typeof a) => {
        await vi.waitFor(
          async () => {
            const result = await runtime!.readCustomizationInventory(
              options,
              true,
            );
            expect(
              result.mcpServers.find((s) => s.name === "wqa_echo52")?.resources,
            ).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ uri: "wqa://marker" }),
              ]),
            );
          },
          { timeout: 10_000, interval: 100 },
        );
      };
      const read = (options: typeof a, uri = "wqa://marker") =>
        runtime!.readMcpResource({ ...options, server: "wqa_echo52", uri });
      await inventory(a);
      await inventory(b);
      expect((await read(a)).contents[0]?.text).toBe("PROJECT_A");
      expect((await read(b)).contents[0]?.text).toBe("PROJECT_B");
      await runtime.reloadMcpServers(a);
      await inventory(a);
      await inventory(b);
      expect((await read(a)).contents[0]?.text).toBe("PROJECT_A");
      expect((await read(b)).contents[0]?.text).toBe("PROJECT_B");
      await expect(read(a, "wqa://missing")).rejects.toThrow(
        "Unknown fixture resource",
      );
      await prepare(projectA, "PROJECT_A", a.threadId, true);
      await expect(read(a)).rejects.toThrow(/unknown MCP server/i);
      expect((await read(b)).contents[0]?.text).toBe("PROJECT_B");
      expect(await readFile(path.join(home, "config.toml"), "utf8")).toBe(
        config,
      );
      expect(modelRequests).toBe(0);
    } finally {
      runtime?.close();
      if (closed) await closed;
      if (child && child.exitCode === null && child.signalCode === null)
        child.kill();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
