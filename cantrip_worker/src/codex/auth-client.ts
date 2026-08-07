import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import readline from "node:readline";

import {
  codexAuthStatusSchema,
  codexDeviceLoginSchema,
  type CodexAuthStatus,
  type CodexDeviceLogin,
} from "@cantrip/protocol";

interface RpcMessage {
  error?: { message: string };
  id?: number;
  result?: unknown;
}

interface PendingRequest {
  reject(error: Error): void;
  resolve(value: unknown): void;
  timeout: ReturnType<typeof setTimeout>;
}

export class CodexAuthClient {
  #child: ChildProcessWithoutNullStreams | null = null;
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #starting: Promise<void> | null = null;
  #weeklyUsageCache: {
    fetchedAt: number;
    value: { usedPercent: number; resetsAt: number | null } | null;
  } | null = null;

  constructor(
    private readonly codexBinary: string,
    private readonly codexHome: string,
  ) {}

  async status(): Promise<CodexAuthStatus> {
    await this.ensureStarted();
    const result = (await this.request("account/read", {
      refreshToken: false,
    })) as {
      account:
        | { type: "chatgpt"; email: string | null; planType: string }
        | { type: "apiKey" }
        | { type: string }
        | null;
    };
    const account = result.account;
    const weeklyUsage =
      account?.type === "chatgpt" ? await this.weeklyUsage() : null;
    return codexAuthStatusSchema.parse({
      authenticated: account !== null,
      authMode:
        account?.type === "chatgpt"
          ? "chatgpt"
          : account?.type === "apiKey"
            ? "apiKey"
            : account
              ? "other"
              : null,
      email:
        account?.type === "chatgpt" && "email" in account
          ? account.email
          : null,
      planType:
        account?.type === "chatgpt" && "planType" in account
          ? account.planType
          : null,
      weeklyUsage,
    });
  }

  async startDeviceLogin(): Promise<CodexDeviceLogin> {
    await this.ensureStarted();
    const result = (await this.request("account/login/start", {
      type: "chatgptDeviceCode",
    })) as {
      type: string;
      loginId?: string;
      verificationUrl?: string;
      userCode?: string;
    };
    if (result.type !== "chatgptDeviceCode") {
      throw new Error("Codex did not start a ChatGPT device-code login.");
    }
    return codexDeviceLoginSchema.parse(result);
  }

  async logout(): Promise<void> {
    await this.ensureStarted();
    await this.request("account/logout", undefined);
    this.#weeklyUsageCache = null;
  }

  private async weeklyUsage(): Promise<{
    usedPercent: number;
    resetsAt: number | null;
  } | null> {
    if (
      this.#weeklyUsageCache &&
      Date.now() - this.#weeklyUsageCache.fetchedAt < 30_000
    ) {
      return this.#weeklyUsageCache.value;
    }
    try {
      const result = (await this.request(
        "account/rateLimits/read",
        undefined,
      )) as {
        rateLimits?: RateLimitSnapshot;
        rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
      };
      const snapshots = [
        ...(result.rateLimitsByLimitId
          ? Object.values(result.rateLimitsByLimitId)
          : []),
        ...(result.rateLimits ? [result.rateLimits] : []),
      ];
      const windows = snapshots.flatMap((snapshot) =>
        [snapshot.primary, snapshot.secondary].filter(
          (window): window is RateLimitWindow => Boolean(window),
        ),
      );
      const weekly = windows.find(
        (window) => window.windowDurationMins === 7 * 24 * 60,
      );
      const value = weekly
        ? { usedPercent: weekly.usedPercent, resetsAt: weekly.resetsAt }
        : null;
      this.#weeklyUsageCache = { fetchedAt: Date.now(), value };
      return value;
    } catch {
      return null;
    }
  }

  close(): void {
    this.#child?.kill("SIGTERM");
    this.#child = null;
    this.rejectPending(new Error("Codex authentication service stopped."));
  }

  private async ensureStarted(): Promise<void> {
    if (this.#child) return;
    this.#starting ??= this.start();
    try {
      await this.#starting;
    } finally {
      this.#starting = null;
    }
  }

  private async start(): Promise<void> {
    await mkdir(this.codexHome, { recursive: true });
    const child = spawn(
      this.codexBinary,
      [
        "app-server",
        "-c",
        'model_provider="openai"',
        "-c",
        'cli_auth_credentials_store="file"',
      ],
      {
        env: { ...process.env, CODEX_HOME: this.codexHome },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.#child = child;
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      this.handleLine(line);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      process.stderr.write(`[codex-auth] ${chunk}`);
    });
    child.once("exit", () => {
      if (this.#child === child) this.#child = null;
      this.rejectPending(new Error("Codex authentication service exited."));
    });
    await this.request("initialize", {
      clientInfo: { name: "cantrip", title: "Cantrip", version: "0.0.0" },
    });
    child.stdin.write(
      `${JSON.stringify({ method: "initialized", params: {} })}\n`,
    );
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const child = this.#child;
    if (!child?.stdin.writable) {
      return Promise.reject(
        new Error("Codex authentication service is unavailable."),
      );
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex auth request ${method} timed out.`));
      }, 30_000);
      this.#pending.set(id, { reject, resolve, timeout });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  private handleLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

interface RateLimitSnapshot {
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
}
