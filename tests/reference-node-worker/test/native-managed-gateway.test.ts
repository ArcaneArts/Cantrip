import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { stripVTControlCharacters } from "node:util";
import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import {
  createManagedNativeGateway,
  type ManagedNativeGateway,
} from "../src/codex/managed-native-gateway.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();
class Peer {
  readonly messages: any[] = [];
  private sequence = 0;
  constructor(readonly socket: WebSocket) {
    socket.on("message", (raw) =>
      this.messages.push(JSON.parse(raw.toString())),
    );
  }
  async raw(method: string, params: any = {}) {
    const id = ++this.sequence;
    this.socket.send(JSON.stringify({ id, method, params }));
    await vi.waitFor(
      () => expect(this.messages.some((frame) => frame.id === id)).toBe(true),
      { timeout: 15000 },
    );
    return this.messages.find((frame) => frame.id === id);
  }
  async request(method: string, params: any = {}) {
    const frame = await this.raw(method, params);
    if (frame.error) throw new Error(JSON.stringify(frame.error));
    return frame.result;
  }
}

describe.skipIf(!binary)("actual pinned managed native gateway", () => {
  it("authorizes real settings and defaults before mutation; denied turns do not infer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-native-gateway-"));
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const requests: string[] = [];
    const provider = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.writeHead(500).end("No inference expected.");
    });
    let native: ChildProcessWithoutNullStreams | undefined;
    let closed: Promise<unknown> | undefined;
    let gateway: ManagedNativeGateway | undefined;
    const clients: WebSocket[] = [];
    const readers: readline.Interface[] = [];
    try {
      await Promise.all([mkdir(home), mkdir(workspace)]);
      provider.listen(0, "127.0.0.1");
      await once(provider, "listening");
      const providerPort = (provider.address() as any).port;
      await writeFile(
        path.join(home, "config.toml"),
        [
          'model = "gpt-5"',
          'model_provider = "fixture"',
          'approval_policy = "never"',
          'sandbox_mode = "read-only"',
          "features.plugins = false",
          "[model_providers.fixture]",
          'name = "Gateway fixture"',
          `base_url = "http://127.0.0.1:${providerPort}/v1"`,
          'wire_api = "responses"',
          "requires_openai_auth = false",
          "request_max_retries = 0",
          "stream_max_retries = 0",
          "",
        ].join("\n"),
      );
      native = spawn(binary!, ["app-server", "--listen", "ws://127.0.0.1:0"], {
        cwd: workspace,
        env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
        stdio: "pipe",
      });
      closed = once(native, "close");
      const endpoint = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Native endpoint not announced")),
          15000,
        );
        native!.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        for (const stream of [native!.stdout, native!.stderr]) {
          const reader = readline.createInterface({ input: stream });
          readers.push(reader);
          reader.on("line", (line) => {
            const match = /^\s*listening on:\s+(ws:\/\/\S+)\s*$/.exec(
              stripVTControlCharacters(line),
            );
            if (match) {
              clearTimeout(timeout);
              resolve(match[1]!);
            }
          });
        }
      });
      const connect = async (url: string) => {
        const socket = new WebSocket(url);
        clients.push(socket);
        const peer = new Peer(socket);
        await once(socket, "open");
        await peer.request("initialize", {
          clientInfo: { name: "managed-gateway-test", version: "1" },
          capabilities: { experimentalApi: true },
        });
        socket.send(JSON.stringify({ method: "initialized" }));
        return peer;
      };
      const owner = await connect(endpoint);
      const started = await owner.request("thread/start", { cwd: workspace });
      const threadId = started.thread.id;
      const settle = vi.fn(async () => {});
      let permitSettings = false;
      let permitDefaults = false;
      const admittedMethods: string[] = [];
      gateway = await createManagedNativeGateway({
        identity: {
          ownerId: "owner",
          serverId: "server",
          workerId: "worker",
          chatId: "chat",
          projectId: "project",
          placementId: "worktree",
          contextKind: "project",
          threadId,
          runtimeGeneration: "actual-runtime-one",
        },
        upstreamUrl: endpoint,
        isCurrent: () => true,
        resolveReply: async () => {
          throw new Error("No native requests expected in settings fixture.");
        },
        admit: async (operation) => {
          admittedMethods.push(operation.method);
          if (operation.kind === "start")
            throw new Error("Execution denied by fixture.");
          if (operation.kind === "settings" && !permitSettings)
            throw new Error("Settings denied by fixture.");
          if (operation.kind === "defaults" && !permitDefaults)
            throw new Error("Defaults denied by fixture.");
          return {
            operationGeneration: operation.operationId,
            beforeForward: async () => {},
            settle,
          };
        },
      });
      expect(gateway.url).not.toBe(endpoint);
      const view = await connect(gateway.url);
      await view.request("thread/resume", { threadId });
      expect(
        (
          await view.raw("turn/start", {
            threadId,
            input: [{ type: "text", text: "must not infer" }],
          })
        ).error,
      ).toBeDefined();
      expect(
        (await view.raw("thread/settings/update", { threadId, effort: "low" }))
          .error,
      ).toBeDefined();
      expect(
        (await owner.request("thread/resume", { threadId })).reasoningEffort,
      ).not.toBe("low");
      permitSettings = true;
      expect(
        await view.request("thread/settings/update", {
          threadId,
          effort: "low",
        }),
      ).toEqual({});
      await vi.waitFor(async () =>
        expect(
          (await owner.request("thread/resume", { threadId })).reasoningEffort,
        ).toBe("low"),
      );
      const beforeDefaults = await readFile(
        path.join(home, "config.toml"),
        "utf8",
      );
      const edit = {
        edits: [
          {
            keyPath: "model_reasoning_effort",
            value: "high",
            mergeStrategy: "replace",
          },
        ],
        reloadUserConfig: false,
      };
      expect((await view.raw("config/batchWrite", edit)).error).toBeDefined();
      expect(await readFile(path.join(home, "config.toml"), "utf8")).toBe(
        beforeDefaults,
      );
      permitDefaults = true;
      expect(await view.request("config/batchWrite", edit)).toMatchObject({
        status: "ok",
      });
      expect(await readFile(path.join(home, "config.toml"), "utf8")).toContain(
        'model_reasoning_effort = "high"',
      );
      expect(settle).toHaveBeenCalledWith(
        expect.objectContaining({ result: {} }),
      );
      expect(admittedMethods).toContain("turn/start");
      expect(requests).toEqual([]);
      expect(
        (await owner.request("thread/read", { threadId, includeTurns: true }))
          .thread.turns,
      ).toEqual([]);
    } finally {
      for (const client of clients) client.terminate();
      await gateway?.close();
      if (native && native.exitCode === null && native.signalCode === null) {
        const force = setTimeout(() => native?.kill("SIGKILL"), 2000);
        native.kill("SIGTERM");
        await closed;
        clearTimeout(force);
      }
      for (const reader of readers) reader.close();
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
