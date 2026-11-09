import {
  providerConnectionFailureStage,
  providerConnectionFailureMessage,
} from "../../tests/reference-node-server/src/models/provider-connection-test.ts";
const inputs = [
  "",
  "worker",
  "offline",
  "worker offline",
  "WORKER NOT FOUND",
  "worKer not available",
  "codex runtime",
  "app-server",
  "codex binary",
  "before listening",
  "spawn codex",
  "401",
  "403",
  "4010",
  "unauthorized",
  "forbidden",
  "API KEY",
  "authentication",
  "model not found",
  "unknown model",
  "unsupported model",
  "model unavailable",
  "no enabled Z.ai model",
  "404",
  "responses endpoint",
  "endpoint",
  "wire api",
  "429 Too Many Requests",
  "\ud800",
  "\udfff",
  "😀",
];
const cases = [];
for (const a of inputs)
  for (const b of ["", ...inputs]) {
    const input = `\ufeff ${a} ${b} \u2029`;
    const stage = providerConnectionFailureStage(input);
    cases.push({
      input,
      stage,
      message: providerConnectionFailureMessage(stage, input),
    });
  }
const diagnostics = [
  "HTTP 401 sensitive-probe-secret echoed-key",
  "http/1.1 status: 404 sensitive-probe-secret response-body",
  "STATUS=429 DNS sensitive-probe-secret",
  "ECONNREFUSED sensitive-probe-secret",
  "ENOTFOUND sensitive-probe-secret",
  "request timed out sensitive-probe-secret",
  "context" + "😀".repeat(20) + "exceeded sensitive-probe-secret",
  "context" + "😀".repeat(21) + "exceeded sensitive-probe-secret",
  "maximum" + "😀".repeat(10) + "context sensitive-probe-secret",
  "maximum" + "😀".repeat(11) + "context sensitive-probe-secret",
  "context\nexceeded sensitive-probe-secret",
  "HTTP/2 503 certificate sensitive-probe-secret",
  "\ud800 status: 401 \udfff sensitive-probe-secret",
  "econnrefused DNS timeout context exceeded SSL sensitive-probe-secret",
];
for (const input of diagnostics)
  for (const providerName of [
    undefined,
    "",
    "LM Studio",
    "llama.cpp",
    "vLLM",
    "Unsloth",
    "LiteLLM",
    "Ollama",
    "OpenAI compatible",
  ]) {
    const stage = providerConnectionFailureStage(input);
    const message = providerConnectionFailureMessage(
      stage,
      input,
      providerName,
    );
    if (message.includes("sensitive-probe-secret"))
      throw new Error("Source leaked the synthetic provider diagnostic");
    cases.push({
      input,
      stage,
      message,
      ...(providerName === undefined ? {} : { providerName }),
    });
  }
process.stdout.write(JSON.stringify({ cases }));
