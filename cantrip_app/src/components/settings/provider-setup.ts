import {
  isZaiCodingPlanBaseUrl,
  ZAI_CODING_PLAN_BASE_URL,
  type ModelProviderKind,
  type ModelProviderSummary,
} from "@cantrip/protocol";

export type ProviderSetupKind =
  ModelProviderKind | "openai" | "openrouter" | "xai" | "zai";

export const providerSetupOptions = [
  {
    id: "ollama",
    label: "Ollama",
    name: "Ollama",
    kind: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    name: "OpenRouter",
    kind: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  {
    id: "zai",
    label: "Z.ai Coding Plan",
    name: "Z.ai Coding Plan",
    kind: "openai-compatible",
    baseUrl: ZAI_CODING_PLAN_BASE_URL,
  },
  {
    id: "xai",
    label: "xAI API key",
    name: "xAI API",
    kind: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
  },
  {
    id: "openai",
    label: "OpenAI API",
    name: "OpenAI API",
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
  },
  {
    id: "openai-compatible",
    label: "Custom OpenAI compatible",
    name: "OpenAI compatible",
    kind: "openai-compatible",
    baseUrl: "https://",
  },
  {
    id: "chatgpt",
    label: "ChatGPT Account",
    name: "ChatGPT",
    kind: "chatgpt",
    baseUrl: "https://api.openai.com/v1",
  },
  {
    id: "grok",
    label: "Grok / SuperGrok Account",
    name: "Grok",
    kind: "grok",
    baseUrl: "https://cli-chat-proxy.grok.com/v1",
  },
] as const satisfies readonly {
  id: ProviderSetupKind;
  label: string;
  name: string;
  kind: ModelProviderKind;
  baseUrl: string;
}[];

export function providerSetupDefaults(setup: ProviderSetupKind) {
  return providerSetupOptions.find(({ id }) => id === setup)!;
}

export function providerSetupFor(
  provider: ModelProviderSummary,
): ProviderSetupKind {
  if (provider.kind !== "openai-compatible") return provider.kind;
  if (isZaiCodingPlanBaseUrl(provider.baseUrl)) return "zai";
  return (
    providerSetupOptions.find(
      (setup) =>
        setup.kind === "openai-compatible" &&
        setup.id !== "openai-compatible" &&
        setup.baseUrl === provider.baseUrl,
    )?.id ?? "openai-compatible"
  );
}
