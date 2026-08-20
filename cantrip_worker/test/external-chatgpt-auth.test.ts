import { describe, expect, it } from "vitest";

import { unprobedCodexRuntimeReport } from "@cantrip/protocol";

import {
  chatGptExternalAuthCapabilityError,
  chatGptExternalLoginParams,
  chatGptExternalRefreshResponse,
  refreshExternalChatGptAuthSession,
} from "../src/codex/external-chatgpt-auth.js";

const externalAuthReport = {
  ...unprobedCodexRuntimeReport,
  compatibility: "compatible" as const,
  version: { raw: "codex-cli 0.148.0", semantic: "0.148.0" },
  initialize: {
    experimentalApi: true,
    platformFamily: "unix",
    platformOs: "macos",
    userAgent: "codex_cli_rs/0.148.0",
  },
  methods: { "account/login/start": "available" as const },
  degradedReasons: [],
};
const provider = {
  accountId: "account-one",
  apiKey: null,
  baseUrl: "https://chatgpt.com/backend-api/codex",
  credentialHomeKey: "home-one",
  id: "provider-one",
  kind: "chatgpt" as const,
  name: "ChatGPT",
};
const lease = {
  accessToken: "leased-access-token",
  credentialRevision: 3,
  expiresAt: "2026-08-15T13:00:00.000Z",
  issuedAt: "2026-08-15T12:00:00.000Z",
  leaseExpiresAt: "2026-08-15T12:05:00.000Z",
  planType: "pro",
  providerAccountId: "account-one",
  providerId: "provider-one",
  providerIdentity: {
    accountId: "upstream-workspace",
    kind: "chatgpt" as const,
    userId: "upstream-user",
  },
  providerKind: "chatgpt" as const,
};

describe("Codex external ChatGPT authentication", () => {
  it("capability-gates and shapes external login tokens", () => {
    expect(chatGptExternalAuthCapabilityError(externalAuthReport)).toBeNull();
    expect(
      chatGptExternalAuthCapabilityError({
        ...externalAuthReport,
        initialize: {
          ...externalAuthReport.initialize,
          experimentalApi: false,
        },
      }),
    ).toContain("experimental API");
    expect(chatGptExternalLoginParams(provider, lease)).toEqual({
      type: "chatgptAuthTokens",
      accessToken: "leased-access-token",
      chatgptAccountId: "upstream-workspace",
      chatgptPlanType: "pro",
    });
  });

  it("rejects an identity change in refreshed leases", () => {
    const session = {
      credentialRevision: 2,
      providerAccountId: "account-one",
      providerId: "provider-one",
      upstreamAccountId: "upstream-workspace",
    };
    expect(
      chatGptExternalRefreshResponse(
        session,
        { ...lease, accessToken: "refreshed-access-token" },
        "upstream-workspace",
      ),
    ).toEqual({
      accessToken: "refreshed-access-token",
      chatgptAccountId: "upstream-workspace",
      chatgptPlanType: "pro",
    });
    expect(() =>
      chatGptExternalRefreshResponse(
        session,
        {
          ...lease,
          providerIdentity: {
            ...lease.providerIdentity,
            accountId: "other-workspace",
          },
        },
        "upstream-workspace",
      ),
    ).toThrow("changed account identity");
  });

  it("refreshes the exact credential revision used by a Codex runtime", async () => {
    const session = {
      credentialRevision: 2,
      providerAccountId: "account-one",
      providerId: "provider-one",
      upstreamAccountId: "upstream-workspace",
    };
    const requests: unknown[] = [];
    const refreshed = await refreshExternalChatGptAuthSession(
      session,
      {
        async get(providerId, accountId, options) {
          requests.push({ accountId, options, providerId });
          return { ...lease, accessToken: "refreshed-access-token" };
        },
      },
      { reason: "unauthorized", previousAccountId: "upstream-workspace" },
    );
    expect(requests).toEqual([
      {
        accountId: "account-one",
        options: {
          credentialRevision: 2,
          forceRefresh: true,
          minimumValiditySeconds: 120,
        },
        providerId: "provider-one",
      },
    ]);
    expect(refreshed).toEqual({
      accessToken: "refreshed-access-token",
      response: {
        accessToken: "refreshed-access-token",
        chatgptAccountId: "upstream-workspace",
        chatgptPlanType: "pro",
      },
    });
    expect(session.credentialRevision).toBe(3);
  });
});
