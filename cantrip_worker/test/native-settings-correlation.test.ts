import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { NativeSettingsDelivery } from "../src/native-settings-delivery.js";
import { ManagedNativeSettings } from "../src/codex/managed-native-settings.js";
import { NativeHistoryObservations } from "../src/codex/native-history-observation.js";
import { openNativeCommandContent } from "../src/native-command-content.js";
import type { NativeSettingsEvidence } from "@cantrip/protocol";
import { CodexRpcClient } from "../src/codex/rpc-client.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();
type Json = Record<string, any>;

// Actual pinned runtime, isolated account and rejecting provider. No model
// turn, external MCP service, desktop input or user configuration is involved.
describe.skipIf(!binary)("native settings acknowledgments", () => {
  it("exports the implemented settings and managed APIs from the packaged CLI", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-settings-export-"));
    const output = path.join(root, "schema");
    try {
      await promisify(execFile)(
        binary!,
        ["app-server", "generate-ts", "--experimental", "--out", output],
        {
          cwd: root,
          env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: root },
        },
      );
      for (const name of [
        "ThreadSettingsUpdateParams",
        "ThreadSettingsUpdateResponse",
        "ThreadSettingsUpdatedNotification",
      ]) {
        const source = await readFile(
          path.join(output, "v2", `${name}.ts`),
          "utf8",
        );
        expect(source).toContain("operationId");
        if (name !== "ThreadSettingsUpdateParams")
          expect(source).toContain("submissionId");
      }
      const errors = await readFile(
        path.join(output, "v2", "CodexErrorInfo.ts"),
        "utf8",
      );
      expect(errors).toContain("threadSettingsUpdateFailed");
      expect(errors).toContain("operationId: string | null");
      const requests = await readFile(
        path.join(output, "ClientRequest.ts"),
        "utf8",
      );
      expect(requests).toContain("thread/managedConfig/update");
      expect(requests).toContain("thread/managedExecution/bind");
      expect(
        await readFile(path.join(output, "v2", "LiveHistoryCursor.ts"), "utf8"),
      ).toContain("LiveHistoryCursor");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it.each(["legacy", "paginated"])(
    "correlates no-op and consecutive settings snapshots in %s history",
    async (historyMode) => {
      const root = await mkdtemp(
        path.join(tmpdir(), "cantrip-settings-correlation-"),
      );
      const home = path.join(root, "home");
      const workspace = path.join(root, "workspace");
      let requests = 0;
      const provider = createServer((_request, response) => {
        requests += 1;
        response
          .writeHead(500)
          .end("No inference is permitted in this fixture.");
      });
      let child: ChildProcessWithoutNullStreams | undefined;
      let closed: Promise<unknown> | undefined;
      let client: CodexRpcClient | undefined;
      let lines: readline.Interface | undefined;
      let delivery: NativeSettingsDelivery | undefined;
      const observations = new NativeHistoryObservations();
      observations.replace("fixture-runtime");
      const evidence: Omit<NativeSettingsEvidence, "workerId">[] = [];
      const evidenceErrors: unknown[] = [];
      const encryption = {
        ownerId: () => "fixture-owner",
        serverIdentity: () => "fixture-server",
        componentKey: () => ({
          keyRevision: 1,
          key: new Uint8Array(32).fill(7),
        }),
      };
      delivery = new NativeSettingsDelivery({
        directory: root,
        workerId: "fixture-worker",
        service: encryption,
        retryDelayMs: 10,
        client: {
          settingsEvidence: async (event) => {
            evidence.push(event);
            return {
              operationId: event.operationId,
              operationGeneration: event.operationGeneration,
              eventId: event.eventId,
              application: {
                nativeOperationId: event.nativeOperationId,
                submissionId: event.submissionId,
                evidenceCount: 1,
                status: "applied",
              },
            };
          },
        },
        onError: (error) => evidenceErrors.push(error),
      });
      const tracker = new ManagedNativeSettings({
        delivery,
        runtime: {
          observeNativeHistory: (threadId, observer) =>
            observations.subscribe(threadId, observer, async () => {
              throw new Error("Settings do not need history snapshots");
            }),
        },
        onError: (error) => evidenceErrors.push(error),
      });
      try {
        await Promise.all([mkdir(home), mkdir(workspace)]);
        provider.listen(0, "127.0.0.1");
        await once(provider, "listening");
        const address = provider.address();
        if (!address || typeof address === "string")
          throw new Error("Missing fixture address");
        await writeFile(
          path.join(home, "config.toml"),
          [
            'model = "gpt-5"',
            'model_provider = "settings_fixture"',
            'approval_policy = "never"',
            'sandbox_mode = "read-only"',
            "[features]",
            "plugins = false",
            "[model_providers.settings_fixture]",
            'name = "Settings fixture"',
            `base_url = "http://127.0.0.1:${address.port}/v1"`,
            'wire_api = "responses"',
            "requires_openai_auth = false",
            "request_max_retries = 0",
            "stream_max_retries = 0",
            "",
          ].join("\n"),
        );
        child = spawn(binary!, ["app-server"], {
          cwd: workspace,
          env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
          stdio: "pipe",
        });
        closed = once(child, "close");
        child.stderr.resume();
        const notifications: Json[] = [];
        lines = readline.createInterface({ input: child.stdout });
        lines.on("line", (line) => {
          const message = JSON.parse(line) as Json;
          if (message.method) {
            notifications.push(message);
            observations.notification(message.method, message.params);
          }
        });
        client = new CodexRpcClient(child, 15_000);
        const request = async (method: string, params: Json): Promise<Json> => {
          const response = await client!.request(method, params);
          if (response.error)
            throw new Error(`${method}: ${JSON.stringify(response.error)}`);
          return response.result as Json;
        };
        await request("initialize", {
          clientInfo: {
            name: "cantrip_settings_correlation_test",
            version: "1",
          },
          capabilities: { experimentalApi: true },
        });
        client.notify("initialized");
        const started = await request("thread/start", {
          historyMode,
          cwd: workspace,
          model: "gpt-5",
          modelProvider: "settings_fixture",
          approvalPolicy: "never",
          sandbox: "read-only",
          config: { model_reasoning_effort: "high" },
        });
        const threadId = started.thread.id as string;
        expect(await request("thread/settings/update", { threadId })).toEqual(
          {},
        );
        // Native effort values are extensible strings. Reject malformed wire
        // values rather than treating a model-defined name as invalid.
        for (const effort of ["", 123]) {
          const rejected = await client.request("thread/settings/update", {
            threadId,
            operationId: "settings-rejected",
            effort,
          });
          expect(rejected.error).toMatchObject({ code: -32600 });
        }
        const operations = [
          { operationId: "settings-no-op", patch: {} },
          { operationId: "settings-low", patch: { effort: "low" } },
          { operationId: "settings-medium", patch: { effort: "medium" } },
          { operationId: "settings-high", patch: { effort: "high" } },
          { operationId: "settings-same-high", patch: { effort: "high" } },
          { operationId: "settings-tier", patch: { serviceTier: "priority" } },
          { operationId: "settings-tier-omitted", patch: {} },
          {
            operationId: "settings-tier-cleared",
            patch: { serviceTier: null },
          },
          {
            operationId: "settings-custom-effort",
            patch: { effort: "fixture-custom-effort" },
          },
        ];
        // Await only queue acknowledgments, never an applied event between calls.
        const receipts: Json[] = [];
        for (const operation of operations) {
          await tracker.track({
            chatId: "fixture-chat",
            operationId: operation.operationId,
            operationGeneration: `grant:${operation.operationId}`,
            threadId,
            runtimeGeneration: "fixture-runtime",
            nativeOperationId: operation.operationId,
          });
          const acknowledgment = await request("thread/settings/update", {
            threadId,
            operationId: operation.operationId,
            ...operation.patch,
          });
          receipts.push(acknowledgment);
          await tracker.acknowledge(operation.operationId, {
            result: acknowledgment,
          });
        }
        expect(receipts).toEqual(
          operations.map(({ operationId }) => ({
            operationId,
            submissionId: expect.any(String),
          })),
        );
        const applied = () =>
          notifications.filter(
            ({ method, params }) =>
              method === "thread/settings/updated" &&
              params.threadId === threadId &&
              operations.some(
                ({ operationId }) => operationId === params.operationId,
              ),
          );
        await expect
          .poll(() => applied().length, { timeout: 5_000 })
          .toBe(operations.length);
        expect(
          applied().map(({ params }) => ({
            operationId: params.operationId,
            submissionId: params.submissionId,
            effort: params.threadSettings.effort,
            serviceTier: params.threadSettings.serviceTier,
          })),
        ).toEqual(
          operations.map(({ operationId }, index) => ({
            operationId,
            submissionId: receipts[index]!.submissionId,
            effort: [
              "high",
              "low",
              "medium",
              "high",
              "high",
              "high",
              "high",
              "high",
              "fixture-custom-effort",
            ][index],
            serviceTier: [
              null,
              null,
              null,
              null,
              null,
              "priority",
              "priority",
              // Core normalizes an explicit clear to its default-tier marker.
              "default",
              "default",
            ][index],
          })),
        );
        for (const { params } of applied()) {
          expect(params.threadSettings).toMatchObject({
            model: "gpt-5",
            modelProvider: "settings_fixture",
            cwd: workspace,
            approvalPolicy: "never",
            sandboxPolicy: { type: "readOnly" },
            collaborationMode: { mode: "default" },
          });
        }
        expect(
          notifications.some(
            ({ method, params }) =>
              method === "thread/settings/updated" &&
              params.operationId === "settings-rejected",
          ),
        ).toBe(false);
        expect(
          (await request("thread/read", { threadId, includeTurns: true }))
            .thread.turns,
        ).toEqual([]);
        await expect
          .poll(
            () => evidence.filter((event) => event.kind === "applied").length,
            { timeout: 5000 },
          )
          .toBe(operations.length);
        await expect
          .poll(
            () => evidence.filter((event) => event.kind === "queued").length,
            { timeout: 5000 },
          )
          .toBe(operations.length);
        for (const event of evidence.filter(
          (event) => event.kind === "applied",
        )) {
          const original = applied().find(
            (message) => message.params.operationId === event.nativeOperationId,
          )!;
          expect(
            await openNativeCommandContent({
              service: encryption,
              context: {
                chatId: "fixture-chat",
                operationId: event.operationId,
                direction: "settings-evidence",
                eventId: event.eventId,
              },
              envelope: event.protectedResult,
            }),
          ).toMatchObject({ kind: "applied", content: original.params });
        }
        expect(evidenceErrors).toEqual([]);
        expect(requests).toBe(0);
      } finally {
        await delivery?.stop();
        client?.close();
        lines?.close();
        if (child && closed) {
          const kill = setTimeout(() => child?.kill("SIGKILL"), 2_000);
          child.kill("SIGTERM");
          await closed;
          clearTimeout(kill);
        }
        await new Promise<void>((resolve) => provider.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
