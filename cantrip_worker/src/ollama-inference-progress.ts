import { open, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  InferenceProgressAdapter,
  InferenceProgressObservation,
  InferenceProgressObservationInput,
} from "./inference-progress.js";

const DEFAULT_POLL_INTERVAL_MS = 250;
const MAX_READ_BYTES = 256 * 1_024;
const MAX_CARRY_BYTES = 16 * 1_024;

export interface OllamaPrefillProgress {
  fractionComplete: number;
  processed: number;
  total: number | null;
}

interface ActiveObservation {
  input: InferenceProgressObservationInput;
}

function loopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

export function isLocallyObservableOllamaProvider(
  input: InferenceProgressObservationInput,
): boolean {
  if (input.provider.kind !== "ollama") return false;
  try {
    return loopbackHostname(new URL(input.provider.baseUrl).hostname);
  } catch {
    return false;
  }
}

export function parseOllamaPrefillProgressLine(
  line: string,
): OllamaPrefillProgress | null {
  if (line.includes('msg="Prompt processing progress"')) {
    const processedMatch = /(?:^|\s)processed=(\d+)(?:\s|$)/.exec(line);
    const totalMatch = /(?:^|\s)total=(\d+)(?:\s|$)/.exec(line);
    if (!processedMatch?.[1] || !totalMatch?.[1]) return null;
    const processed = Number(processedMatch[1]);
    const total = Number(totalMatch[1]);
    if (
      !Number.isSafeInteger(processed) ||
      !Number.isSafeInteger(total) ||
      processed < 0 ||
      total <= 0 ||
      processed > total
    ) {
      return null;
    }
    return { fractionComplete: processed / total, processed, total };
  }
  const runnerMatch =
    /prompt processing,\s+n_tokens\s*=\s*(\d+),\s+progress\s*=\s*(\d+(?:\.\d+)?)/i.exec(
      line,
    );
  if (!runnerMatch?.[1] || !runnerMatch[2]) return null;
  const processed = Number(runnerMatch[1]);
  const fractionComplete = Number(runnerMatch[2]);
  if (
    !Number.isSafeInteger(processed) ||
    processed < 0 ||
    !Number.isFinite(fractionComplete) ||
    fractionComplete < 0 ||
    fractionComplete > 1
  ) {
    return null;
  }
  return { fractionComplete, processed, total: null };
}

export class OllamaLogInferenceProgressAdapter implements InferenceProgressAdapter {
  readonly #active = new Map<symbol, ActiveObservation>();
  readonly #logPath: string;
  readonly #pollIntervalMs: number;
  #carry = "";
  #fileIdentity: string | null = null;
  #offset = 0;
  #polling = false;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(input: { logPath?: string; pollIntervalMs?: number } = {}) {
    this.#logPath =
      input.logPath ?? path.join(os.homedir(), ".ollama", "logs", "server.log");
    this.#pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  async observe(
    input: InferenceProgressObservationInput,
  ): Promise<InferenceProgressObservation | null> {
    if (!isLocallyObservableOllamaProvider(input)) return null;
    const key = Symbol("ollama-inference-observation");
    this.#active.set(key, { input });
    if (this.#active.size === 1) await this.#startTail();
    input.onProgress({
      phase: "prefill",
      fractionComplete: null,
      completedTokens: null,
      totalTokens: null,
      precision: "indeterminate",
      source: "provider-observer",
    });

    let closed = false;
    return {
      close: () => {
        if (closed) return;
        closed = true;
        this.#active.delete(key);
        if (this.#active.size === 0) this.#stopTail();
      },
    };
  }

  async #startTail(): Promise<void> {
    this.#carry = "";
    try {
      const details = await stat(this.#logPath);
      this.#fileIdentity = `${details.dev}:${details.ino}`;
      this.#offset = details.size;
    } catch {
      this.#fileIdentity = null;
      this.#offset = 0;
    }
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.#poll(), this.#pollIntervalMs);
    this.#timer.unref?.();
  }

  #stopTail(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#carry = "";
    this.#fileIdentity = null;
    this.#offset = 0;
  }

  async #poll(): Promise<void> {
    if (this.#polling || this.#active.size === 0) return;
    this.#polling = true;
    try {
      const details = await stat(this.#logPath);
      const identity = `${details.dev}:${details.ino}`;
      if (this.#fileIdentity === null) {
        this.#fileIdentity = identity;
      } else if (
        this.#fileIdentity !== identity ||
        details.size < this.#offset
      ) {
        this.#fileIdentity = identity;
        this.#offset = 0;
        this.#carry = "";
      }
      if (details.size <= this.#offset) return;

      const handle = await open(this.#logPath, "r");
      try {
        while (this.#offset < details.size) {
          const byteLength = Math.min(
            MAX_READ_BYTES,
            details.size - this.#offset,
          );
          const buffer = Buffer.allocUnsafe(byteLength);
          const { bytesRead } = await handle.read(
            buffer,
            0,
            byteLength,
            this.#offset,
          );
          if (bytesRead === 0) break;
          this.#offset += bytesRead;
          this.#consume(buffer.toString("utf8", 0, bytesRead));
        }
      } finally {
        await handle.close();
      }
    } catch {
      // Ollama may rotate or briefly remove its log. The next poll retries.
    } finally {
      this.#polling = false;
    }
  }

  #consume(chunk: string): void {
    const text = this.#carry + chunk;
    const lines = text.split(/\r?\n/);
    this.#carry = lines.pop()?.slice(-MAX_CARRY_BYTES) ?? "";
    for (const line of lines) {
      const progress = parseOllamaPrefillProgressLine(line);
      if (!progress) continue;
      const active = [...this.#active.values()];
      if (active.length !== 1) {
        for (const observation of active) {
          observation.input.onProgress({
            phase: "prefill",
            fractionComplete: null,
            completedTokens: null,
            totalTokens: null,
            precision: "indeterminate",
            source: "provider-observer",
          });
        }
        continue;
      }
      active[0]!.input.onProgress({
        phase: "prefill",
        fractionComplete: progress.fractionComplete,
        completedTokens: progress.processed,
        totalTokens: progress.total,
        // Ollama's log is exact, but it does not expose a request identifier.
        // A single active Cantrip request makes attribution reliable, not exact.
        precision: "estimated",
        source: "provider-observer",
      });
    }
  }
}
