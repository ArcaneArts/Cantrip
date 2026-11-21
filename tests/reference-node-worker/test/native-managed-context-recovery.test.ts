import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CodexRpcClient } from "../src/codex/rpc-client.js";
import { readCodexNativeHistory } from "../src/codex/native-history.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();
type Json = Record<string, any>;
const image =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6X8AAAAASUVORK5CYII=";

describe.skipIf(!binary)("native managed context recovery", () => {
  it.each(["legacy", "paginated"] as const)(
    "retains %s history, queue and settings across recovery and restart",
    async (historyMode) => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "cantrip-context-recovery-"),
      );
      const home = path.join(directory, "home");
      const cwd = path.join(directory, "workspace");
      const requests: Json[] = [];
      let releaseFirst!: () => void;
      const firstResponse = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const provider = createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk.toString();
        const input = JSON.parse(body);
        requests.push(input);
        const index = requests.length;
        if (index === 1) await firstResponse;
        if (JSON.stringify(input.input).includes("rejected-checkpoint")) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                type: "invalid_request_error",
                code: "invalid_encrypted_content",
                message: "could not decode the compaction blob",
              },
            }),
          );
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        const item = {
          type: "message",
          role: "assistant",
          id: `answer-${index}`,
          content: [{ type: "output_text", text: `Retained answer ${index}` }],
        };
        const events = [
          { type: "response.created", response: { id: `response-${index}` } },
          { type: "response.output_item.done", item },
          {
            type: "response.completed",
            response: {
              id: `response-${index}`,
              usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
            },
          },
        ];
        response.end(
          events
            .map(
              (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join(""),
        );
      });
      let child: ChildProcessWithoutNullStreams | undefined;
      let client: CodexRpcClient | undefined;
      let stopWatching: (() => void) | undefined;
      const gateFailures: unknown[] = [];
      const rpc = async (method: string, params: Json): Promise<Json> => {
        const result = await client!.request(method, params);
        if (result.error) throw new Error(result.error.message);
        return result.result as Json;
      };
      const stop = async () => {
        if (!child) return;
        const closing = child;
        const exited = once(closing, "close");
        const force = setTimeout(() => closing.kill("SIGKILL"), 5000);
        stopWatching?.();
        client!.close();
        await exited.finally(() => clearTimeout(force));
        child = undefined;
      };
      const start = async () => {
        child = spawn(binary!, ["app-server"], {
          cwd,
          env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
          stdio: "pipe",
        });
        client = new CodexRpcClient(child, 20000);
        await rpc("initialize", {
          clientInfo: { name: "cantrip_context_recovery", version: "1" },
          capabilities: { experimentalApi: true },
        });
        client.notify("initialized");
        const native = client;
        let watching = true;
        stopWatching = () => {
          watching = false;
        };
        void (async () => {
          while (watching) {
            const notification = await native.waitForNotification(
              "thread/managedExecution/requested",
            );
            const attempt = notification.params as Json;
            const resolution = await native.request(
              "thread/managedExecution/resolve",
              {
                threadId: attempt.threadId,
                runnerGeneration: attempt.runnerGeneration,
                attemptId: attempt.attemptId,
                operationGeneration: null,
                allow: false,
              },
            );
            if (resolution.error) throw new Error(resolution.error.message);
          }
        })().catch((error) => {
          if (watching) gateFailures.push(error);
        });
      };
      const finished = async (turnId: string) => {
        const notification = await client!.waitForNotification(
          "turn/completed",
          (params: any) => params?.turn?.id === turnId,
        );
        return (notification.params as Json).turn;
      };
      try {
        await Promise.all([mkdir(home), mkdir(cwd)]);
        provider.listen(0, "127.0.0.1");
        await once(provider, "listening");
        await writeFile(
          path.join(home, "config.toml"),
          [
            'model="gpt-5"',
            'model_provider="fixture"',
            'approval_policy="never"',
            'sandbox_mode="read-only"',
            "features.plugins=false",
            "[model_providers.fixture]",
            'name="Fixture"',
            `base_url="http://127.0.0.1:${(provider.address() as { port: number }).port}/v1"`,
            'wire_api="responses"',
            "requires_openai_auth=false",
            "request_max_retries=0",
            "stream_max_retries=0",
            "",
          ].join("\n"),
        );
        await start();
        // Native unmanaged queues auto-dispatch. A managed runner keeps queued
        // input pending until its owner grants that exact autonomous attempt.
        const managedConfig = {
          mcpServers: {},
          developerInstructions: "Keep the managed profile.",
          multiAgentEnabled: false,
          subagentModel: null,
          subagentReasoningEffort: null,
          canonicalHistory: true,
          executionGate: { runnerGeneration: "context-recovery-fixture" },
        };
        const { thread } = await rpc("thread/start", {
          cwd,
          historyMode,
          managedConfig,
        });
        const threadId = thread.id;
        const first = await rpc("turn/start", {
          threadId,
          input: [
            { type: "text", text: "BEFORE_RESET" },
            { type: "image", url: image },
          ],
        });
        await vi.waitFor(() => expect(requests).toHaveLength(1));
        await expect(
          rpc("thread/managedContext/reset", {
            threadId,
            expectedLastTurnId: first.turn.id,
          }),
        ).rejects.toThrow("active turn");
        releaseFirst();
        expect((await finished(first.turn.id)).status).toBe("completed");
        await rpc("thread/inject_items", {
          threadId,
          items: [
            { type: "compaction", encrypted_content: "rejected-checkpoint" },
          ],
        });
        const rejected = await rpc("turn/start", {
          threadId,
          input: [{ type: "text", text: "Trigger rejected context" }],
        });
        expect((await finished(rejected.turn.id)).status).toBe("failed");
        await rpc("thread/queue/add", {
          threadId,
          clientUserMessageId: "retained-queued-message",
          input: [{ type: "text", text: "Pending queue input" }],
        });
        const queued = await rpc("thread/queue/list", { threadId });
        expect(queued.data).toHaveLength(1);
        const settings = await rpc("thread/settings/read", { threadId });
        const history = await readCodexNativeHistory(rpc, threadId);
        expect(
          history.thread.turns.map((turn) => turn.id),
          JSON.stringify({
            turns: history.thread.turns,
            queued,
            requests: requests.length,
          }),
        ).toEqual([first.turn.id, rejected.turn.id]);
        await expect(
          rpc("thread/managedContext/reset", {
            threadId,
            expectedLastTurnId: first.turn.id,
          }),
        ).rejects.toThrow("stale native turn");
        await expect(
          rpc("thread/managedContext/reset", { threadId }),
        ).rejects.toThrow();
        await rpc("thread/managedContext/reset", {
          threadId,
          expectedLastTurnId: rejected.turn.id,
        });
        expect(
          (await readCodexNativeHistory(rpc, threadId)).thread.turns,
        ).toEqual(history.thread.turns);
        expect(await rpc("thread/queue/list", { threadId })).toEqual(queued);
        expect(await rpc("thread/settings/read", { threadId })).toEqual(
          settings,
        );
        expect(requests).toHaveLength(2);
        await stop();
        await start();
        await rpc("thread/resume", { threadId, managedConfig });
        expect(
          (await readCodexNativeHistory(rpc, threadId)).thread.turns,
        ).toEqual(history.thread.turns);
        expect(await rpc("thread/queue/list", { threadId })).toEqual(queued);
        const resumedSettings = await rpc("thread/settings/read", { threadId });
        const { settingsVersion: previousEpoch, ...previousSelection } =
          settings.threadSettings;
        const { settingsVersion: resumedEpoch, ...resumedSelection } =
          resumedSettings.threadSettings;
        expect(resumedSelection).toEqual(previousSelection);
        expect(resumedEpoch.epoch).not.toBe(previousEpoch.epoch);
        const after = await rpc("turn/start", {
          threadId,
          input: [{ type: "text", text: "AFTER_RESET_ONLY" }],
        });
        expect((await finished(after.turn.id)).status).toBe("completed");
        expect(requests).toHaveLength(3);
        expect(gateFailures).toEqual([]);
        expect(JSON.stringify(requests[2]!.input)).toContain(
          "AFTER_RESET_ONLY",
        );
        expect(JSON.stringify(requests[2]!.input)).not.toContain(
          "BEFORE_RESET",
        );
        expect(JSON.stringify(requests[2]!.input)).not.toContain(
          "rejected-checkpoint",
        );
        expect(
          (await readCodexNativeHistory(rpc, threadId)).thread.turns.slice(
            0,
            2,
          ),
        ).toEqual(history.thread.turns);
      } finally {
        releaseFirst();
        await stop();
        provider.closeAllConnections();
        await new Promise<void>((resolve) => provider.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    },
    60000,
  );
});
