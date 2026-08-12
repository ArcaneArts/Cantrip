import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { Algorithm, hash, verify } from "@node-rs/argon2";
import type { AuthSession, UserSummary } from "@cantrip/protocol";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { ServerConfig } from "../config.js";
import type { ActiveUserSession, ServerRepository } from "../db/repository.js";
import { sessionPrincipal } from "./principal.js";

const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 65_536,
  outputLen: 32,
  parallelism: 1,
  timeCost: 3,
} as const;

export const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=3,p=1$MUv0/kDJ7VPEN7VQEB4rIQ$wJHg7XVUvZMUi+cUfw0yIUxEbKhWNf/+LiCGElJeOYM";

export function normalizeAccountEmail(email: string): string {
  return email.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  try {
    return await verify(passwordHash, password, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function createMobileSignInCode(): {
  code: string;
  codeHash: string;
} {
  const code = `ctms_${randomBytes(24).toString("base64url")}`;
  return { code, codeHash: hashSecret(code) };
}

export function safeSecretMatch(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(hashSecret(candidate), "hex");
  const expectedBuffer = Buffer.from(hashSecret(expected), "hex");
  return timingSafeEqual(candidateBuffer, expectedBuffer);
}

function cookieValue(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function requestMetadataHash(value: string | undefined): string | null {
  return value ? hashSecret(value) : null;
}

export class UserSessionService {
  readonly cookieName: string;
  readonly partitionedCookieName: string | null;
  private readonly cookieSecure: boolean;
  private readonly cookieSameSite: "Lax" | "None" | "Strict";
  private readonly sessionTtlSeconds: number;

  constructor(
    private readonly repository: ServerRepository,
    private readonly config: ServerConfig,
  ) {
    this.cookieSecure =
      config.cookieSecure ?? config.deploymentMode === "hosted";
    this.cookieName = this.cookieSecure
      ? "__Host-cantrip_session"
      : "cantrip_session";
    this.cookieSameSite =
      config.cookieSameSite === "none"
        ? "None"
        : config.cookieSameSite === "strict"
          ? "Strict"
          : "Lax";
    this.partitionedCookieName =
      this.cookieSecure && this.cookieSameSite === "None"
        ? "__Host-cantrip_partitioned_session"
        : null;
    if (this.cookieSameSite === "None" && !this.cookieSecure) {
      throw new Error("SameSite=None authentication cookies must be Secure.");
    }
    this.sessionTtlSeconds = config.sessionTtlSeconds ?? 30 * 24 * 60 * 60;
  }

  async resolve(request: FastifyRequest): Promise<ActiveUserSession | null> {
    for (const name of [this.cookieName, this.partitionedCookieName]) {
      if (!name) continue;
      const token = cookieValue(request, name);
      if (!token || token.length > 512) continue;
      const session = await this.repository.getActiveUserSession(
        hashSecret(token),
      );
      if (session) return session;
    }
    return null;
  }

  async resolvePrincipal(request: FastifyRequest) {
    const session = await this.resolve(request);
    if (!session) return null;
    return sessionPrincipal({
      authMode: this.config.authMode as "password" | "accounts",
      authentication:
        session.authMethod === "password" ? "password" : "session",
      sessionId: session.id,
      user: session.user,
    });
  }

  async create(
    request: FastifyRequest,
    reply: FastifyReply,
    user: UserSummary,
    authMethod: ActiveUserSession["authMethod"],
  ): Promise<AuthSession> {
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + this.sessionTtlSeconds * 1_000);
    await this.repository.createUserSession({
      authMethod,
      csrfTokenHash: hashSecret(csrfToken),
      expiresAt,
      ipAddressHash: requestMetadataHash(request.ip),
      label: null,
      tokenHash: hashSecret(token),
      userAgentHash: requestMetadataHash(request.headers["user-agent"]),
      userId: user.id,
    });
    const cookies = [
      this.serializeCookie(this.cookieName, token, this.sessionTtlSeconds),
    ];
    if (this.partitionedCookieName) {
      cookies.push(
        this.serializeCookie(
          this.partitionedCookieName,
          token,
          this.sessionTtlSeconds,
          true,
        ),
      );
    }
    reply.header("set-cookie", cookies);
    return { currentUser: user, csrfToken, expiresAt: expiresAt.toISOString() };
  }

  async rotateCsrf(session: ActiveUserSession): Promise<AuthSession> {
    const csrfToken = randomBytes(32).toString("base64url");
    await this.repository.rotateSessionCsrfToken(
      session.id,
      hashSecret(csrfToken),
    );
    return {
      currentUser: session.user,
      csrfToken,
      expiresAt: session.expiresAt.toISOString(),
    };
  }

  csrfMatches(session: ActiveUserSession, candidate: unknown): boolean {
    if (typeof candidate !== "string" || candidate.length > 512) return false;
    const candidateHash = Buffer.from(hashSecret(candidate), "hex");
    const expectedHash = Buffer.from(session.csrfTokenHash, "hex");
    return (
      candidateHash.length === expectedHash.length &&
      timingSafeEqual(candidateHash, expectedHash)
    );
  }

  clear(reply: FastifyReply): void {
    const cookies = [this.serializeCookie(this.cookieName, "", 0)];
    if (this.partitionedCookieName) {
      cookies.push(
        this.serializeCookie(this.partitionedCookieName, "", 0, true),
      );
    }
    reply.header("set-cookie", cookies);
  }

  private serializeCookie(
    name: string,
    value: string,
    maxAge: number,
    partitioned = false,
  ): string {
    const attributes = [
      `${name}=${encodeURIComponent(value)}`,
      "Path=/",
      "HttpOnly",
      `SameSite=${this.cookieSameSite}`,
      `Max-Age=${maxAge}`,
    ];
    if (this.cookieSecure) attributes.push("Secure");
    if (partitioned) attributes.push("Partitioned");
    return attributes.join("; ");
  }
}

export class AuthRateLimiter {
  private readonly attempts = new Map<string, number[]>();
  private consumed = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  consume(key: string, now = Date.now()): number | null {
    const cutoff = now - this.windowMs;
    this.consumed += 1;
    if (this.consumed % 256 === 0) {
      for (const [candidateKey, timestamps] of this.attempts) {
        if ((timestamps.at(-1) ?? 0) <= cutoff) {
          this.attempts.delete(candidateKey);
        }
      }
      while (this.attempts.size > 10_000) {
        const oldestKey = this.attempts.keys().next().value as
          string | undefined;
        if (!oldestKey) break;
        this.attempts.delete(oldestKey);
      }
    }
    const attempts = (this.attempts.get(key) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );
    if (attempts.length >= this.limit) {
      this.attempts.set(key, attempts);
      return Math.max(
        1,
        Math.ceil((attempts[0]! + this.windowMs - now) / 1_000),
      );
    }
    attempts.push(now);
    this.attempts.set(key, attempts);
    return null;
  }
}
