import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { WorkerCommand } from "@cantrip/protocol";
import type { RuntimeProvider } from "../protected-secrets.js";

type RuntimeModel = Extract<WorkerCommand, { type: "chat.turn" }>["model"];

const SUPPORTED_INPUT_MODALITIES = new Set(["text", "image", "audio"]);

// Codex 0.149+ requires every externally supplied model to define its base
// instructions. Cantrip adds its product-specific guidance separately as
// developer instructions, so keep this model-agnostic and concise.
export const CANTRIP_MANAGED_MODEL_BASE_INSTRUCTIONS =
  "You are Codex, a coding agent. Follow the developer and user instructions. Use the available tools to inspect and modify the repository, run commands, and verify your work. Continue until the user's request is complete.";

function isKnownGrokVisionModel(modelName: string): boolean {
  const slug = modelName.trim().toLowerCase().split("/").at(-1) ?? "";
  return /^grok-4(?:[.-]|$)/u.test(slug);
}

export function runtimeModelSupportsImages(
  model: RuntimeModel,
  providerKind: RuntimeProvider["kind"],
): boolean {
  const catalog = model.catalog;
  if (catalog?.supportsVision === true) return true;
  if (
    catalog?.inputModalities.some(
      (modality) => modality.trim().toLowerCase() === "image",
    )
  ) {
    return true;
  }
  if (catalog?.supportsVision === false) return false;
  // Grok's subscription catalog currently omits modality metadata even for
  // the Grok 4 family that xAI documents as accepting Responses input_image.
  return providerKind === "grok" && isKnownGrokVisionModel(model.name);
}

function codexCatalogEntryForRuntimeModel(
  model: RuntimeModel,
  providerKind: RuntimeProvider["kind"],
  priority: number,
) {
  const catalog = model.catalog;
  if (!catalog) return null;
  const supportsTools = catalog.supportsTools;
  const isZai =
    providerKind === "openai-compatible" && catalog.metadataSource === "zai";
  const supportsFreeformTools =
    isZai || (providerKind !== "openai-compatible" && providerKind !== "grok");
  const supportsReasoning = catalog.supportsReasoning === true;
  const inputModalities = catalog.inputModalities
    .map((modality) => modality.trim().toLowerCase())
    .filter((modality) => SUPPORTED_INPUT_MODALITIES.has(modality));
  if (
    runtimeModelSupportsImages(model, providerKind) &&
    !inputModalities.includes("image")
  ) {
    inputModalities.push("image");
  }
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
        supportsFreeformTools,
        supportsParallelTools: catalog.supportsParallelTools,
        supportedReasoningLevels,
      }),
    )
    .digest("hex");
  return {
    slug: model.name,
    display_name: catalog.displayName,
    description: catalog.description,
    base_instructions: CANTRIP_MANAGED_MODEL_BASE_INSTRUCTIONS,
    // Cantrip's "Default" means the client did not explicitly choose an
    // effort. Z.ai's bundled Codex catalog nevertheless needs the
    // documented model default so Codex can preserve provider behavior.
    default_reasoning_level: isZai ? catalog.defaultReasoningEffort : null,
    supported_reasoning_levels: supportedReasoningLevels,
    shell_type: supportsTools === false ? "disabled" : "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority,
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
    // Third-party Responses implementations commonly support JSON-schema
    // function tools but reject OpenAI's custom/freeform tool extension.
    // Keep edits available through the normal shell tool on those routes.
    apply_patch_tool_type:
      supportsTools === true && supportsFreeformTools ? "freeform" : null,
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
    input_modalities: inputModalities.length > 0 ? inputModalities : ["text"],
    supports_search_tool: false,
    use_responses_lite: false,
    auto_review_model_override: null,
    model_specialty: null,
    tool_mode: null,
    multi_agent_version: null,
  };
}

export function codexCatalogForRuntimeModels(
  models: RuntimeModel[],
  providerKind: RuntimeProvider["kind"] = "ollama",
) {
  const unique = new Map<string, RuntimeModel>();
  for (const model of models) {
    if (!unique.has(model.name)) unique.set(model.name, model);
  }
  const entries = [...unique.values()].flatMap((model, priority) => {
    const entry = codexCatalogEntryForRuntimeModel(
      model,
      providerKind,
      priority,
    );
    return entry ? [entry] : [];
  });
  return entries.length ? { models: entries } : null;
}

export function codexCatalogForRuntimeModel(
  model: RuntimeModel,
  providerKind: RuntimeProvider["kind"] = "ollama",
) {
  return codexCatalogForRuntimeModels([model], providerKind);
}

export async function writeManagedCodexModelCatalog(
  dataDirectory: string,
  model: RuntimeModel,
  provider: RuntimeProvider,
  subagentModel: RuntimeModel | null = null,
): Promise<string | null> {
  if (provider.kind === "chatgpt") return null;
  const catalog = codexCatalogForRuntimeModels(
    [model, ...(subagentModel ? [subagentModel] : [])],
    provider.kind,
  );
  if (!catalog) return null;
  await mkdir(dataDirectory, { recursive: true });
  const catalogPath = path.resolve(dataDirectory, "cantrip-model-catalog.json");
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return catalogPath;
}
