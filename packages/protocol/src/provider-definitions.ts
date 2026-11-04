/** Shared setup policy. Provider kinds identify a backend; IDs identify instances. */
export const modelProviderKinds = [
  "chatgpt",
  "grok",
  "ollama",
  "openai-compatible",
] as const;

export type AccountProviderKind = "chatgpt" | "grok";

export interface ProviderDefinition {
  label: string;
  setupLabel: string;
  defaultName: string;
  defaultBaseUrl: string;
  multipleInstances: boolean;
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
