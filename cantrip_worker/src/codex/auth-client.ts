import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import readline from "node:readline";

import {
  codexAuthStatusSchema,
  codexDeviceLoginSchema,
  type CodexAuthStatus,
  type CodexDeviceLogin,
} from "@cantrip/protocol";

import { workerLogger } from "../logger.js";

import {
  weeklyUsageFromRateLimits,
  type AccountRateLimitsResult,
} from "./rate-limits.js";

interface RpcMessage {
  error?: { message: string };
  id?: number;
  result?: unknown;
}

interface PendingRequest {
  method: string;
  reject(error: Error): void;
  resolve(value: unknown): void;
  startedAtMs: number;
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
    const startedAtMs = Date.now();
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
    const status = codexAuthStatusSchema.parse({
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
    workerLogger.sampled(
      `codex-auth-status:${this.codexHome}`,
      10,
      "debug",
      "Codex account status refreshed",
      {
        event: "codex.auth.status",
        subsystem: "codex-auth",
        operation: "read-status",
        status: status.authenticated ? "authenticated" : "signed-out",
        authMode: status.authMode,
        durationMs: Date.now() - startedAtMs,
      },
    );
    return status;
  }

  async startDeviceLogin(): Promise<CodexDeviceLogin> {
    const startedAtMs = Date.now();
    workerLogger.event("info", "Codex device login started", {
      event: "codex.auth.login",
      subsystem: "codex-auth",
      operation: "start-device-login",
      status: "started",
    });
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
    workerLogger.event("info", "Codex device login is awaiting authorization", {
      event: "codex.auth.login",
      subsystem: "codex-auth",
      operation: "start-device-login",
      status: "pending",
      durationMs: Date.now() - startedAtMs,
    });
    return codexDeviceLoginSchema.parse(result);
  }

  async logout(): Promise<void> {
    const startedAtMs = Date.now();
    await this.ensureStarted();
    await this.request("account/logout", undefined);
    this.#weeklyUsageCache = null;
    workerLogger.event("info", "Codex account signed out", {
      event: "codex.auth.logout",
      subsystem: "codex-auth",
      operation: "logout",
      status: "completed",
      durationMs: Date.now() - startedAtMs,
    });
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
      )) as AccountRateLimitsResult;
      const value = weeklyUsageFromRateLimits(result);
      this.#weeklyUsageCache = { fetchedAt: Date.now(), value };
      return value;
    } catch {
      return null;
    }
  }

  close(): void {
    if (this.#child) {
      workerLogger.event("info", "Codex authentication service stopping", {
        event: "codex.auth.runtime",
        subsystem: "codex-auth",
        operation: "stop",
        status: "started",
        counts: { pendingRequests: this.#pending.size },
      });
    }
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
    const startedAtMs = Date.now();
    workerLogger.event("debug", "Codex authentication service starting", {
      event: "codex.auth.runtime",
      subsystem: "codex-auth",
      operation: "start",
      status: "started",
    });
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
    // Authentication subprocess output can contain credentials or device-flow
    // material. Drain it without ever forwarding the payload into service logs.
    child.stderr.resume();
    child.once("exit", (code, signal) => {
      workerLogger.event(
        code === 0 || signal === "SIGTERM" ? "info" : "warn",
        "Codex authentication service exited",
        {
          event: "codex.auth.runtime",
          subsystem: "codex-auth",
          operation: "start",
          status: code === 0 || signal === "SIGTERM" ? "stopped" : "failed",
          exitCode: code,
          signal,
          durationMs: Date.now() - startedAtMs,
          counts: { pendingRequests: this.#pending.size },
        },
      );
      if (this.#child === child) this.#child = null;
      this.rejectPending(new Error("Codex authentication service exited."));
    });
    await this.request("initialize", {
      clientInfo: { name: "cantrip", title: "Cantrip", version: "0.0.0" },
    });
    child.stdin.write(
      `${JSON.stringify({ method: "initialized", params: {} })}\n`,
    );
    workerLogger.event("info", "Codex authentication service ready", {
      event: "codex.auth.runtime",
      subsystem: "codex-auth",
      operation: "start",
      status: "ready",
      durationMs: Date.now() - startedAtMs,
    });
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
      const startedAtMs = Date.now();
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        workerLogger.rateLimited(
          `codex-auth-timeout:${method}`,
          "warn",
          "Codex authentication request timed out",
          {
            event: "codex.auth.rpc.timeout",
            subsystem: "codex-auth",
            operation: method,
            status: "timed-out",
            durationMs: Date.now() - startedAtMs,
          },
        );
        reject(new Error(`Codex auth request ${method} timed out.`));
      }, 30_000);
      this.#pending.set(id, {
        method,
        reject,
        resolve,
        startedAtMs,
        timeout,
      });
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
