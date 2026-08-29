import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  unprobedCodexRuntimeReport,
  type ProviderAccessTokenLease,
  type WorkerCommand,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  CodexAppServer,
  type CodexProcessLauncher,
} from "../src/codex/app-server.js";
import { ProviderAccessTokenClient } from "../src/provider-access-tokens.js";
import { createServerManagedGrokClient } from "../src/server-managed-grok.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const compatibility = {
  ...unprobedCodexRuntimeReport,
  compatibility: "compatible" as const,
  degradedReasons: [],
  initialize: {
    experimentalApi: true,
    platformFamily: "unix",
    platformOs: "macos",
    userAgent: "codex_cli_rs/0.151.0",
  },
  methods: {
    ...unprobedCodexRuntimeReport.methods,
    "account/login/start": "available" as const,
  },
  version: { raw: "codex-cli 0.151.0", semantic: "0.151.0" },
};

const chatGptProvider = {
  accountId: "chatgpt-account",
  apiKey: null,
  baseUrl: "https://chatgpt.com/backend-api/codex",
  credentialHomeKey: "chatgpt-home",
  id: "chatgpt-provider",
  kind: "chatgpt" as const,
  name: "ChatGPT",
};

const grokProvider = {
  accountId: "grok-account",
  apiKey: null,
  baseUrl: "https://cli-chat-proxy.grok.com/v1",
  credentialHomeKey: "grok-home",
  id: "grok-provider",
  kind: "grok" as const,
  name: "Grok",
};

function lease(
  kind: "chatgpt" | "grok",
  revision: number,
): ProviderAccessTokenLease {
  return {
    accessToken: `${kind}-access-${revision}`,
    credentialRevision: revision,
    email: `${kind}@example.test`,
    expiresAt: "2030-01-01T01:00:00.000Z",
    issuedAt: "2030-01-01T00:00:00.000Z",
    leaseExpiresAt: "2030-01-01T00:05:00.000Z",
    planType: kind === "chatgpt" ? "pro" : "SuperGrok",
    providerAccountId:
      kind === "chatgpt" ? chatGptProvider.accountId : grokProvider.accountId,
    providerId: kind === "chatgpt" ? chatGptProvider.id : grokProvider.id,
    providerIdentity:
      kind === "chatgpt"
        ? {
            accountId: "upstream-workspace",
            kind: "chatgpt",
            userId: "chatgpt-user",
          }
        : { kind: "grok", userId: "grok-user" },
    providerKind: kind,
  };
}

