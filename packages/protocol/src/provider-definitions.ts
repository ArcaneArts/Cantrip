/** Shared setup policy. Provider kinds identify a backend; IDs identify instances. */
export const nativeEndpointProviderKinds = [
  "lm-studio",
  "llama-cpp",
  "vllm",
  "unsloth",
  "litellm",
] as const;

export const endpointProviderKinds = [
  ...nativeEndpointProviderKinds,
  "mlx-lm",
] as const;

export const modelProviderKinds = [
  "chatgpt",
  "grok",
  "ollama",
  ...endpointProviderKinds,
  "openai-compatible",
] as const;

export type AccountProviderKind = "chatgpt" | "grok";

export interface ProviderDefinition {
  label: string;
  setupLabel: string;
  defaultName: string;
  defaultBaseUrl: string;
  multipleInstances: boolean;
  adapter?: "chat-completions";
}

export const providerDefinitions = {
  chatgpt: {
    label: "ChatGPT",
    setupLabel: "ChatGPT Account",
    defaultName: "ChatGPT",
    defaultBaseUrl: "https://api.openai.com/v1",
    multipleInstances: false,
  },
  grok: {
    label: "Grok",
    setupLabel: "Grok / SuperGrok Account",
    defaultName: "Grok",
    defaultBaseUrl: "https://cli-chat-proxy.grok.com/v1",
    multipleInstances: false,
  },
  ollama: {
    label: "Ollama",
    setupLabel: "Ollama",
    defaultName: "Ollama",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    multipleInstances: true,
  },
  "lm-studio": {
    label: "LM Studio",
    setupLabel: "LM Studio / llmster",
    defaultName: "LM Studio",
    defaultBaseUrl: "http://127.0.0.1:1234/v1",
    multipleInstances: true,
  },
  "llama-cpp": {
    label: "llama.cpp",
    setupLabel: "llama.cpp",
    defaultName: "llama.cpp",
    defaultBaseUrl: "http://127.0.0.1:8080/v1",
    multipleInstances: true,
  },
  "mlx-lm": {
    label: "MLX-LM",
    setupLabel: "MLX-LM",
    defaultName: "MLX-LM",
    defaultBaseUrl: "http://127.0.0.1:8080/v1",
    multipleInstances: true,
    adapter: "chat-completions",
  },
  vllm: {
    label: "vLLM",
    setupLabel: "vLLM",
    defaultName: "vLLM",
    defaultBaseUrl: "http://127.0.0.1:8000/v1",
    multipleInstances: true,
  },
  unsloth: {
    label: "Unsloth",
    setupLabel: "Unsloth",
    defaultName: "Unsloth",
    defaultBaseUrl: "http://127.0.0.1:8888/v1",
    multipleInstances: true,
  },
  litellm: {
    label: "LiteLLM",
    setupLabel: "LiteLLM",
    defaultName: "LiteLLM",
    defaultBaseUrl: "http://127.0.0.1:4000/v1",
    multipleInstances: true,
  },
  "openai-compatible": {
    label: "OpenAI compatible",
    setupLabel: "Custom OpenAI compatible",
    defaultName: "OpenAI compatible",
    defaultBaseUrl: "https://",
    multipleInstances: true,
  },
} as const satisfies Record<
  (typeof modelProviderKinds)[number],
  ProviderDefinition
>;

export function isAccountProviderKind(
  kind: string,
): kind is AccountProviderKind {
  return kind === "chatgpt" || kind === "grok";
}

/** Catalogs for these backends are observed from a selected worker. */
export function isWorkerEndpointProviderKind(
  kind: string,
): kind is "ollama" | (typeof endpointProviderKinds)[number] {
  return (
    kind === "ollama" ||
    endpointProviderKinds.some((candidate) => candidate === kind)
  );
}

export function providerUsesChatCompletions(
  kind: (typeof modelProviderKinds)[number],
) {
  const definition = providerDefinitions[kind];
  return "adapter" in definition && definition.adapter === "chat-completions";
}

export function providerSetupDefinition(
  kind: (typeof modelProviderKinds)[number],
) {
  const definition = providerDefinitions[kind];
  return {
    id: kind,
    kind,
    label: definition.setupLabel,
    name: definition.defaultName,
    baseUrl: definition.defaultBaseUrl,
  };
}
