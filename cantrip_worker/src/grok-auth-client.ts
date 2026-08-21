import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  codexAuthStatusSchema,
  codexDeviceLoginSchema,
  type CodexAuthStatus,
  type CodexDeviceLogin,
  type GrokModelInventory,
  type ProviderWeeklyUsage,
} from "@cantrip/protocol";

import {
  GROK_CLIENT_VERSION,
  GrokSubscriptionClient,
} from "./grok-subscription-client.js";

export {
  GROK_CLIENT_VERSION,
  GROK_SUBSCRIPTION_PROXY,
  normalizeGrokModel,
} from "./grok-subscription-client.js";

export const GROK_OAUTH_ISSUER = "https://auth.x.ai";
export const GROK_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";

const GROK_OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "grok-cli:access",
  "api:access",
  "conversations:read",
  "conversations:write",
  "workspaces:read",
  "workspaces:write",
];
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const EARLY_REFRESH_MS = 5 * 60_000;
const PROFILE_CACHE_MS = 30_000;

interface StoredGrokCredential {
  accessToken: string;
  email: string | null;
  expiresAt: number | null;
  planType: string | null;
  refreshToken: string | null;
  userId: string;
  version: 1;
}

export interface GrokAuthClientOptions {
  clientId?: string;
  clientVersion?: string;
  fetch?: typeof fetch;
  issuer?: string;
  now?: () => number;
  onStatusChanged?: () => void;
  proxyBaseUrl?: string;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface DeviceCodeResponse {
  device_code: string;
  expires_in: number;
  interval?: number;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
}

interface TokenResponse {
  access_token: string;
  expires_in?: number;
  id_token?: string;
  refresh_token?: string;
}

interface PendingLogin {
  abort: AbortController;
  id: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jwtClaims(token: string | undefined): Record<string, unknown> {
  if (!token) return {};
  const payload = token.split(".")[1];
  if (!payload) return {};
  try {
    return JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function stringField(
  value: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function defaultSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export class GrokAuthClient {
  readonly #authPath: string;
  readonly #clientId: string;
  readonly #clientVersion: string;
  readonly #fetch: typeof fetch;
  readonly #issuer: string;
  readonly #now: () => number;
  readonly #onStatusChanged: () => void;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly #subscription: GrokSubscriptionClient;
  #credential: StoredGrokCredential | null | undefined;
  #loginError: string | null = null;
  #pendingLogin: PendingLogin | null = null;
  #profileFetchedAt = 0;
  #refreshing: Promise<StoredGrokCredential> | null = null;

  constructor(
    private readonly credentialHome: string,
    options: GrokAuthClientOptions = {},
  ) {
    this.#authPath = path.join(credentialHome, "grok-auth.json");
    this.#clientId = options.clientId ?? GROK_OAUTH_CLIENT_ID;
    this.#clientVersion =
      options.clientVersion ??
      (process.env.CANTRIP_GROK_CLIENT_VERSION?.trim() || GROK_CLIENT_VERSION);
    this.#fetch = options.fetch ?? fetch;
    this.#issuer = (options.issuer ?? GROK_OAUTH_ISSUER).replace(/\/+$/u, "");
    this.#now = options.now ?? Date.now;
    this.#onStatusChanged = options.onStatusChanged ?? (() => undefined);
    this.#sleep = options.sleep ?? defaultSleep;
    this.#subscription = new GrokSubscriptionClient(
      async (request) => {
        const credential = await this.#validCredential(
          request?.forceRefresh ?? false,
        );
        return {
          accessToken: credential.accessToken,
          email: credential.email,
          userId: credential.userId,
        };
      },
      {
        clientVersion: this.#clientVersion,
        fetch: this.#fetch,
        now: this.#now,
        proxyBaseUrl: options.proxyBaseUrl,
      },
    );
  }

  async status(): Promise<CodexAuthStatus> {
    let credential = await this.#loadCredential();
    if (credential) {
      try {
        credential = await this.#validCredential();
        if (this.#now() - this.#profileFetchedAt >= PROFILE_CACHE_MS) {
          credential = await this.#enrichProfile(credential);
        }
      } catch (error) {
        this.#loginError = errorMessage(error);
        if (
          credential.expiresAt !== null &&
          credential.expiresAt <= this.#now()
        ) {
          credential = null;
        }
      }
    }
    const weeklyUsage = credential
      ? await this.#subscription.weeklyUsage()
      : null;
    return codexAuthStatusSchema.parse({
      authenticated: Boolean(credential),
      authMode: credential ? "grok" : null,
      email: credential?.email ?? null,
      planType: credential?.planType ?? null,
      weeklyUsage,
      loginPending: Boolean(this.#pendingLogin),
      loginError: this.#loginError,
    });
  }

  async startDeviceLogin(): Promise<CodexDeviceLogin> {
    this.#pendingLogin?.abort.abort(
      new Error("A newer Grok sign-in was started."),
    );
    this.#loginError = null;
    const response = await this.#requestDeviceCode();
    const abort = new AbortController();
    const pending = { abort, id: randomUUID() };
    this.#pendingLogin = pending;
    this.#onStatusChanged();
    void this.#pollDeviceCode(response, abort.signal)
      .catch((error) => {
        if (!abort.signal.aborted) {
          this.#loginError = errorMessage(error);
          this.#onStatusChanged();
        }
      })
      .finally(() => {
        if (this.#pendingLogin === pending) {
          this.#pendingLogin = null;
          this.#onStatusChanged();
        }
      });
    return codexDeviceLoginSchema.parse({
      loginId: pending.id,
      verificationUrl:
        response.verification_uri_complete ?? response.verification_uri,
      userCode: response.user_code,
    });
  }

  async logout(): Promise<void> {
    this.#pendingLogin?.abort.abort(new Error("Grok sign-in was cancelled."));
    this.#pendingLogin = null;
    this.#loginError = null;
    this.#credential = null;
    this.#profileFetchedAt = 0;
    this.#subscription.close();
    await unlink(this.#authPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    this.#onStatusChanged();
  }

  async listModels(): Promise<GrokModelInventory> {
    return this.#subscription.listModels();
  }

  async weeklyUsage(): Promise<ProviderWeeklyUsage | null> {
    return this.#subscription.weeklyUsage();
  }

  async localProxyBaseUrl(): Promise<string> {
    return this.#subscription.localProxyBaseUrl();
  }

  close(): void {
    this.#pendingLogin?.abort.abort(new Error("Grok authentication stopped."));
    this.#pendingLogin = null;
    this.#subscription.close();
  }

  async #requestDeviceCode(): Promise<DeviceCodeResponse> {
    const response = await this.#fetch(`${this.#issuer}/oauth2/device/code`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-grok-client-surface": "ui",
        "x-grok-client-version": this.#clientVersion,
      },
      body: new URLSearchParams({
        client_id: this.#clientId,
        scope: GROK_OAUTH_SCOPES.join(" "),
        referrer: "grok-build",
      }),
    });
    if (!response.ok) {
      throw new Error(
        `Grok device sign-in could not start (${response.status}): ${await response.text()}`,
      );
    }
    const result = (await response.json()) as DeviceCodeResponse;
    if (
      !result.device_code ||
      !result.user_code ||
      !result.verification_uri ||
      !Number.isFinite(result.expires_in)
    ) {
      throw new Error("Grok returned an invalid device-code response.");
    }
    if (!/^[A-Za-z0-9-]+$/u.test(result.user_code)) {
      throw new Error("Grok returned an invalid device sign-in code.");
    }
    for (const uri of [
      result.verification_uri,
      result.verification_uri_complete,
    ]) {
      if (!uri) continue;
      const parsed = new URL(uri);
      const loopback = ["127.0.0.1", "localhost"].includes(parsed.hostname);
      if (
        parsed.protocol !== "https:" &&
        !(parsed.protocol === "http:" && loopback)
      ) {
        throw new Error("Grok returned an unsupported verification URL.");
      }
    }
    return result;
  }

