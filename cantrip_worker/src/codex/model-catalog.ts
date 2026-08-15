import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { WorkerCommand } from "@cantrip/protocol";

type RuntimeModel = Extract<WorkerCommand, { type: "chat.turn" }>["model"];
type RuntimeProvider = Extract<
  WorkerCommand,
  { type: "chat.turn" }
>["provider"];

const SUPPORTED_INPUT_MODALITIES = new Set(["text", "image", "audio"]);

// Codex 0.147+ requires every externally supplied model to define its base
// instructions. Cantrip adds its product-specific guidance separately as
// developer instructions, so keep this model-agnostic and concise.
export const CANTRIP_MANAGED_MODEL_BASE_INSTRUCTIONS =
  "You are Codex, a coding agent. Follow the developer and user instructions. Use the available tools to inspect and modify the repository, run commands, and verify your work. Continue until the user's request is complete.";

export function codexCatalogForRuntimeModel(model: RuntimeModel) {
  const catalog = model.catalog;
  if (!catalog) return null;
  const supportsTools = catalog.supportsTools;
  const supportsReasoning = catalog.supportsReasoning === true;
  const inputModalities = catalog.inputModalities.filter((modality) =>
    SUPPORTED_INPUT_MODALITIES.has(modality),
  );
  const supportedReasoningLevels = supportsReasoning
    ? catalog.supportedReasoningEfforts.map((option) => ({
        effort: option.effort,
        description: option.description ?? option.effort,
      }))
    : [];
  const compHash = createHash("sha256")
    .update(
      JSON.stringify({
        slug: model.name,
        contextWindow: catalog.contextWindow,
        inputModalities,
        supportsTools,
        supportsParallelTools: catalog.supportsParallelTools,
        supportedReasoningLevels,
      }),
    )
    .digest("hex");
  return {
    models: [
      {
        slug: model.name,
        display_name: catalog.displayName,
        description: catalog.description,
        base_instructions: CANTRIP_MANAGED_MODEL_BASE_INSTRUCTIONS,
        // Cantrip's "Default" means the client did not choose an effort. Do
        // not turn an advertised provider default into an explicit request.
        default_reasoning_level: null,
        supported_reasoning_levels: supportedReasoningLevels,
        shell_type: supportsTools === false ? "disabled" : "shell_command",
        visibility: "list",
        supported_in_api: true,
        priority: 0,
        additional_speed_tiers: [],
        service_tiers: [],
        default_service_tier: null,
        availability_nux: null,
        upgrade: null,
        model_messages: null,
        include_skills_usage_instructions: false,
        include_plugin_usage_instructions: false,
        include_apps_usage_instructions: false,
        // Compatible providers expose reasoning output without implementing
        // OpenAI's reasoning-summary request parameter.
        supports_reasoning_summary_parameter: false,
        default_reasoning_summary: "auto",
        support_verbosity: false,
        default_verbosity: null,
        apply_patch_tool_type: supportsTools === true ? "freeform" : null,
        web_search_tool_type: "text",
        truncation_policy: { mode: "bytes", limit: 10_000 },
        supports_parallel_tool_calls: catalog.supportsParallelTools === true,
        supports_image_detail_original: false,
        context_window: catalog.contextWindow,
        max_context_window: catalog.contextWindow,
        auto_compact_token_limit: null,
        comp_hash: `cantrip-${compHash}`,
        effective_context_window_percent: 95,
        experimental_supported_tools: [],
        input_modalities:
          inputModalities.length > 0 ? inputModalities : ["text"],
        supports_search_tool: false,
        use_responses_lite: false,
        auto_review_model_override: null,
        model_specialty: null,
        tool_mode: null,
        multi_agent_version: null,
      },
    ],
  };
}

export async function writeManagedCodexModelCatalog(
  dataDirectory: string,
  model: RuntimeModel,
  provider: RuntimeProvider,
): Promise<string | null> {
  if (provider.kind === "chatgpt") return null;
  const catalog = codexCatalogForRuntimeModel(model);
  if (!catalog) return null;
  await mkdir(dataDirectory, { recursive: true });
  const catalogPath = path.resolve(dataDirectory, "cantrip-model-catalog.json");
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return catalogPath;
}
