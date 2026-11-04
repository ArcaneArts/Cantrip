# Endpoint model providers

Provider kinds identify the backend software. A provider ID identifies one
configured instance of that backend. The shared definitions in
`packages/protocol/src/provider-definitions.ts` own setup defaults, display
labels, and instance multiplicity. Settings and server account classification
consume those definitions.

Ollama and generic OpenAI-compatible endpoints are repeatable. Each instance
keeps its own name, URL, encrypted credential, concurrency limit, catalog, and
model route references. Three Ollama servers can expose the same native model
ID without sharing provider identity. ChatGPT and Grok retain one provider
container per owner, each supporting multiple signed-in accounts.

URLs are API roots as reached from the selected worker. Loopback addresses
refer to that worker, while LAN addresses may reach another machine. Reverse
proxy prefixes and IPv6 authorities are preserved when removing pasted
`/responses`, `/chat/completions`, or `/chat` endpoint suffixes.

## Additional backend delivery

The first delivery establishes shared definitions and verifies existing
endpoint-instance isolation. Subsequent deliveries add distinct LM Studio /
llmster, llama.cpp, vLLM, Unsloth, MLX-LM, and LiteLLM provider kinds with their
working inference and discovery paths. These additional providers are not yet
exposed by this foundation. Managed downloads, engine installation, and
training remain separate from endpoint connections.

Validation distinguishes deterministic endpoint fixtures from real backend
execution. Backend versions, model configurations, and actual smoke-test
results will be recorded with each implementation.
