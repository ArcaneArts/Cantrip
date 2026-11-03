// A real, disposable MCP stdio peer for native Codex acceptance. No worker or
// server dispatch is intercepted: Codex must spawn and initialize this process.
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const label = process.argv[2],
  trace = process.argv[3];
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (trace)
    appendFileSync(
      trace,
      JSON.stringify({ label, method: request.method }) + "\n",
    );
  if (request.id === undefined) continue;
  let result;
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { resources: {} },
        serverInfo: { name: "cantrip-mcp-settings-" + label, version: "1.0.0" },
      };
      break;
    case "resources/list":
      result = {
        resources: [
          {
            uri: "cantrip-proof://settings",
            name: "settings-proof",
            mimeType: "text/plain",
          },
        ],
      };
      break;
    case "resources/read":
      result = {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "text/plain",
            text: "private-native-mcp-proof:" + label,
          },
        ],
      };
      break;
    case "resources/templates/list":
      result = { resourceTemplates: [] };
      break;
    case "tools/list":
      result = { tools: [] };
      break;
    case "prompts/list":
      result = { prompts: [] };
      break;
    case "ping":
      result = {};
      break;
    default:
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: "Method not found" },
        }) + "\n",
      );
      continue;
  }
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n",
  );
}
