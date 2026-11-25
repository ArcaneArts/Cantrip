import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const disposableCredential = "council-fixture-mcp-secret";
export const discoveredValue = "release canary is healthy";
export const setupName = "council_setup_fixture";

export async function prepareCouncilMcpFixture(root) {
  const fixture = path.join(root, "council-setup-mcp.mjs");
  await writeFile(
    fixture,
    `import { createInterface } from "node:readline";
const tools = [{
  name: "release_status",
  description: "Return the current release status",
  inputSchema: { type: "object" },
}];
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  if (request.method === "initialize") {
    if (process.env.COUNCIL_SETUP_CREDENTIAL !== ${JSON.stringify(disposableCredential)}) {
      process.exit(1);
    }
    result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "council-setup-fixture", version: "1" },
    };
  } else if (request.method === "tools/list") {
    result = { tools };
  } else if (request.method === "tools/call" && request.params.name === "release_status") {
    result = { content: [{ type: "text", text: ${JSON.stringify(discoveredValue)} }] };
  }
  const failure = { code: -32601, message: "Unknown fixture method" };
  console.log(JSON.stringify({
    jsonrpc: "2.0",
    id: request.id,
    ...(result ? { result } : { error: failure }),
  }));
}
`,
  );
  const configuration = {
    name: setupName,
    transport: "stdio",
    command: process.execPath,
    args: [fixture],
    environment: { COUNCIL_SETUP_CREDENTIAL: disposableCredential },
  };
  const sdk = createRequire(
    new URL("../../tests/reference-node-worker/package.json", import.meta.url),
  );
  const sdkModule = (name) =>
    JSON.stringify(
      pathToFileURL(sdk.resolve(`@modelcontextprotocol/sdk/client/${name}`))
        .href,
    );
  const client = [
    `import { Client } from ${sdkModule("index.js")};`,
    `import { StdioClientTransport } from ${sdkModule("stdio.js")};`,
    'const client = new Client({ name: "council-script", version: "1" });',
    "try {",
    `  await client.connect(new StdioClientTransport(${JSON.stringify({
      command: process.execPath,
      args: [fixture],
      env: { COUNCIL_SETUP_CREDENTIAL: disposableCredential },
    })}));`,
    '  const result = await client.callTool({ name: "release_status" });',
    '  if (result.isError) throw new Error("MCP release status failed");',
    "  console.log(result.content[0].text);",
    "} finally {",
    "  await client.close();",
    "}",
  ].join("\n");
  const script = {
    cmd: [
      "set -e",
      'fixture_script=$(mktemp "$PWD/council-mcp-client.XXXXXX")',
      "cat >\"$fixture_script\" <<'COUNCIL_MCP_SCRIPT'",
      client,
      "COUNCIL_MCP_SCRIPT",
      `'${process.execPath.replaceAll("'", "'\\''")}' --input-type=module < "$fixture_script"`,
    ].join("\n"),
    login: false,
    max_output_tokens: 1000,
  };
  return { configuration, scriptArguments: script };
}
