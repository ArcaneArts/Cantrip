import {
  normalizeResponsesBaseUrl,
  type WorkerCommand,
} from "@cantrip/protocol";

type CodexProvider = Extract<WorkerCommand, { type: "chat.turn" }>["provider"];

export type CodexModelProviderName = "cantrip_runtime" | "ollama" | "openai";

export interface CodexProviderConfiguration {
  arguments: string[];
  environment: Record<string, string>;
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
      arguments: ['model_provider="openai"'],
      environment: {},
    };
  }
  if (modelProvider === "ollama") {
    return {
      arguments: ['model_provider="ollama"'],
      environment: {
        CODEX_OSS_BASE_URL: normalizeResponsesBaseUrl(provider.baseUrl),
      },
    };
  }
  return {
    arguments: [
      'model_provider="cantrip_runtime"',
      `model_providers.cantrip_runtime.name=${JSON.stringify(provider.name)}`,
      `model_providers.cantrip_runtime.base_url=${JSON.stringify(normalizeResponsesBaseUrl(provider.baseUrl))}`,
      'model_providers.cantrip_runtime.wire_api="responses"',
      ...(provider.kind === "grok" ? ['web_search="disabled"'] : []),
      ...(provider.apiKey
        ? ['model_providers.cantrip_runtime.env_key="CANTRIP_PROVIDER_API_KEY"']
        : []),
    ],
    environment: provider.apiKey
      ? { CANTRIP_PROVIDER_API_KEY: provider.apiKey }
      : {},
  };
}