async function fakeCodexBinary(directory: string): Promise<string> {
  const binary = path.join(directory, "fake-codex.cjs");
  const wsEntry = createRequire(import.meta.url).resolve("ws");
  await writeFile(
    binary,
    `const { WebSocketServer } = require(${JSON.stringify(wsEntry)});

let grokBaseUrl = null;
for (const argument of process.argv.slice(2)) {
  const prefix = "model_providers.cantrip_runtime.base_url=";
  if (argument.startsWith(prefix)) {
    grokBaseUrl = JSON.parse(argument.slice(prefix.length));
  }
}

const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => {
  const address = server.address();
  process.stdout.write("listening on: ws://127.0.0.1:" + address.port + "\\n");
});

function completeTurn(socket, turnId, text) {
  socket.send(JSON.stringify({
    method: "item/completed",
    params: {
      threadId: "portable-thread",
      turnId,
      item: {
        type: "agentMessage",
        id: "portable-message",
        text,
        phase: "final_answer"
      }
    }
  }));
  socket.send(JSON.stringify({
    method: "turn/completed",
    params: {
      threadId: "portable-thread",
      turn: { id: turnId, status: "completed", error: null, durationMs: 1 }
    }
  }));
}

server.on("connection", (socket) => {
  let chatGptAuthenticated = false;
  let chatGptAccessToken = null;
  let freshThreadCompactionRejected = false;
  let pendingChatGptTurn = null;
  let resetConsumed = false;
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.id === 9001 && message.result) {
      if (message.result.accessToken !== "chatgpt-access-2") process.exit(31);
      const pending = pendingChatGptTurn;
      pendingChatGptTurn = null;
      completeTurn(socket, pending.turnId, pending.text);
      return;
    }
    if (message.id === undefined) return;
    if (message.method === "initialize") {
      socket.send(JSON.stringify({ id: message.id, result: {} }));
      return;
    }
    if (message.method === "account/login/start") {
      if (
        message.params.type !== "chatgptAuthTokens" ||
        !["chatgpt-access-1", "chatgpt-access-2"].includes(
          message.params.accessToken
        ) ||
        message.params.chatgptAccountId !== "upstream-workspace"
      ) process.exit(32);
      chatGptAuthenticated = true;
      chatGptAccessToken = message.params.accessToken;
      socket.send(JSON.stringify({
        id: message.id,
        result: { type: "chatgptAuthTokens" }
      }));
      return;
    }
    if (message.method === "model/list") {
      socket.send(JSON.stringify({
        id: message.id,
        result: {
          data: [{
            id: "picker-gpt-5.6-sol",
            model: "gpt-5.6-sol",
            displayName: "GPT-5.6 Sol",
            description: "Portable ChatGPT model",
            hidden: false,
            isDefault: true,
            inputModalities: ["text"],
            supportedReasoningEfforts: [{
              reasoningEffort: "medium",
              description: "Balanced"
            }],
            defaultReasoningEffort: "medium",
            modelSpecialty: "coding",
            supportsPersonality: false,
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            additionalSpeedTiers: [],
            serviceTiers: [],
            defaultServiceTier: null
          }],
          nextCursor: null
        }
      }));
      return;
    }
    if (message.method === "account/rateLimits/read") {
      if (chatGptAccessToken === "chatgpt-access-1") {
        socket.send(JSON.stringify({
          id: message.id,
          error: {
            code: -32000,
            message: 'failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized; body={"error":{"code":"token_expired","message":"Provided authentication token is expired."}}'
          }
        }));
        return;
      }
      socket.send(JSON.stringify({
        id: message.id,
        result: {
          rateLimits: {
            primary: null,
            secondary: {
              usedPercent: resetConsumed ? 0 : 24,
              windowDurationMins: 10080,
              resetsAt: 1787000000
            }
          },
          rateLimitsByLimitId: {
            other: {
              primary: {
                usedPercent: 100,
                windowDurationMins: 10080,
                resetsAt: 1787000000
              },
              secondary: null
            }
          },
          rateLimitResetCredits: resetConsumed ? {
            availableCount: 0,
            credits: []
          } : {
            availableCount: 1,
            credits: [{
              id: "reset-1",
              resetType: "codexRateLimits",
              status: "available",
              grantedAt: 1786000000,
              expiresAt: 1789000000,
              title: "Usage reset",
              description: null
            }]
          }
        }
      }));
      return;
    }
    if (message.method === "account/rateLimitResetCredit/consume") {
      if (
        message.params.idempotencyKey !==
          "2c580d9a-ab1d-4ec6-bf03-4e5355f898a8" ||
        message.params.creditId !== "reset-1"
      ) process.exit(34);
      resetConsumed = true;
      socket.send(JSON.stringify({
        id: message.id,
        result: { outcome: "reset" }
      }));
      return;
    }
    if (message.method === "thread/start") {
      socket.send(JSON.stringify({
        id: message.id,
        result: { thread: { id: "portable-thread" } }
      }));
      return;
    }
    if (message.method === "thread/resume") {
      socket.send(JSON.stringify({
        id: message.id,
        result: { thread: { id: message.params.threadId } }
      }));
      return;
    }
    if (message.method === "turn/start") {
      const rejectFreshThreadCompaction =
        message.params.clientUserMessageId ===
          "cantrip:grok-fresh-compaction-message" &&
        !freshThreadCompactionRejected;
      if (
        message.params.threadId === "stale-thread" ||
        rejectFreshThreadCompaction
      ) {
        if (rejectFreshThreadCompaction) {
          freshThreadCompactionRejected = true;
        }
        socket.send(JSON.stringify({
          id: message.id,
          error: {
            code: -32602,
            message: '{"code":"invalid-argument","error":"Could not decode the compaction blob. Ensure it is unmodified from the compact response."}'
          }
        }));
        return;
      }
      const turnId = chatGptAuthenticated ? "chatgpt-turn" : "grok-turn";
      const text = chatGptAuthenticated
        ? "Portable ChatGPT turn completed."
        : "Portable Grok turn completed.";
      socket.send(JSON.stringify({ id: message.id, result: { turn: { id: turnId } } }));
      setTimeout(async () => {
        if (chatGptAuthenticated) {
          pendingChatGptTurn = { turnId, text };
          socket.send(JSON.stringify({
            id: 9001,
            method: "account/chatgptAuthTokens/refresh",
            params: {
              reason: "unauthorized",
              previousAccountId: "upstream-workspace"
            }
          }));
          return;
        }
        const response = await fetch(grokBaseUrl + "/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}"
        });
        if (!response.ok) process.exit(33);
        completeTurn(socket, turnId, text);
      }, 25);
      return;
    }
    socket.send(JSON.stringify({
      id: message.id,
      error: { code: -32601, message: "unsupported" }
    }));
  });
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
`,
    "utf8",
  );
  return binary;
}