  async #pollDeviceCode(
    device: DeviceCodeResponse,
    signal: AbortSignal,
  ): Promise<void> {
    let intervalMs = Math.max(1, device.interval ?? 5) * 1_000;
    const deadline = this.#now() + Math.max(1, device.expires_in) * 1_000;
    while (!signal.aborted) {
      await this.#sleep(intervalMs, signal);
      if (this.#now() > deadline)
        throw new Error("The Grok sign-in code expired.");
      const response = await this.#fetch(`${this.#issuer}/oauth2/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-grok-client-surface": "ui",
          "x-grok-client-version": this.#clientVersion,
        },
        body: new URLSearchParams({
          grant_type: DEVICE_GRANT_TYPE,
          device_code: device.device_code,
          client_id: this.#clientId,
        }),
        signal,
      });
      const payload = (await response.json()) as TokenResponse & {
        error?: string;
        error_description?: string;
      };
      if (response.ok && payload.access_token) {
        let credential = this.#credentialFromTokens(payload, null);
        await this.#saveCredential(credential);
        credential = await this.#enrichProfile(credential);
        this.#credential = credential;
        this.#loginError = null;
        this.#onStatusChanged();
        return;
      }
      if (payload.error === "authorization_pending") continue;
      if (payload.error === "slow_down") {
        intervalMs += 5_000;
        continue;
      }
      if (payload.error === "access_denied") {
        throw new Error("Grok sign-in was denied.");
      }
      if (payload.error === "expired_token") {
        throw new Error("The Grok sign-in code expired.");
      }
      throw new Error(
        payload.error_description ?? payload.error ?? "Grok sign-in failed.",
      );
    }
  }

  #credentialFromTokens(
    tokens: TokenResponse,
    previous: StoredGrokCredential | null,
  ): StoredGrokCredential {
    const claims = jwtClaims(tokens.id_token);
    return {
      version: 1,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? previous?.refreshToken ?? null,
      expiresAt:
        typeof tokens.expires_in === "number"
          ? this.#now() + tokens.expires_in * 1_000
          : (previous?.expiresAt ?? null),
      userId:
        (typeof claims.sub === "string" ? claims.sub : null) ??
        previous?.userId ??
        "",
      email:
        (typeof claims.email === "string" ? claims.email : null) ??
        previous?.email ??
        null,
      planType: previous?.planType ?? null,
    };
  }

  async #loadCredential(): Promise<StoredGrokCredential | null> {
    if (this.#credential !== undefined) return this.#credential;
    try {
      const value = JSON.parse(
        await readFile(this.#authPath, "utf8"),
      ) as Partial<StoredGrokCredential>;
      if (
        value.version !== 1 ||
        typeof value.accessToken !== "string" ||
        typeof value.userId !== "string"
      ) {
        throw new Error("Stored Grok credentials are invalid.");
      }
      this.#credential = {
        version: 1,
        accessToken: value.accessToken,
        refreshToken:
          typeof value.refreshToken === "string" ? value.refreshToken : null,
        expiresAt: typeof value.expiresAt === "number" ? value.expiresAt : null,
        userId: value.userId,
        email: typeof value.email === "string" ? value.email : null,
        planType: typeof value.planType === "string" ? value.planType : null,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.#loginError = errorMessage(error);
      }
      this.#credential = null;
    }
    return this.#credential;
  }

  async #saveCredential(credential: StoredGrokCredential): Promise<void> {
    await mkdir(this.credentialHome, { recursive: true, mode: 0o700 });
    await chmod(this.credentialHome, 0o700);
    const temporary = `${this.#authPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(credential, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.#authPath);
      await chmod(this.#authPath, 0o600);
      this.#credential = credential;
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async #validCredential(force = false): Promise<StoredGrokCredential> {
    const credential = await this.#loadCredential();
    if (!credential) throw new Error("Grok account is not signed in.");
    if (
      !force &&
      (credential.expiresAt === null ||
        credential.expiresAt > this.#now() + EARLY_REFRESH_MS)
    ) {
      return credential;
    }
    if (!credential.refreshToken) {
      if (
        !force &&
        (credential.expiresAt === null || credential.expiresAt > this.#now())
      ) {
        return credential;
      }
      throw new Error("Grok credentials cannot be refreshed. Sign in again.");
    }
    this.#refreshing ??= this.#refreshCredential(credential);
    try {
      return await this.#refreshing;
    } catch (error) {
      if (
        !force &&
        credential.expiresAt !== null &&
        credential.expiresAt > this.#now()
      ) {
        return credential;
      }
      throw error;
    } finally {
      this.#refreshing = null;
    }
  }

  async #refreshCredential(
    credential: StoredGrokCredential,
  ): Promise<StoredGrokCredential> {
    const response = await this.#fetch(`${this.#issuer}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken!,
        client_id: this.#clientId,
      }),
    });
    const payload = (await response.json()) as TokenResponse & {
      error?: string;
      error_description?: string;
    };
    if (!response.ok || !payload.access_token) {
      if (["invalid_grant", "invalid_token"].includes(payload.error ?? "")) {
        this.#credential = null;
        await unlink(this.#authPath).catch(() => undefined);
      }
      throw new Error(
        payload.error_description ??
          payload.error ??
          "Grok token refresh failed.",
      );
    }
    const refreshed = this.#credentialFromTokens(payload, credential);
    await this.#saveCredential(refreshed);
    return refreshed;
  }

  async #enrichProfile(
    credential: StoredGrokCredential,
  ): Promise<StoredGrokCredential> {
    this.#profileFetchedAt = this.#now();
    try {
      const response = await this.#subscription.request(
        "/user?include=subscription",
        {},
        false,
      );
      if (!response.ok) return credential;
      const profile = (await response.json()) as Record<string, unknown>;
      const enriched = {
        ...credential,
        userId: stringField(profile, "userId", "user_id") ?? credential.userId,
        email: stringField(profile, "email") ?? credential.email,
        planType:
          stringField(profile, "subscriptionTier", "subscription_tier") ??
          credential.planType,
      };
      if (JSON.stringify(enriched) !== JSON.stringify(credential)) {
        await this.#saveCredential(enriched);
      }
      return enriched;
    } catch {
      return credential;
    }
  }
}
