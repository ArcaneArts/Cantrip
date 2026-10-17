import type { ProviderAccessTokenLease } from "@cantrip/protocol";
import type {
  ExternalChatGptAuthSession,
  RuntimeProvider,
} from "./external-chatgpt-auth.js";
import { workerLogger } from "../logger.js";
import type { ProviderAccessTokenClient } from "../provider-access-tokens.js";
import {
  ProviderAccountReauthenticationRequiredError,
  isChatGptTokenExpiredError,
} from "./provider-errors.js";
import {
  chatGptExternalRefreshResponse,
  refreshExternalChatGptAuthSession,
} from "./external-chatgpt-auth.js";
import { ProviderAccessTokenRequestError } from "../provider-access-tokens.js";
import { codexProviderLogContext } from "./provider-config.js";

interface AuthRecoveryPorts {
  providerAccessTokens(): Pick<ProviderAccessTokenClient, "get"> | undefined;
  request(method: string, params: unknown): Promise<unknown>;
  rememberSecret(secret: string): void;
}

/** Owns the portable account session and one in-flight refresh/login attempt. */
export class CodexAuthRecovery {
  #externalChatGptAuth: ExternalChatGptAuthSession | null = null;
  #externalChatGptReauthentication: Promise<void> | null = null;
  constructor(private readonly ports: AuthRecoveryPorts) {}

  private get providerAccessTokens():
    Pick<ProviderAccessTokenClient, "get"> | undefined {
    return this.ports.providerAccessTokens();
  }

  setSession(session: ExternalChatGptAuthSession | null): void {
    this.#externalChatGptAuth = session;
  }

  async refreshExternalChatGptAuth(
    params: unknown,
  ): Promise<Record<string, unknown>> {
    const session = this.#externalChatGptAuth;
    if (!session || !this.providerAccessTokens) {
      throw new Error("Portable ChatGPT authentication is not active.");
    }

    const refreshed = await refreshExternalChatGptAuthSession(
      session,
      this.providerAccessTokens,
      params,
    );
    this.ports.rememberSecret(refreshed.accessToken);
    return refreshed.response;
  }

  async requestWithChatGptAuthRecovery(
    provider: RuntimeProvider & { kind: "chatgpt" },
    method: string,
    params: unknown,
  ): Promise<unknown> {
    try {
      return await this.ports.request(method, params);
    } catch (error) {
      if (!isChatGptTokenExpiredError(error)) throw error;
    }

    await this.reauthenticateExternalChatGptRuntime(provider);
    try {
      return await this.ports.request(method, params);
    } catch (error) {
      if (isChatGptTokenExpiredError(error)) {
        throw new ProviderAccountReauthenticationRequiredError();
      }

      throw error;
    }
  }

  private async reauthenticateExternalChatGptRuntime(
    provider: RuntimeProvider & { kind: "chatgpt" },
  ): Promise<void> {
    if (this.#externalChatGptReauthentication) {
      return this.#externalChatGptReauthentication;
    }

    const pending = this.performExternalChatGptReauthentication(provider);
    this.#externalChatGptReauthentication = pending;
    try {
      await pending;
    } finally {
      if (this.#externalChatGptReauthentication === pending) {
        this.#externalChatGptReauthentication = null;
      }
    }
  }

  private async performExternalChatGptReauthentication(
    provider: RuntimeProvider & { kind: "chatgpt" },
  ): Promise<void> {
    const session = this.#externalChatGptAuth;
    if (!session || !this.providerAccessTokens) {
      throw new ProviderAccountReauthenticationRequiredError();
    }

    let lease: ProviderAccessTokenLease;
    try {
      lease = await this.providerAccessTokens.get(
        session.providerId,
        session.providerAccountId,
        {
          credentialRevision: session.credentialRevision,
          forceRefresh: true,
          minimumValiditySeconds: 120,
        },
      );
    } catch (error) {
      if (
        error instanceof ProviderAccessTokenRequestError &&
        error.code === "reauth-required"
      ) {
        throw new ProviderAccountReauthenticationRequiredError();
      }

      throw new Error(
        "Cantrip could not refresh ChatGPT authentication. Try again.",
        {
          cause: error,
        },
      );
    }

    const refreshed = chatGptExternalRefreshResponse(
      session,
      lease,
      session.upstreamAccountId,
    );
    this.ports.rememberSecret(lease.accessToken);
    let result: { type?: unknown };
    try {
      result = (await this.ports.request("account/login/start", {
        type: "chatgptAuthTokens",
        ...refreshed,
      })) as { type?: unknown };
    } catch (error) {
      if (isChatGptTokenExpiredError(error)) {
        throw new ProviderAccountReauthenticationRequiredError();
      }

      throw new Error(
        "Codex could not accept refreshed ChatGPT authentication.",
        {
          cause: error,
        },
      );
    }

    if (result.type !== "chatgptAuthTokens") {
      throw new Error("Codex rejected refreshed ChatGPT authentication.");
    }

    session.credentialRevision = lease.credentialRevision;
    workerLogger.event(
      "info",
      "ChatGPT authentication refreshed after an expired token",
      {
        event: "provider.auth.refresh",
        subsystem: "provider-auth",
        operation: "refresh-expired-token",
        status: "completed",
        ...codexProviderLogContext(provider),
      },
    );
  }
}
