import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { WorkerCommand } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  CANTRIP_MANAGED_MODEL_BASE_INSTRUCTIONS,
  codexCatalogForRuntimeModel,
  runtimeModelSupportsImages,
  writeManagedCodexModelCatalog,
} from "../src/codex/model-catalog.js";

type TurnCommand = Extract<WorkerCommand, { type: "chat.turn" }>;

const model: TurnCommand["model"] = {
  id: "logical-gemma",
  routeId: "route-gemma",
  name: "gemma4:12b",
  reasoningEffort: null,
  catalog: {
    nativeModelId: "gemma4:12b",
    displayName: "Gemma 4 12B",
    description: "Local Gemma model",
    contextWindow: 131_072,
    maxOutputTokens: null,
    inputModalities: ["text", "image", "future-modality"],
    outputModalities: ["text"],
    supportsTools: true,
    supportsParallelTools: null,
    supportsStructuredOutput: true,
    supportsVision: true,
    supportsReasoning: true,
    supportedReasoningEfforts: [
      { effort: "medium", description: "Balanced" },
      { effort: "provider-future-effort", description: null },
    ],
    defaultReasoningEffort: "medium",
    reasoningMandatory: null,
    metadataSource: "ollama",
  },
};

const provider = (kind: TurnCommand["provider"]["kind"]) =>
  ({
    id: `provider-${kind}`,
    name: kind,
    kind,
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: null,
    accountId: null,
    credentialHomeKey: null,
  }) satisfies TurnCommand["provider"];

describe("managed Codex model catalogs", () => {
  it("maps normalized metadata to conservative Codex ModelInfo", () => {
    expect(codexCatalogForRuntimeModel(model)).toEqual({
      models: [
        expect.objectContaining({
          slug: "gemma4:12b",
          display_name: "Gemma 4 12B",
          base_instructions: CANTRIP_MANAGED_MODEL_BASE_INSTRUCTIONS,
          context_window: 131_072,
          max_context_window: 131_072,
          auto_compact_token_limit: null,
          effective_context_window_percent: 95,
          input_modalities: ["text", "image"],
          shell_type: "shell_command",
          apply_patch_tool_type: "freeform",
          supports_parallel_tool_calls: false,
          default_reasoning_level: null,
          supports_reasoning_summary_parameter: false,
          supported_reasoning_levels: [
            { effort: "medium", description: "Balanced" },
            {
              effort: "provider-future-effort",
              description: "provider-future-effort",
            },
          ],
        }),
      ],
    });
  });

  it("writes custom-provider catalogs but leaves ChatGPT native", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cantrip-model-"));
    try {
      const catalogPath = await writeManagedCodexModelCatalog(
        directory,
        model,
        provider("ollama"),
      );
      expect(catalogPath).toBe(
        path.join(directory, "cantrip-model-catalog.json"),
      );
      expect(
        JSON.parse(await readFile(catalogPath!, "utf8")) as unknown,
      ).toMatchObject({ models: [{ slug: "gemma4:12b" }] });
      expect(
        await writeManagedCodexModelCatalog(
          directory,
          model,
          provider("chatgpt"),
        ),
      ).toBeNull();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it.each(["openai-compatible", "grok"] as const)(
    "does not advertise OpenAI custom tools to %s providers",
    (providerKind) => {
      expect(
        codexCatalogForRuntimeModel(model, providerKind)?.models[0],
      ).toMatchObject({
        shell_type: "shell_command",
        apply_patch_tool_type: null,
      });
    },
  );

  it("keeps freeform edits available to native local runtimes", () => {
    expect(
      codexCatalogForRuntimeModel(model, "ollama")?.models[0],
    ).toMatchObject({
      shell_type: "shell_command",
      apply_patch_tool_type: "freeform",
    });
  });

  it("advertises image input for Grok 4 when its native catalog omits modalities", () => {
    const grokModel = {
      ...model,
      name: "grok-4.6",
      catalog: {
        ...model.catalog!,
        inputModalities: ["text"],
        supportsVision: null,
      },
    } satisfies TurnCommand["model"];
    expect(runtimeModelSupportsImages(grokModel, "grok")).toBe(true);
    expect(
      codexCatalogForRuntimeModel(grokModel, "grok")?.models[0],
    ).toMatchObject({ input_modalities: ["text", "image"] });
  });
});
