import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderInferenceProgress } from "../src/inference-progress.js";
import {
  isLocallyObservableOllamaProvider,
  OllamaLogInferenceProgressAdapter,
  parseOllamaPrefillProgressLine,
} from "../src/ollama-inference-progress.js";
import type { RuntimeProvider } from "../src/protected-secrets.js";

const temporaryDirectories: string[] = [];

function provider(
  kind: RuntimeProvider["kind"] = "ollama",
  baseUrl = "http://127.0.0.1:11434/v1",
): RuntimeProvider {
  return {
    id: "provider-one",
    name: "Local Ollama",
    kind,
    baseUrl,
    protectedApiKey: null,
    accountId: null,
    credentialHomeKey: null,
    apiKey: null,
  };
}

async function temporaryLog(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cantrip-ollama-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "server.log");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Ollama inference progress", () => {
  it("parses MLX prompt-processing records and rejects malformed counts", () => {
    expect(
      parseOllamaPrefillProgressLine(
        'time=2026-08-24T12:00:00Z level=INFO msg="Prompt processing progress" processed=2048 total=46492',
      ),
    ).toEqual({
      fractionComplete: 2_048 / 46_492,
      processed: 2_048,
      total: 46_492,
    });
    expect(
      parseOllamaPrefillProgressLine(
        "slot print_timing: id 0 | task 249 | prompt processing, n_tokens = 10240, progress = 0.12, t = 98.02 s",
      ),
    ).toEqual({
      fractionComplete: 0.12,
      processed: 10_240,
      total: null,
    });
    expect(
      parseOllamaPrefillProgressLine(
        'msg="Prompt processing progress" processed=500 total=100',
      ),
    ).toBeNull();
    expect(parseOllamaPrefillProgressLine("unrelated Ollama log")).toBeNull();
  });

  it("only activates for a local Ollama endpoint", () => {
    const onProgress = () => undefined;
    expect(
      isLocallyObservableOllamaProvider({
        modelName: "qwen3",
        provider: provider(),
        onProgress,
      }),
    ).toBe(true);
    expect(
      isLocallyObservableOllamaProvider({
        modelName: "qwen3",
        provider: provider("ollama", "http://ollama.internal:11434/v1"),
        onProgress,
      }),
    ).toBe(false);
    expect(
      isLocallyObservableOllamaProvider({
        modelName: "qwen3",
        provider: provider("openai-compatible"),
        onProgress,
      }),
    ).toBe(false);
  });

  it("tails only new records and reports a request-scoped percentage", async () => {
    const logPath = await temporaryLog();
    await writeFile(
      logPath,
      'msg="Prompt processing progress" processed=2048 total=9999\n',
    );
    const updates: ProviderInferenceProgress[] = [];
    const adapter = new OllamaLogInferenceProgressAdapter({
      logPath,
      pollIntervalMs: 5,
    });
    const observation = await adapter.observe({
      modelName: "qwen3.8:27b-mlx",
      provider: provider(),
      onProgress: (progress) => updates.push(progress),
    });

    expect(observation).not.toBeNull();
    expect(updates).toEqual([
      expect.objectContaining({
        phase: "prefill",
        precision: "indeterminate",
      }),
    ]);
    await appendFile(
      logPath,
      'msg="Prompt processing progress" processed=10240 total=46492\n',
    );
    await vi.waitFor(() =>
      expect(updates).toContainEqual({
        phase: "prefill",
        fractionComplete: 10_240 / 46_492,
        completedTokens: 10_240,
        totalTokens: 46_492,
        precision: "estimated",
        source: "provider-observer",
      }),
    );
    await observation?.close();
  });

  it("falls back to indeterminate progress when requests overlap", async () => {
    const logPath = await temporaryLog();
    await writeFile(logPath, "");
    const first: ProviderInferenceProgress[] = [];
    const second: ProviderInferenceProgress[] = [];
    const adapter = new OllamaLogInferenceProgressAdapter({
      logPath,
      pollIntervalMs: 5,
    });
    const firstObservation = await adapter.observe({
      modelName: "first",
      provider: provider(),
      onProgress: (progress) => first.push(progress),
    });
    const secondObservation = await adapter.observe({
      modelName: "second",
      provider: provider(),
      onProgress: (progress) => second.push(progress),
    });
    await appendFile(
      logPath,
      'msg="Prompt processing progress" processed=2048 total=46492\n',
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(first.every(({ precision }) => precision === "indeterminate")).toBe(
      true,
    );
    expect(second.every(({ precision }) => precision === "indeterminate")).toBe(
      true,
    );
    await firstObservation?.close();
    await secondObservation?.close();
  });
});
