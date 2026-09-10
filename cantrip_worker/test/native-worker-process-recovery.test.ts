import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import {
  deriveComponentKey,
  decryptSurfaceStreamPayload,
  encryptSurfaceStreamPayload,
  encryptPrivateDisplayLabel,
  encryptChatMessageProtectedContent,
  encryptQueuedPromptProtectedContent,
  encryptInteractionResponseContent,
  decryptChatMessageProtectedContent,
  exportHpkePublicKey,
  generateAccountMasterKey,
  generateHpkeKeyPair,
  wrapAccountMasterKeyForClient,
  wrapComponentKeyForWorker,
} from "@cantrip/crypto";
import { workerEncryptionComponentScopeSchema } from "@cantrip/protocol/encryption";
import { buildApp } from "../../cantrip_server/src/app.js";
import { connectDatabase } from "../../cantrip_server/src/db/index.js";
import { LOCAL_USER_ID as ownerId } from "../../cantrip_server/src/db/repository.js";
import type { ServerConfig } from "../../cantrip_server/src/config.js";
import { WorkerBridge } from "../../cantrip_server/src/workers/bridge.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();
const helper = process.env.CANTRIP_CUA_TEST_BINARY?.trim();
const workerRoot = fileURLToPath(new URL("../", import.meta.url));

