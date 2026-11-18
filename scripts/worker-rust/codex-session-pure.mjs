import { parseCodexRpcMessage, codexEndpointFromLine, codexStartupExitMessage } from "../../cantrip_worker/src/codex/rpc-protocol.ts";
import { readableCodexProviderError, isChatGptTokenExpiredError, safeEndpointDiagnosticPayload } from "../../cantrip_worker/src/codex/provider-errors.ts";
export async function pure({ native, same }) {
  for (const value of ["not json", "null", "[]", "{}", '{"id":null}', '{"id":false}', '{"method":42}', '{"id":"01","result":null}', '{"id":1.5,"method":""}', '{"id":1,"error":null}', '{"id":1,"error":{"code":-1,"message":"bad","data":{"private":true}}}', '{"method":"future/event","params":{"text":"\\ud800😀"},"historyCursor":17}', '{"method":"\ud800"}', '{"method":"\\\ud800"}'])
    same(await native({ op: "parse", value }), parseCodexRpcMessage(value), "managed RPC parser / retained fields");
  for (const value of ["  listening on: ws://127.0.0.1:1234", "\u001b[32mlistening on:\u001b[0m ws://localhost:1", "listening on: wss://localhost:1", "other listening on: ws://localhost:1", "listening on: ws://localhost:1 extra", "listening on: ws://localhost:1\r"])
    same(await native({ op: "endpoint", value }), codexEndpointFromLine(value), "actual announcement parser");
  for (const lines of [[], ["one", "\u001b[31mfinal\u001b[0m"], ["emoji😀".repeat(450), ""], ["\u001b]0;title\u0007failure"]])
    same(await native({ op: "startup", status: "code 130", lines }), codexStartupExitMessage(130, null, lines), "startup diagnostic / ordinary exit code");
  const errors = ["unexpected status code 401 PRIVATE_RESPONSE", "HTTP/1.1 422 PRIVATE_RESPONSE", "context length exceeded PRIVATE_RESPONSE", "model not found PRIVATE_RESPONSE", "ECONNREFUSED PRIVATE_RESPONSE", "unrecognized PRIVATE_RESPONSE", "401 token_expired", "status 403; token_expired", "invalid API key", "forbidden", "endpoint not found", "unprocessable entity", 'error code: 1310, next_flush_time: "2026-08-19T00:00:00Z"', 'status 429; retry-after: 45', "status 429; retry-after: \ud800", "response stream timed out secret-key Bearer hidden"];
  for (const options of [{}, { zai: true }, { endpoint: true }]) for (const value of errors)
    same(await native({ op: "provider", value, ...options, secrets: ["secret-key"] }), { readable: readableCodexProviderError(value, { ...options, secrets: new Set(["secret-key"]) }), expired: isChatGptTokenExpiredError(value) }, "provider classification and redaction");
  let deep = "leaf"; for (let i = 0; i < 23; i++) deep = { nested: deep };
  for (const value of [{ params: { error: { code: 401, message: "status 401 PRIVATE_RESPONSE", additionalDetails: "PRIVATE_RESPONSE" } }, result: { text: "public" } }, { type: "error", message: "unrecognized PRIVATE_RESPONSE", data: "private" }, deep])
    same(await native({ op: "safePayload", value }), safeEndpointDiagnosticPayload(value), "endpoint-safe diagnostic payload");
}