const launchFakeCodex: CodexProcessLauncher = (binary, arguments_, options) =>
  spawn(process.execPath, [binary, ...arguments_], {
    ...options,
    stdio: ["pipe", "pipe", "pipe"],
  });

function turnOptions(
  cwd: string,
  provider: Extract<WorkerCommand, { type: "chat.turn" }>["provider"],
  modelName: string,
) {
  return {
    attachments: [],
    chatId: `${provider.kind}-chat`,
    clientMessageId: `${provider.kind}-message`,
    cwd,
    isPrimary: true,
    mcpServers: [],
    model: {
      id: `${provider.kind}-model-profile`,
      name: modelName,
      reasoningEffort: null,
      routeId: `${provider.kind}-route`,
    },
    permissionProfileId: null,
    planMode: "default" as const,
    prompt: `Complete the ${provider.kind} portability check.`,
    provider,
    skillNames: [],
    threadId: null,
    worktreeMode: "agent-managed" as const,
    worktreePolicy: "required-for-writes" as const,
  };
}

describe("portable provider accounts on a brand-new worker", () => {
  it("lists models and completes ChatGPT and Grok turns without local credentials", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-portable-auth-"));
    temporaryDirectories.push(root);
    const binary = await fakeCodexBinary(root);
    const credentialRoot = path.join(root, "provider-credentials");
    const chatGptHome = path.join(credentialRoot, "chatgpt");
    const grokHome = path.join(credentialRoot, "grok");
    const leaseRequests: Array<{
      forceRefresh?: boolean;
      providerId: string;
    }> = [];
    const accessTokens = {
      async get(
        providerId: string,
        _providerAccountId: string,
        request: { forceRefresh?: boolean } = {},
      ) {
        leaseRequests.push({
          forceRefresh: request.forceRefresh ?? false,
          providerId,
        });
        return lease(
          providerId === chatGptProvider.id ? "chatgpt" : "grok",
          request.forceRefresh ? 2 : 1,
        );
      },
    } as unknown as ProviderAccessTokenClient;
    const grokUpstreamTokens: string[] = [];
    const grok = createServerManagedGrokClient(
      grokProvider.id,
      grokProvider.accountId,
      accessTokens,
      {
        fetch: async (input, init) => {
          const headers = new Headers(init?.headers);
          grokUpstreamTokens.push(headers.get("authorization") ?? "");
          expect(headers.get("x-userid")).toBe("grok-user");
          expect(headers.get("x-email")).toBe("grok@example.test");
          const url = new URL(String(input));
          if (url.pathname.endsWith("/models")) {
            return Response.json({ data: [{ id: "grok-code-fast-1" }] });
          }
          if (url.pathname.endsWith("/billing")) {
            return Response.json({
              config: {
                creditUsagePercent: 31,
                currentPeriod: {
                  type: "USAGE_PERIOD_TYPE_WEEKLY",
                  end: "2030-01-08T00:00:00.000Z",
                },
              },
            });
          }
          return Response.json({ id: "portable-grok-response" });
        },
      },
    );
    const chatGptCatalog = new CodexAppServer(
      binary,
      path.join(root, "chatgpt-catalog-runtime"),
      chatGptHome,
      compatibility,
      undefined,
      undefined,
      accessTokens,
      launchFakeCodex,
    );
    const chatGptRuntime = new CodexAppServer(
      binary,
      path.join(root, "chatgpt-turn-runtime"),
      chatGptHome,
      compatibility,
      undefined,
      undefined,
      accessTokens,
      launchFakeCodex,
    );
    const grokRuntime = new CodexAppServer(
      binary,
      path.join(root, "grok-turn-runtime"),
      grokHome,
      compatibility,
      undefined,
      async (provider) => ({
        ...provider,
        baseUrl: await grok.localProxyBaseUrl(),
      }),
      accessTokens,
      launchFakeCodex,
    );

    try {
      const [chatGptCatalogResult, chatGptQuotaSnapshot] = await Promise.all([
        chatGptCatalog.listChatGptModels(chatGptProvider),
        chatGptCatalog.readQuotaSnapshot(chatGptProvider),
      ]);
      expect(chatGptCatalogResult).toMatchObject({
        models: [{ model: "gpt-5.6-sol" }],
        weeklyUsage: { usedPercent: 24 },
      });
      expect(chatGptQuotaSnapshot).toMatchObject({
        rateLimitResetCredits: {
          availableCount: 1,
          credits: [{ id: "reset-1", status: "available" }],
        },
      });
      const resetResult = await chatGptCatalog.consumeRateLimitResetCredit(
        chatGptProvider,
        {
          idempotencyKey: "2c580d9a-ab1d-4ec6-bf03-4e5355f898a8",
          creditId: "reset-1",
        },
      );
      expect(resetResult).toMatchObject({
        outcome: "reset",
        quotaSnapshot: {
          rateLimitResetCredits: { availableCount: 0, credits: [] },
        },
      });
      expect(
        resetResult.quotaSnapshot?.windows.find(
          (window) => window.isWeeklyProjection,
        ),
      ).toMatchObject({ usedPercent: 0 });
      await expect(grok.listModels()).resolves.toMatchObject({
        models: [{ id: "grok-code-fast-1" }],
      });
      await expect(grok.weeklyUsage()).resolves.toMatchObject({
        usedPercent: 31,
      });
      await expect(
        chatGptRuntime.runTurn(
          turnOptions(root, chatGptProvider, "gpt-5.6-sol"),
        ),
      ).resolves.toMatchObject({
        status: "completed",
        text: "Portable ChatGPT turn completed.",
      });
      await expect(
        grokRuntime.runTurn(
          turnOptions(root, grokProvider, "grok-code-fast-1"),
        ),
      ).resolves.toMatchObject({
        status: "completed",
        text: "Portable Grok turn completed.",
      });
      const recoveredThreadIds: string[] = [];
      await expect(
        grokRuntime.runTurn({
          ...turnOptions(root, grokProvider, "grok-code-fast-1"),
          threadId: "stale-thread",
          onThreadLoaded: (threadId) => recoveredThreadIds.push(threadId),
        }),
      ).resolves.toMatchObject({
        status: "completed",
        text: "Portable Grok turn completed.",
        threadId: "portable-thread",
      });
      expect(recoveredThreadIds).toEqual(["stale-thread", "portable-thread"]);

      const freshThreadIds: string[] = [];
      await expect(
        grokRuntime.runTurn({
          ...turnOptions(root, grokProvider, "grok-code-fast-1"),
          chatId: "grok-fresh-compaction-chat",
          clientMessageId: "grok-fresh-compaction-message",
          onThreadLoaded: (threadId) => freshThreadIds.push(threadId),
        }),
      ).resolves.toMatchObject({
        status: "completed",
        text: "Portable Grok turn completed.",
        threadId: "portable-thread",
      });
      expect(freshThreadIds).toEqual(["portable-thread", "portable-thread"]);

      expect(await readdir(chatGptHome)).toEqual([]);
      expect(await readdir(grokHome)).toEqual([]);
      expect(grokUpstreamTokens).toEqual([
        "Bearer grok-access-1",
        "Bearer grok-access-1",
        "Bearer grok-access-1",
        "Bearer grok-access-1",
        "Bearer grok-access-1",
      ]);
      expect(leaseRequests).toEqual(
        expect.arrayContaining([
          { forceRefresh: false, providerId: chatGptProvider.id },
          { forceRefresh: true, providerId: chatGptProvider.id },
          { forceRefresh: false, providerId: grokProvider.id },
        ]),
      );
      expect(
        leaseRequests.filter(
          ({ forceRefresh, providerId }) =>
            forceRefresh && providerId === chatGptProvider.id,
        ),
      ).toHaveLength(2);
      expect(JSON.stringify(leaseRequests)).not.toContain("access-");
    } finally {
      chatGptCatalog.close();
      chatGptRuntime.close();
      grokRuntime.close();
      grok.close();
    }
  }, 30_000);
});
