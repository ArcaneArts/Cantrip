import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GrokAuthClient, normalizeGrokModel } from "../src/grok-auth-client.js";
import {
  GrokSubscriptionClient,
  normalizeGrokWeeklyUsage,
} from "../src/grok-subscription-client.js";

const temporaryDirectories: string[] = [];

async function temporaryHome() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cantrip-grok-auth-"));
  temporaryDirectories.push(directory);
  return directory;
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jwt(claims: Record<string, unknown>) {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "signature",
  ].join(".");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Grok OAuth accounts", () => {
  it("completes device login and stores rotating credentials owner-only", async () => {
    const home = await temporaryHome();
    const requests: Array<{ body: string; url: string }> = [];
    const client = new GrokAuthClient(home, {
      sleep: async () => undefined,
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({ body: String(init?.body ?? ""), url });
        if (url.endsWith("/oauth2/device/code")) {
          return json({
            device_code: "device-secret",
            expires_in: 600,
            interval: 1,
            user_code: "GROK-1234",
            verification_uri: "https://auth.x.ai/activate",
          });
        }
        if (url.endsWith("/oauth2/token")) {
          return json({
            access_token: "access-one",
            refresh_token: "refresh-one",
            expires_in: 3_600,
            id_token: jwt({ sub: "user-1", email: "grok@example.com" }),
          });
        }
        if (url.includes("/user?include=subscription")) {
          expect(new Headers(init?.headers).get("authorization")).toBe(
            "Bearer access-one",
          );
          return json({
            userId: "user-1",
            email: "grok@example.com",
            subscriptionTier: "SuperGrok",
          });
        }
        if (url.includes("/billing?format=credits")) {
          return json({
            config: {
              creditUsagePercent: 28.5,
              currentPeriod: {
                type: "USAGE_PERIOD_TYPE_WEEKLY",
                end: "2026-08-23T00:00:00.000Z",
              },
            },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });
    try {
      await expect(client.startDeviceLogin()).resolves.toMatchObject({
        userCode: "GROK-1234",
        verificationUrl: "https://auth.x.ai/activate",
      });
      let status = await client.status();
      await vi.waitFor(
        async () => {
          status = await client.status();
          expect(status.authenticated).toBe(true);
        },
        { timeout: 2_000 },
      );
      expect(status).toMatchObject({
        authenticated: true,
        authMode: "grok",
        email: "grok@example.com",
        planType: "SuperGrok",
        weeklyUsage: {
          usedPercent: 28.5,
          resetsAt: 1_787_443_200,
        },
        loginPending: false,
        loginError: null,
      });
      const deviceRequest = requests.find(({ url }) =>
        url.endsWith("/oauth2/device/code"),
      );
      expect(deviceRequest?.body).toContain("grok-cli%3Aaccess");
      expect(deviceRequest?.body).toContain("offline_access");
      const credentialPath = path.join(home, "grok-auth.json");
      expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(credentialPath, "utf8"))).toMatchObject({
        accessToken: "access-one",
        refreshToken: "refresh-one",
        userId: "user-1",
      });
    } finally {
      client.close();
    }
  });

  it("refreshes an expired token and persists refresh-token rotation", async () => {
    const home = await temporaryHome();
    await writeFile(
      path.join(home, "grok-auth.json"),
      JSON.stringify({
        version: 1,
        accessToken: "expired-access",
        refreshToken: "refresh-one",
        expiresAt: 1,
        userId: "user-1",
        email: "grok@example.com",
        planType: "SuperGrok",
      }),
      { mode: 0o600 },
    );
    const client = new GrokAuthClient(home, {
      now: () => 10_000,
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/oauth2/token")) {
          expect(String(init?.body)).toContain("refresh_token=refresh-one");
          return json({
            access_token: "access-two",
            refresh_token: "refresh-two",
            expires_in: 3_600,
          });
        }
        if (url.endsWith("/models")) {
          expect(new Headers(init?.headers).get("authorization")).toBe(
            "Bearer access-two",
          );
          return json({
            data: [
              {
                id: "grok-code-fast-1",
                contextWindow: 262_144,
                supportsReasoningEffort: true,
                reasoningEfforts: ["low", "high"],
              },
            ],
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });
    try {
      await expect(client.listModels()).resolves.toMatchObject({
        models: [
          {
            id: "grok-code-fast-1",
            contextWindow: 262_144,
            supportsReasoning: true,
            isDefault: true,
          },
        ],
      });
      expect(
        JSON.parse(await readFile(path.join(home, "grok-auth.json"), "utf8")),
      ).toMatchObject({
        accessToken: "access-two",
        refreshToken: "refresh-two",
      });
    } finally {
      client.close();
    }
  });

  it("normalizes Grok catalog metadata without inventing capabilities", () => {
    expect(
      normalizeGrokModel({
        id: "grok-4",
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        supportsReasoningEffort: false,
      }),
    ).toMatchObject({
      id: "grok-4",
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      supportsReasoning: false,
    });
    expect(normalizeGrokModel({ description: "missing id" })).toBeNull();
  });

  it("accepts only a bounded active weekly Grok billing period", () => {
    expect(
      normalizeGrokWeeklyUsage({
        config: {
          creditUsagePercent: 62.5,
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            end: "2026-08-24T00:00:00.000Z",
          },
        },
      }),
    ).toEqual({ usedPercent: 62.5, resetsAt: 1_787_529_600 });
    expect(
      normalizeGrokWeeklyUsage({
        config: {
          creditUsagePercent: 25,
          currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY" },
        },
      }),
    ).toBeNull();
  });

  it("keeps bearer credentials inside a loopback-only subscription proxy", async () => {
    const home = await temporaryHome();
    await writeFile(
      path.join(home, "grok-auth.json"),
      JSON.stringify({
        version: 1,
        accessToken: "worker-owned-token",
        refreshToken: "refresh-token",
        expiresAt: Date.now() + 3_600_000,
        userId: "user-1",
        email: "grok@example.com",
        planType: "SuperGrok",
      }),
      { mode: 0o600 },
    );
    const upstreamRequests: Array<{
      body: string;
      headers: Headers;
    }> = [];
    const client = new GrokAuthClient(home, {
      fetch: async (input, init) => {
        expect(String(input)).toBe(
          "https://cli-chat-proxy.grok.com/v1/responses?stream=false",
        );
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer worker-owned-token");
        expect(headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
        expect(headers.get("x-userid")).toBe("user-1");
        expect(headers.get("x-grok-user-id")).toBe("user-1");
        expect(headers.get("x-grok-client-identifier")).toBe("cantrip");
        const body = await new Response(init?.body).text();
        upstreamRequests.push({ body, headers });
        return json({ id: "response-1" });
      },
    });
    try {
      const baseUrl = await client.localProxyBaseUrl();
      expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]+\/v1$/u);
      const response = await fetch(`${baseUrl}/responses?stream=false`, {
        method: "POST",
        headers: {
          authorization: "Bearer browser-supplied-token",
          "content-type": "application/json",
          "x-userid": "browser-supplied-user",
        },
        body: JSON.stringify({
          model: "grok-4",
          prompt_cache_key: "cache-1",
          client_metadata: {
            session_id: "session-1",
            thread_id: "thread-1",
            turn_id: "turn-1",
          },
        }),
      });
      await expect(response.json()).resolves.toEqual({ id: "response-1" });
      const first = upstreamRequests[0];
      expect(first?.body).toBe(
        '{"model":"grok-4","prompt_cache_key":"cache-1","client_metadata":{"session_id":"session-1","thread_id":"thread-1","turn_id":"turn-1"}}',
      );
      expect(first?.headers.get("x-grok-conv-id")).toBe("cache-1");
      expect(first?.headers.get("x-grok-req-id")).toBe("turn-1");
      expect(first?.headers.get("x-grok-session-id")).toBe("cache-1");
      expect(first?.headers.get("x-grok-turn-idx")).toBe("1");
      expect(first?.headers.get("x-grok-model-override")).toBe("grok-4");
      expect(first?.headers.get("x-grok-agent-id")).toMatch(/^[0-9a-f-]{36}$/u);

      const continuation = await fetch(`${baseUrl}/responses?stream=false`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "grok-4",
          input: [{ encrypted_content: "opaque-compaction-state" }],
          prompt_cache_key: "cache-1",
          client_metadata: {
            session_id: "session-1",
            thread_id: "thread-1",
            turn_id: "turn-1",
          },
        }),
      });
      await expect(continuation.json()).resolves.toEqual({ id: "response-1" });
      const second = upstreamRequests[1];
      expect(second?.headers.get("x-grok-conv-id")).toBe("cache-1");
      expect(second?.headers.get("x-grok-req-id")).toBe("turn-1");
      expect(second?.headers.get("x-grok-session-id")).toBe("cache-1");
      expect(second?.headers.get("x-grok-turn-idx")).toBe("1");
      expect(second?.headers.get("x-grok-agent-id")).toBe(
        first?.headers.get("x-grok-agent-id"),
      );
      expect(second?.body).toContain('"opaque-compaction-state"');

      const nextTurn = await fetch(`${baseUrl}/responses?stream=false`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "grok-4",
          prompt_cache_key: "cache-1",
          client_metadata: {
            session_id: "session-1",
            thread_id: "thread-1",
            turn_id: "turn-2",
          },
        }),
      });
      await expect(nextTurn.json()).resolves.toEqual({ id: "response-1" });
      expect(upstreamRequests[2]?.headers.get("x-grok-turn-idx")).toBe("2");
    } finally {
      client.close();
    }
  });

  it("recovers rejected opaque reasoning before resetting Grok session affinity", async () => {
    const upstreamRequests: Array<{ body: string; headers: Headers }> = [];
    const client = new GrokSubscriptionClient(
      async () => ({
        accessToken: "worker-owned-token",
        email: "grok@example.com",
        userId: "user-1",
      }),
      {
        fetch: async (_input, init) => {
          const body = await new Response(init?.body).text();
          upstreamRequests.push({ body, headers: new Headers(init?.headers) });
          if (upstreamRequests.length < 3) {
            return json(
              {
                code: "invalid-argument",
                error:
                  "Could not decode the compaction blob. Ensure it is unmodified from the compact response.",
              },
              400,
            );
          }
          return json({ id: "response-recovered" });
        },
      },
    );
    try {
      const baseUrl = await client.localProxyBaseUrl();
      const response = await fetch(`${baseUrl}/responses?stream=false`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "grok-4.6",
          input: [
            {
              type: "reasoning",
              id: "reasoning-readable",
              status: "completed",
              summary: [{ type: "summary_text", text: "Inspect the docs." }],
              encrypted_content: "opaque-readable-state",
            },
            {
              type: "reasoning",
              id: "reasoning-opaque-only",
              status: "completed",
              summary: [],
              encrypted_content: "opaque-only-state",
            },
            {
              type: "function_call_output",
              call_id: "call-1",
              output: "README.md",
            },
          ],
          prompt_cache_key: "cache-1",
          client_metadata: {
            session_id: "session-1",
            thread_id: "thread-1",
            turn_id: "turn-1",
          },
        }),
      });
      await expect(response.json()).resolves.toEqual({
        id: "response-recovered",
      });
      expect(upstreamRequests).toHaveLength(3);

      const initial = JSON.parse(upstreamRequests[0]?.body ?? "{}") as {
        input: Array<Record<string, unknown>>;
      };
      expect(initial.input[0]?.encrypted_content).toBe("opaque-readable-state");

      const portable = JSON.parse(upstreamRequests[1]?.body ?? "{}") as {
        input: Array<Record<string, unknown>>;
        prompt_cache_key?: string;
      };
      expect(portable.prompt_cache_key).toBe("cache-1");
      expect(portable.input).toContainEqual({
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Inspect the docs." }],
      });
      expect(portable.input).not.toContainEqual(
        expect.objectContaining({ id: "reasoning-opaque-only" }),
      );
      expect(upstreamRequests[1]?.headers.get("x-grok-session-id")).toBe(
        "cache-1",
      );

      const stateless = JSON.parse(upstreamRequests[2]?.body ?? "{}") as {
        prompt_cache_key?: string;
      };
      expect(stateless.prompt_cache_key).toBeUndefined();
      expect(upstreamRequests[2]?.headers.get("x-grok-session-id")).toBeNull();
      expect(upstreamRequests[2]?.headers.get("x-grok-conv-id")).toBeNull();
      expect(upstreamRequests[2]?.headers.get("x-grok-turn-idx")).toBeNull();
      expect(upstreamRequests[2]?.headers.get("x-grok-req-id")).not.toBe(
        "turn-1",
      );

      const statelessRequestId =
        upstreamRequests[2]?.headers.get("x-grok-req-id");
      const continuation = await fetch(`${baseUrl}/responses?stream=false`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "grok-4.6",
          input: [
            {
              type: "reasoning",
              summary: [],
              encrypted_content: "replacement-opaque-state",
            },
            {
              type: "function_call_output",
              call_id: "call-2",
              output: "package.json",
            },
          ],
          prompt_cache_key: "cache-1",
          client_metadata: {
            session_id: "session-1",
            thread_id: "thread-1",
            turn_id: "turn-1",
          },
        }),
      });
      await expect(continuation.json()).resolves.toEqual({
        id: "response-recovered",
      });
      expect(upstreamRequests).toHaveLength(4);
      expect(upstreamRequests[3]?.body).not.toContain("encrypted_content");
      expect(upstreamRequests[3]?.body).not.toContain("prompt_cache_key");
      expect(upstreamRequests[3]?.headers.get("x-grok-session-id")).toBeNull();
      expect(upstreamRequests[3]?.headers.get("x-grok-req-id")).toBe(
        statelessRequestId,
      );

      const nextTurn = await fetch(`${baseUrl}/responses?stream=false`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "grok-4.6",
          input: [{ role: "user", content: "Continue." }],
          prompt_cache_key: "cache-1",
          client_metadata: {
            session_id: "session-1",
            thread_id: "thread-1",
            turn_id: "turn-2",
          },
        }),
      });
      await expect(nextTurn.json()).resolves.toEqual({
        id: "response-recovered",
      });
      expect(upstreamRequests).toHaveLength(5);
      expect(upstreamRequests[4]?.body).not.toContain("prompt_cache_key");
      expect(upstreamRequests[4]?.headers.get("x-grok-session-id")).toBeNull();
      expect(upstreamRequests[4]?.headers.get("x-grok-req-id")).not.toBe(
        statelessRequestId,
      );
    } finally {
      client.close();
    }
  });

  it("does not retry unrelated Grok validation failures", async () => {
    let requestCount = 0;
    const client = new GrokSubscriptionClient(
      async () => ({
        accessToken: "worker-owned-token",
        email: null,
        userId: "user-1",
      }),
      {
        fetch: async () => {
          requestCount += 1;
          return json(
            { code: "invalid-argument", error: "Unsupported tool schema." },
            400,
          );
        },
      },
    );
    try {
      const baseUrl = await client.localProxyBaseUrl();
      const response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "grok-4.6",
          input: [
            {
              type: "reasoning",
              summary: [],
              encrypted_content: "opaque-state",
            },
          ],
          prompt_cache_key: "cache-1",
        }),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: "Unsupported tool schema.",
      });
      expect(requestCount).toBe(1);
    } finally {
      client.close();
    }
  });
});