// This launches dist/index.js, not a subset of worker components. Build the
// worker first. Only the test's own processes and temporary data are stopped.
it.skipIf(!binary || !helper || process.platform === "win32").each(
  (["gui", "terminal"] as const).flatMap((origin) =>
    (["completed", "provider", "question"] as const).map((interruption) => ({
      origin,
      interruption,
    })),
  ),
)(
  "restores $origin work after worker loss during $interruption and continues from the other view",
  async ({ origin, interruption }) => {
    const interrupted = interruption !== "completed";
    const questionMode = interruption === "question";
    const mode = questionMode ? ("plan" as const) : ("default" as const);
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-worker-restart-"));
    const home = path.join(root, "home");
    const dataDirectory = path.join(root, "server");
    const workerData = path.join(root, "worker");
    const cwd = path.join(root, "workspace");
    await Promise.all([home, workerData, cwd].map((dir) => mkdir(dir)));
    execFileSync("git", ["init", "-q", cwd]);
    const fakeHelper = path.join(root, "fake-cua");
    await writeFile(
      fakeHelper,
      `#!/bin/sh\nexec '${helper!.replaceAll("'", "'\\''")}' --backend fake "$@"\n`,
      { mode: 0o700 },
    );
    const inference: Record<string, any>[] = [];
    const issuedCua = new Set<number>();
    const verifiedImages: number[] = [];
    const modelErrors: string[] = [];
    const provider = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      if (request.method !== "POST") {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ data: [{ id: "gpt-5" }] }));
        return;
      }
      const body = JSON.parse(raw);
      inference.push(body);
      const lastUser = JSON.stringify(
        body.input?.findLast(
          (entry: any) =>
            entry.role === "user" &&
            /WORKER_INPUT_[12]/.test(JSON.stringify(entry)),
        ),
      );
      const index = Number(lastUser?.match(/WORKER_INPUT_(\d+)/)?.[1]);
      let item: Record<string, any>;
      if (interruption === "provider" && index === 1) {
        // Keep the real native model request open until its own worker dies.
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({ type: "response.created", response: { id: "pending-model" } })}\n\n`,
        );
        return;
      }
      if (!issuedCua.has(index)) {
        const inventory =
          body.tools?.flatMap((tool: any) =>
            tool.type === "namespace"
              ? tool.tools.map((entry: any) => ({
                  ...entry,
                  namespace: tool.name,
                }))
              : [tool],
          ) ?? [];
        const tool = inventory.find((tool: any) =>
          questionMode
            ? tool.name === "request_user_input"
            : (tool.namespace?.includes("cantrip_cua") && tool.name === "js") ||
              tool.name === "mcp__cantrip_cua__js",
        );
        if (!tool) {
          modelErrors.push(
            `Missing CUA in worker generation ${index}: ${JSON.stringify(inventory.map((tool: any) => tool.name))}`,
          );
          response.writeHead(400).end("Missing test tool");
          return;
        }
        issuedCua.add(index);
        item = {
          id: `cua-${index}`,
          type: "function_call",
          call_id: `cua-${index}`,
          name: tool.name,
          ...(tool.namespace ? { namespace: tool.namespace } : {}),
          arguments: JSON.stringify(
            questionMode
              ? {
                  questions: [
                    {
                      id: "choice",
                      header: "Choice",
                      question: `QUESTION_PROMPT_${index}`,
                      options: [
                        {
                          label: "First",
                          description: "First fixture option.",
                        },
                        {
                          label: "Second",
                          description: "Second fixture option.",
                        },
                      ],
                    },
                  ],
                }
              : {
                  script:
                    "await cua.attach({targetId:'fake-window',targetGeneration:1}); await cua.snapshot();",
                },
          ),
        };
      } else {
        const content = body.input
          .filter(
            (entry: any) =>
              entry.type === "function_call_output" &&
              entry.call_id === `cua-${index}`,
          )
          .flatMap((entry: any) => entry.output);
        if (questionMode) {
          if (!JSON.stringify(content).includes("First"))
            modelErrors.push("The fresh question did not receive its answer");
        } else if (
          content.some(
            (entry: any) =>
              entry.type === "input_image" &&
              /^data:image\/png;base64,/.test(entry.image_url),
          )
        )
          verifiedImages.push(index);
        else
          modelErrors.push(
            `No CUA image reached the provider for turn ${index}: ${JSON.stringify(content).slice(0, 4000)}`,
          );
        item = {
          type: "message",
          role: "assistant",
          id: `answer-${index}`,
          phase: "final_answer",
          content: [{ type: "output_text", text: `WORKER_RESULT_${index}` }],
        };
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id: `worker-${index}` } },
        {
          type: "response.output_item.done",
          item,
        },
        {
          type: "response.completed",
          response: {
            id: `worker-${index}`,
            usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
          },
        },
      ])
        response.write(
          `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
      response.end();
    });
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    const modelBaseUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
    const workerId = randomUUID();
    const token = randomUUID();
    const config: ServerConfig = {
      agentModel: "gpt-5",
      agentModelProvider: "ollama",
      appOrigins: ["http://127.0.0.1:5173"],
      authMode: "none",
      bootstrapMode: "pnpm-dev",
      deploymentMode: "local",
      allowInsecureRemote: false,
      workerLinkPeer: {
        directRoutes: { local: true, lan: false, wan: false },
        relayOnly: false,
        stunUrls: [],
        interfacePolicy: { mode: "default", interfaces: [] },
        vpnPolicy: { defaultRoute: "wan", lanAllowlist: [] },
        negotiationTimeoutMs: 8000,
        upgradeProbeTimeoutMs: 15000,
        maxPeerSessionsPerClient: 4,
        maxPeerSessionsPerWorker: 32,
        invalidHandshakeRatePerMinute: 60,
        laneLimits: Object.fromEntries(
          ["events", "interactive", "stream", "realtime", "bulk"].map(
            (lane) => [
              lane,
              {
                maxChannels: 64,
                maxQueuedFrames: 256,
                maxQueuedBytes: 4194304,
                maxBytesPerSecond: 16777216,
              },
            ],
          ),
        ) as ServerConfig["workerLinkPeer"]["laneLimits"],
      },
      dataDirectory,
      host: "127.0.0.1",
      port: 4310,
      // All inference is handled by the isolated deterministic provider.
      ollamaBaseUrl: modelBaseUrl,
      workerToken: token,
    };
    const database = await connectDatabase(config);
    const bridge = new WorkerBridge();
    const app = await buildApp({
      config,
      database,
      workerBridge: bridge,
      logger: false,
    });
    const nativeResponses: { url: string; status: number; payload: string }[] =
      [];
    app.addHook("onSend", async (request, reply, payload) => {
      if (request.url.startsWith("/api/internal/native-"))
        nativeResponses.push({
          url: request.url,
          status: reply.statusCode,
          payload: String(payload).slice(0, 2000),
        });
      return payload;
    });
    const serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const serverId = (
      await app.inject({ method: "GET", url: "/api/bootstrap" })
    ).json().server.id as string;
    let child: ChildProcess | undefined;
    let exited: Promise<unknown> | undefined;
    let output = "";
    const master = generateAccountMasterKey();
    const key = (
      component: Parameters<typeof deriveComponentKey>[0]["component"],
    ) =>
      deriveComponentKey({
        accountMasterKey: master,
        ownerId,
        component,
        keyRevision: 1,
      });
    const api = async (method: "GET" | "POST", url: string, payload?: any) => {
      const response = await app.inject({
        method,
        url,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode, response.body).toBeLessThan(300);
      return response.json();
    };
    const launch = () => {
      child = spawn(
        process.execPath,
        [
          "--import",
          path.join(workerRoot, "test/worker-process-isolation.mjs"),
          path.join(workerRoot, "dist/index.js"),
        ],
        {
          cwd: home,
          // Deliberately no inherited account/provider/worker configuration.
          env: {
            PATH: process.env.PATH,
            HOME: home,
            TMPDIR: root,
            XDG_CONFIG_HOME: path.join(home, ".config"),
            CANTRIP_CODEX_BIN: binary,
            CANTRIP_CUA_BIN: fakeHelper,
            CANTRIP_CLI_BIN: path.join(
              workerRoot,
              "../cantrip_cli/target/debug/cantrip",
            ),
            CANTRIP_WORKER_DATA_DIR: workerData,
            CANTRIP_WORKER_ID: workerId,
            CANTRIP_WORKER_NAME: "Isolated restart acceptance",
            CANTRIP_SERVER_URL: serverUrl,
            CANTRIP_WORKER_DEVELOPMENT_BOOTSTRAP: "true",
            CANTRIP_WORKER_TOKEN: token,
            CANTRIP_CODE_ROOT: path.join(root, "no-code-installation"),
          },
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      exited = once(child, "exit");
      child.stdout!.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr!.on("data", (chunk) => {
        output += chunk;
      });
    };
    const stop = async () => {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        process.kill(-child.pid, "SIGKILL");
        await exited;
      }
    };
    try {
      const clientId = randomUUID();
      const pair = await generateHpkeKeyPair();
      const publicKey = await exportHpkePublicKey(pair.publicKey);
      await api("POST", "/api/encryption/profile/initialize", {
        profile: {
          formatVersion: 1,
          activeMasterKeyRevision: 1,
          passwordKdf: null,
          passwordWrappedMasterKey: null,
          payloadMigrationStatus: "pending",
        },
        initialClient: {
          id: clientId,
          label: "Restart test client",
          publicKey,
          wrappedMasterKey: await wrapAccountMasterKeyForClient({
            accountMasterKey: master,
            clientId,
            clientPublicKey: publicKey,
            masterKeyRevision: 1,
            ownerId,
          }),
        },
      });
      launch();
      await vi.waitFor(
        () => {
          expect(child?.exitCode, output).toBeNull();
          expect(bridge.isConnected(workerId), output).toBe(true);
        },
        { timeout: 60000, interval: 100 },
      );
      let principal: any;
      await vi.waitFor(
        async () => {
          const result = await api("GET", "/api/encryption/principals");
          principal = result.find((entry: any) => entry.workerId === workerId);
          expect(principal, output).toBeTruthy();
        },
        { timeout: 20000, interval: 100 },
      );
      await api("POST", `/api/encryption/principals/${principal.id}/approve`, {
        expectedRevision: principal.revision,
      });
      for (const component of workerEncryptionComponentScopeSchema.options) {
        await api("POST", `/api/encryption/principals/${principal.id}/grants`, {
          component,
          keyRevision: 1,
          wrappedKey: await wrapComponentKeyForWorker({
            ownerId,
            workerId,
            component,
            componentKey: key(component),
            keyRevision: 1,
            workerPublicKey: principal.publicKey,
          }),
        });
      }
      const encryption = await bridge.request(workerId, {
        type: "worker.encryption.refresh",
        component: "chat-content",
        keyRevision: 1,
      });
      expect(encryption).toBeTruthy();
      const repository = database.repository;
      const modelProvider = await repository.createModelProvider(ownerId, {
        id: randomUUID(),
        name: "Restart acceptance",
        kind: "openai-compatible",
        baseUrl: modelBaseUrl,
        initialAccount: null,
        protectedApiKey: null,
      });
      await repository.reconcileProviderModelCatalog(
        ownerId,
        modelProvider.id,
        {
          availabilityScope: "restart-fixture",
          availableNativeModelIds: new Set(["gpt-5"]),
          models: [
            {
              nativeModelId: "gpt-5",
              canonicalModelId: "gpt-5",
              displayName: "Restart model",
              description: null,
              contextWindow: 128000,
              maxOutputTokens: null,
              inputModalities: ["text", "image"],
              outputModalities: ["text"],
              supportsTools: true,
              supportsParallelTools: true,
              supportsStructuredOutput: null,
              supportsVision: true,
              supportsReasoning: null,
              supportedReasoningEfforts: [],
              defaultReasoningEffort: null,
              reasoningMandatory: null,
              family: null,
              parameterSize: null,
              quantization: null,
              digest: null,
              metadataSource: "codex",
              matchConfidenceBasisPoints: null,
              rawMetadata: {},
            },
          ],
        },
      );
      const profile = await repository.createModelProfile(ownerId, {
        name: "Restart model",
        routes: [
          { providerId: modelProvider.id, modelName: "gpt-5", enabled: true },
        ],
      });
      expect(profile).toBeTruthy();
      await repository.updateSettings(ownerId, {
        defaultModelId: profile!.id,
        computerUseEnabled: true,
        defaultPermissionProfileId: ":yolo",
      });
      const projectId = randomUUID();
      const label = (recordKind: "project" | "chat", rowId: string) =>
        encryptPrivateDisplayLabel({
          ownerId,
          recordKind,
          rowId,
          keyRevision: 1,
          componentKey: key("private-surface-metadata"),
          label: "Worker restart acceptance",
        });
      const project = await repository.createGithubProject(ownerId, {
        id: projectId,
        workerId,
        nameProtection: await label("project", projectId),
        repositoryBlindIndex: "R".repeat(43),
        repositoryId: randomUUID(),
        nameWithOwner: "Fixture/WorkerRestart",
        url: "https://example.invalid/Fixture/WorkerRestart",
      });
      await repository.completeGithubProjectSetup(
        ownerId,
        project.id,
        workerId,
        {
          path: cwd,
          displayPath: "Worker restart fixture",
          reused: false,
          updated: false,
          warning: null,
        },
      );
      const chatId = randomUUID();
      const chat = await repository.createChat(ownerId, project.id, {
        id: chatId,
        titleProtection: await label("chat", chatId),
        worktreeMode: "agent-managed",
      });
      expect(chat).toBeTruthy();
      if (questionMode)
        await repository.updateChatPlanMode(ownerId, chatId, "plan");
      await api("POST", `/api/chats/${chatId}/preparation`);
      const prepared = async () =>
        (await api("GET", `/api/chats/${chatId}/preparation`)).preparation;
      await vi.waitFor(
        async () => {
          expect(await prepared(), output).toMatchObject({ phase: "ready" });
        },
        { timeout: 30000, interval: 100 },
      );
      const before = await prepared();
      const context = (await repository.getChatExecutionContext(
        ownerId,
        chatId,
      ))!;
      expect(context.threadId).toBeTruthy();
      const snapshot = async () => {
        const context = {
          serverId,
          surfaceKind: "terminal" as const,
          surfaceId: before.terminalId,
          operationId: randomUUID(),
          direction: "request" as const,
          sequence: 0,
        };
        const result = (await bridge.request(workerId, {
          type: "terminal.snapshot",
          terminalId: before.terminalId,
          serverId,
          operationId: context.operationId,
          sequence: 0,
          protectedRequest: await encryptSurfaceStreamPayload({
            ownerId,
            context,
            keyRevision: 1,
            componentKey: key("surface-private-state"),
            plaintext: Buffer.from(
              JSON.stringify({ type: "terminal.snapshot", maxChars: 100000 }),
            ),
          }),
        })) as any;
        return JSON.parse(
          Buffer.from(
            await decryptSurfaceStreamPayload({
              ownerId,
              context: { ...context, direction: "response" },
              keyRevision: 1,
              componentKey: key("surface-private-state"),
              opaque: result.protectedResponse,
            }),
          ).toString(),
        );
      };
      await vi.waitFor(
        async () => {
          const frame = await snapshot();
          expect(frame).toMatchObject({
            ok: true,
            result: { status: "running" },
          });
          expect(frame.result.data).toContain("gpt-5");
        },
        { timeout: 10000 },
      );
      expect(inference).toEqual([]);
      const terminalInput = async (data: string) => {
        const context = {
          serverId,
          surfaceKind: "terminal" as const,
          surfaceId: before.terminalId,
          operationId: randomUUID(),
          direction: "input" as const,
          sequence: 0,
        };
        await bridge.request(workerId, {
          type: "terminal.input",
          terminalId: before.terminalId,
          serverId,
          operationId: context.operationId,
          sequence: 0,
          complete: true,
          protectedData: await encryptSurfaceStreamPayload({
            ownerId,
            context,
            keyRevision: 1,
            componentKey: key("surface-private-state"),
            plaintext: Buffer.from(
              JSON.stringify({ type: "terminal.input", data }),
            ),
          }),
        });
      };
      const messages = () => repository.listEncryptedMessages(ownerId, chatId);
      const texts = async () =>
        Promise.all(
          (await messages()).map(async (message) => {
            const opened = await decryptChatMessageProtectedContent({
              ownerId,
              messageId: message.id,
              componentKey: key("chat-content"),
              keyRevision: 1,
              encrypted: message.protectedContent,
              publicClassification: {
                role: message.role,
                mode: message.mode,
                attachmentIds: message.attachmentIds,
              },
            });
            const text = JSON.stringify(opened.content);
            if (text.includes("WORKER_RESULT_"))
              expect(message.mode).toBe(mode);
            return text;
          }),
        );
      const interactions = async () =>
        (await api("GET", `/api/agent-requests?chatId=${chatId}`)) as any[];
      const respond = async (request: any) => {
        const classification = { kind: "userInput" as const };
        return await app.inject({
          method: "POST",
          url: `/api/agent-requests/${request.id}/respond`,
          payload: {
            idempotencyKey: randomUUID(),
            classification,
            protectedResponse: await encryptInteractionResponseContent({
              ownerId,
              requestKey: request.requestKey,
              keyRevision: 1,
              componentKey: key("interaction-content"),
              content: {
                version: 1,
                classification,
                response: {
                  kind: "userInput",
                  answers: { choice: { answers: ["First"] } },
                },
              },
            }),
          },
        });
      };
      const pendingQuestion = async (index: number) => {
        let pending: any;
        await vi.waitFor(
          async () => {
            expect(modelErrors).toEqual([]);
            const current = (await interactions()).filter(
              (request) => request.status === "pending",
            );
            expect(current).toHaveLength(1);
            pending = current[0];
            expect((await snapshot()).result.data).toContain(
              `QUESTION_PROMPT_${index}`,
            );
          },
          { timeout: 15000 },
        );
        return pending;
      };
      let oldQuestion: any;
      const send = async (index: number, origin: "gui" | "terminal") => {
        const prompt = `WORKER_INPUT_${index}`;
        if (origin === "terminal") {
          await terminalInput(prompt);
          await vi.waitFor(
            async () =>
              expect((await snapshot()).result.data).toContain(prompt),
            { timeout: 10000 },
          );
          await terminalInput("\r");
        } else {
          const id = randomUUID();
          const classification = {
            role: "user" as const,
            mode,
            attachmentIds: [],
          };
          const message = {
            id,
            classification,
            idempotencyKey: id,
            reasoningEffort: null,
            protectedContent: await encryptChatMessageProtectedContent({
              ownerId,
              messageId: id,
              keyRevision: 1,
              componentKey: key("chat-content"),
              content: {
                version: 1,
                classification,
                content: [{ type: "text", text: prompt }],
              },
            }),
          };
          const queuedId = randomUUID();
          await api("POST", `/api/chats/${chatId}/turns`, {
            message,
            modelId: profile!.id,
            queuedPrompt: {
              id: queuedId,
              classification: { mode, attachmentIds: [] },
              protectedContent: await encryptQueuedPromptProtectedContent({
                ownerId,
                promptId: queuedId,
                keyRevision: 1,
                componentKey: key("chat-content"),
                content: {
                  version: 1,
                  classification: { mode, attachmentIds: [] },
                  text: prompt,
                },
              }),
              modelId: profile!.id,
              reasoningEffort: null,
              worktreeId: null,
              frozen: false,
              idempotencyKey: id,
              pendingMessage: message,
            },
          });
        }
        if (index === 1 && interrupted) {
          await vi.waitFor(
            async () => {
              expect(modelErrors).toEqual([]);
              expect(inference).toHaveLength(1);
              expect(
                (await repository.getChatExecutionContext(ownerId, chatId))
                  ?.status,
              ).toBe(questionMode ? "waiting-for-approval" : "running");
              expect(
                (await texts()).filter((text) => text.includes(prompt)),
              ).toHaveLength(1);
            },
            { timeout: 15000 },
          );
          if (questionMode) oldQuestion = await pendingQuestion(1);
          return;
        }
        if (questionMode) {
          const fresh = await pendingQuestion(2);
          expect(fresh.requestKey).not.toBe(oldQuestion.requestKey);
          expect(fresh.provenance.turnId).not.toBe(
            oldQuestion.provenance.turnId,
          );
          const stale = await respond(oldQuestion);
          expect(stale.statusCode, stale.body).toBe(409);
          if (origin === "gui") await terminalInput("\r");
          else {
            const accepted = await respond(fresh);
            expect(accepted.statusCode, accepted.body).toBe(200);
          }
          await vi.waitFor(async () =>
            expect(
              (await interactions()).find((request) => request.id === fresh.id)
                ?.status,
            ).toBe("resolved"),
          );
        }
        try {
          await vi.waitFor(
            async () => {
              expect(modelErrors).toEqual([]);
              expect(inference).toHaveLength(index * 2 - (interrupted ? 1 : 0));
              if (!questionMode) expect(verifiedImages).toContain(index);
              expect(JSON.stringify(inference.at(-1)?.input)).toContain(prompt);
              const saved = await texts();
              for (const marker of [prompt, `WORKER_RESULT_${index}`])
                expect(
                  saved.filter((text) => text.includes(marker)),
                ).toHaveLength(1);
              expect((await snapshot()).result.data).toContain(
                `WORKER_RESULT_${index}`,
              );
              expect(
                (await repository.getChatExecutionContext(ownerId, chatId))
                  ?.status,
              ).toBe("idle");
            },
            { timeout: 20000, interval: 150 },
          );
        } catch (error) {
          console.error(
            "RECOVERY DIAGNOSTICS",
            JSON.stringify({
              frame: await snapshot(),
              context: await repository.getChatExecutionContext(
                ownerId,
                chatId,
              ),
              nativeResponses,
            }),
          );
          throw error;
        }
      };
      await send(1, origin);
      expect(verifiedImages).toEqual(interrupted ? [] : [1]);
      const beforeIds = (await messages()).map((message) => message.id);
      const firstPid = child!.pid;
      await stop();
      await vi.waitFor(() => expect(bridge.isConnected(workerId)).toBe(false));
      launch();
      await vi.waitFor(
        () => expect(bridge.isConnected(workerId), output).toBe(true),
        { timeout: 60000 },
      );
      const restored = await bridge.request(workerId, {
        type: "worker.encryption.refresh",
        component: "chat-content",
        keyRevision: 1,
      });
      expect(restored).toMatchObject({
        component: "chat-content",
        status: {
          state: "ready",
          principalId: principal.id,
          grants: (encryption as any).status.grants,
        },
      });
      expect(child!.pid).not.toBe(firstPid);
      await vi.waitFor(
        async () => {
          const current = await prepared();
          expect(
            current,
            JSON.stringify(current) + "\n" + output,
          ).toMatchObject({
            phase: "ready",
            terminalId: before.terminalId,
          });
          expect(current.generation).not.toBe(before.generation);
        },
        { timeout: 30000, interval: 100 },
      );
      const recovered = (await repository.getChatExecutionContext(
        ownerId,
        chatId,
      ))!;
      expect(recovered.threadId).toBe(context.threadId);
      await vi.waitFor(
        async () => {
          const frame = await snapshot();
          expect(frame, JSON.stringify(frame)).toMatchObject({
            ok: true,
            result: { status: "running" },
          });
          expect(frame.result.data).toContain("gpt-5");
        },
        { timeout: 10000 },
      );
      expect(inference).toHaveLength(interrupted ? 1 : 2);
      expect((await messages()).map((message) => message.id)).toEqual(
        expect.arrayContaining(beforeIds),
      );
      if (interrupted) {
        await vi.waitFor(
          async () => {
            const current = await repository.getChatExecutionContext(
              ownerId,
              chatId,
            );
            expect(["idle", "failed"]).toContain(current?.status);
            expect(current?.executionLaneId).toBeNull();
            expect(
              (await interactions()).filter(
                (request) => request.status === "pending",
              ),
            ).toEqual([]);
          },
          { timeout: 15000 },
        );
        if (oldQuestion) {
          const stale = await respond(oldQuestion);
          expect(stale.statusCode, stale.body).toBe(409);
        }
      } else
        expect((await messages()).map((message) => message.id)).toEqual(
          beforeIds,
        );
      await send(2, origin === "gui" ? "terminal" : "gui");
      expect(verifiedImages).toEqual(
        questionMode ? [] : interrupted ? [2] : [1, 2],
      );
      await vi.waitFor(
        async () => {
          const saved = await texts();
          for (const text of [
            "WORKER_INPUT_1",
            ...(interrupted ? [] : ["WORKER_RESULT_1"]),
            "WORKER_INPUT_2",
            "WORKER_RESULT_2",
          ])
            expect(
              saved.filter((item) => item.includes(text)),
              `${text}: ${JSON.stringify(saved)}`,
            ).toHaveLength(1);
          if (interrupted)
            expect(saved.some((text) => text.includes("WORKER_RESULT_1"))).toBe(
              false,
            );
          expect(
            (await repository.getChatExecutionContext(ownerId, chatId))?.status,
          ).toBe("idle");
          expect(
            (await messages()).filter((message) =>
              beforeIds.includes(message.id),
            ),
          ).toHaveLength(beforeIds.length);
        },
        { timeout: 15000, interval: 150 },
      );
    } catch (error) {
      console.error("WORKER RECOVERY FAILURE", error);
      throw new Error(`${String(error)}\nIsolated worker output:\n${output}`, {
        cause: error,
      });
    } finally {
      await stop();
      await app.close();
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  },
  150000,
);
