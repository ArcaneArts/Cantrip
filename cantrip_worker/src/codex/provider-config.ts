import {
  isZaiCodingPlanBaseUrl,
  normalizeResponsesBaseUrl,
} from "@cantrip/protocol";
import type { RuntimeProvider } from "../protected-secrets.js";

type CodexProvider = RuntimeProvider;

export type CodexModelProviderName = "cantrip_runtime" | "ollama" | "openai";

export interface CodexProviderConfiguration {
  arguments: string[];
  environment: Record<string, string>;
}

const CANTRIP_CODEX_RUNTIME_POLICY = [
  'web_search="disabled"',
  "features.fast_mode=false",
  "agents.enabled=true",
] as const;

const MULTI_AGENT_V1_POLICY = "features.multi_agent=true";

// GPT backends reserve `collaboration.*` and reject the entire request when a
// client-defined tool under that namespace drifts from the server-owned schema.
// Select V2 explicitly and keep Cantrip's tools under a product-owned namespace.
const CHATGPT_MULTI_AGENT_COMPATIBILITY_POLICY = [
  "features.multi_agent=false",
  "features.multi_agent_v2.enabled=true",
  'features.multi_agent_v2.tool_namespace="cantrip_agents"',
] as const;

export function isZaiRuntimeProvider(provider: CodexProvider): boolean {
  return (
    provider.kind === "openai-compatible" &&
    isZaiCodingPlanBaseUrl(provider.baseUrl)
  );
}

export function codexModelProviderName(
  provider: CodexProvider,
): CodexModelProviderName {
  if (provider.kind === "chatgpt") return "openai";
  if (provider.kind === "ollama") return "ollama";
  return "cantrip_runtime";
}

export function codexProviderConfiguration(
  provider: CodexProvider,
): CodexProviderConfiguration {
  const modelProvider = codexModelProviderName(provider);
  if (modelProvider === "openai") {
    return {
      arguments: [
        ...CANTRIP_CODEX_RUNTIME_POLICY,
        ...CHATGPT_MULTI_AGENT_COMPATIBILITY_POLICY,
        'model_provider="openai"',
      ],
      environment: {},
    };
  }
  if (modelProvider === "ollama") {
    return {
      arguments: [
        ...CANTRIP_CODEX_RUNTIME_POLICY,
        MULTI_AGENT_V1_POLICY,
        'model_provider="ollama"',
      ],
      environment: {
        CODEX_OSS_BASE_URL: normalizeResponsesBaseUrl(provider.baseUrl),
      },
    };
  }
  const providerName = isZaiRuntimeProvider(provider)
    ? "Z.ai Coding Plan"
    : provider.name;
  return {
    arguments: [
      ...CANTRIP_CODEX_RUNTIME_POLICY,
      MULTI_AGENT_V1_POLICY,
      'model_provider="cantrip_runtime"',
      `model_providers.cantrip_runtime.name=${JSON.stringify(providerName)}`,
      `model_providers.cantrip_runtime.base_url=${JSON.stringify(normalizeResponsesBaseUrl(provider.baseUrl))}`,
      'model_providers.cantrip_runtime.wire_api="responses"',
      ...(provider.apiKey
        ? ['model_providers.cantrip_runtime.env_key="CANTRIP_PROVIDER_API_KEY"']
        : []),
    ],
    environment: provider.apiKey
      ? { CANTRIP_PROVIDER_API_KEY: provider.apiKey }
      : {},
  };
}
