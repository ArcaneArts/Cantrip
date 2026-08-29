import type {
  CodexRuntimeReport,
  ProviderAccessTokenLease,
} from "@cantrip/protocol";

import type { ProviderAccessTokenClient } from "../provider-access-tokens.js";
import type { RuntimeProvider } from "../protected-secrets.js";

export type { RuntimeProvider } from "../protected-secrets.js";

export interface ExternalChatGptAuthSession {
  credentialRevision: number;
  providerAccountId: string;
  providerId: string;
  upstreamAccountId: string;
}

export function chatGptExternalAuthCapabilityError(
  report: CodexRuntimeReport,
): string | null {
  if (!report.version || !/^0\.151\.\d+$/u.test(report.version.semantic)) {
    return "Portable ChatGPT accounts require Codex 0.151.x.";
  }
  if (!report.initialize?.experimentalApi) {
    return "Portable ChatGPT accounts require Codex experimental API support.";
  }
  if (report.methods["account/login/start"] !== "available") {
    return "Codex does not advertise account/login/start for portable ChatGPT authentication.";
  }
  return null;
}

export function chatGptExternalAuthSession(
  provider: RuntimeProvider,
  lease: ProviderAccessTokenLease,
): ExternalChatGptAuthSession {
  if (
    provider.kind !== "chatgpt" ||
    !provider.accountId ||
    lease.providerKind !== "chatgpt" ||
    lease.providerIdentity.kind !== "chatgpt" ||
    lease.providerId !== provider.id ||
    lease.providerAccountId !== provider.accountId
  ) {
    throw new Error("Server returned a mismatched ChatGPT access lease.");
  }
  return {
    credentialRevision: lease.credentialRevision,
    providerAccountId: provider.accountId,
    providerId: provider.id,
    upstreamAccountId: lease.providerIdentity.accountId,
  };
}

export function chatGptExternalLoginParams(
  provider: RuntimeProvider,
  lease: ProviderAccessTokenLease,
): Record<string, unknown> {
  const session = chatGptExternalAuthSession(provider, lease);
  return {
    type: "chatgptAuthTokens",
    accessToken: lease.accessToken,
    chatgptAccountId: session.upstreamAccountId,
    chatgptPlanType: lease.planType,
  };
}

export function chatGptExternalRefreshResponse(
  session: ExternalChatGptAuthSession,
  lease: ProviderAccessTokenLease,
  previousAccountId: string | null,
): Record<string, unknown> {
  if (
    lease.providerKind !== "chatgpt" ||
    lease.providerIdentity.kind !== "chatgpt" ||
    lease.providerId !== session.providerId ||
    lease.providerAccountId !== session.providerAccountId ||
    lease.providerIdentity.accountId !== session.upstreamAccountId ||
    lease.credentialRevision <= session.credentialRevision ||
    (previousAccountId !== null &&
      previousAccountId !== session.upstreamAccountId)
  ) {
    throw new Error("Refreshed ChatGPT access lease changed account identity.");
  }
  return {
    accessToken: lease.accessToken,
    chatgptAccountId: session.upstreamAccountId,
    chatgptPlanType: lease.planType,
  };
}

export async function refreshExternalChatGptAuthSession(
  session: ExternalChatGptAuthSession,
  providerAccessTokens: Pick<ProviderAccessTokenClient, "get">,
  params: unknown,
): Promise<{
  accessToken: string;
  response: Record<string, unknown>;
}> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Codex sent an invalid ChatGPT refresh request.");
  }
  const value = params as Record<string, unknown>;
  if (
    value.reason !== "unauthorized" ||
    !(
      value.previousAccountId === undefined ||
      value.previousAccountId === null ||
      typeof value.previousAccountId === "string"
    )
  ) {
    throw new Error("Codex sent an invalid ChatGPT refresh request.");
  }
  let lease: ProviderAccessTokenLease;
  try {
    lease = await providerAccessTokens.get(
      session.providerId,
      session.providerAccountId,
      {
        credentialRevision: session.credentialRevision,
        forceRefresh: true,
        minimumValiditySeconds: 120,
      },
    );
  } catch {
    throw new Error("Cantrip could not refresh the ChatGPT access lease.");
  }
  const response = chatGptExternalRefreshResponse(
    session,
    lease,
    typeof value.previousAccountId === "string"
      ? value.previousAccountId
      : null,
  );
  session.credentialRevision = lease.credentialRevision;
  return { accessToken: lease.accessToken, response };
}
