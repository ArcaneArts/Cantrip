import {
  providerConnectionFailureStage,
  providerConnectionFailureMessage,
} from "../../cantrip_server/src/models/provider-connection-test.ts";
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
process.stdout.write(JSON.stringify({ cases }));
