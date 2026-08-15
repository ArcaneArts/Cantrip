import type { ProviderCredential } from "./provider-credentials.js";

const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CHATGPT_REVOKE_ENDPOINT = "https://auth.openai.com/oauth/revoke";
const GROK_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const GROK_REVOKE_ENDPOINT = "https://auth.x.ai/oauth2/revoke";
const DEFAULT_TIMEOUT_MS = 10_000;

export type ProviderCredentialRevocationStatus = "revoked" | "failed";

export interface ProviderCredentialRevoker {
  revoke(
    credential: ProviderCredential,
  ): Promise<ProviderCredentialRevocationStatus>;
}

export interface OAuthProviderCredentialRevokerOptions {
  chatGptClientId?: string;
  chatGptEndpoint?: string;
  fetch?: typeof fetch;
  grokClientId?: string;
  grokEndpoint?: string;
  timeoutMs?: number;
}

/** Best-effort upstream revocation that never exposes provider response data. */
export class OAuthProviderCredentialRevoker implements ProviderCredentialRevoker {
  readonly #chatGptClientId: string;
  readonly #chatGptEndpoint: string;
  readonly #fetch: typeof fetch;
  readonly #grokClientId: string;
  readonly #grokEndpoint: string;
  readonly #timeoutMs: number;

  constructor(options: OAuthProviderCredentialRevokerOptions = {}) {
    this.#chatGptClientId = options.chatGptClientId ?? CHATGPT_CLIENT_ID;
    this.#chatGptEndpoint = options.chatGptEndpoint ?? CHATGPT_REVOKE_ENDPOINT;
    this.#fetch = options.fetch ?? fetch;
    this.#grokClientId = options.grokClientId ?? GROK_CLIENT_ID;
    this.#grokEndpoint = options.grokEndpoint ?? GROK_REVOKE_ENDPOINT;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async revoke(
    credential: ProviderCredential,
  ): Promise<ProviderCredentialRevocationStatus> {
    const token = credential.refreshToken ?? credential.accessToken;
    const tokenType = credential.refreshToken
      ? "refresh_token"
      : "access_token";
    try {
      const response =
        credential.kind === "chatgpt"
          ? await this.#fetch(this.#chatGptEndpoint, {
              body: JSON.stringify({
                token,
                token_type_hint: tokenType,
                ...(credential.refreshToken
                  ? { client_id: this.#chatGptClientId }
                  : {}),
              }),
              headers: { "content-type": "application/json" },
              method: "POST",
              signal: AbortSignal.timeout(this.#timeoutMs),
            })
          : await this.#fetch(this.#grokEndpoint, {
              body: new URLSearchParams({
                client_id: this.#grokClientId,
                token,
                token_type_hint: tokenType,
              }),
              headers: {
                "content-type": "application/x-www-form-urlencoded",
              },
              method: "POST",
              signal: AbortSignal.timeout(this.#timeoutMs),
            });
      return response.ok ? "revoked" : "failed";
    } catch {
      return "failed";
    }
  }
}
