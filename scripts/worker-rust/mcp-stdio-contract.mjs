// Development export from the pinned Node MCP SDK and original tool validators.
// The native executable embeds these generated files and needs no JavaScript.
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  CANTRIP_MCP_OPERATIONS,
  CANTRIP_MCP_TOOL_NAMES,
  cantripMcpBindingSchema,
  workerCantripMcpServerCapabilitiesSchema,
} from "../../packages/protocol/dist/index.js";
import { buildContractManifest } from "../server-rust/contracts.mjs";
import { createCantripMcpServer } from "../../cantrip_worker/src/mcp/server.ts";
import { cantripMcpToolHelp } from "../../cantrip_worker/src/mcp/tool-catalog.ts";

const requireWorker = createRequire(
  new URL("../../cantrip_worker/package.json", import.meta.url),
);
const { z } = requireWorker("zod");
const { Client } = await import(
  requireWorker.resolve("@modelcontextprotocol/sdk/client/index.js")
);
const { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } = await import(
  requireWorker.resolve("@modelcontextprotocol/sdk/types.js")
);
const { InMemoryTransport } = await import(
  requireWorker.resolve("@modelcontextprotocol/sdk/inMemory.js")
);

export async function sourceCatalog(profile, inspect) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createCantripMcpServer(
    async () => {
      throw new Error("Tool catalog export must not invoke the broker.");
    },
    profile,
    undefined,
    inspect,
  );
  const client = new Client({ name: "cantrip-mcp-export", version: "1" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return {
      serverInfo: client.getServerVersion(),
      capabilities: client.getServerCapabilities(),
      instructions: client.getInstructions(),
      tools: (await client.listTools()).tools,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

async function generate() {
  const schemas = {};
  const profiles = {
    ide: await sourceCatalog("ide", (name, config) => {
      assert.ok(config.inputSchema && config.outputSchema, name);
      // This one refinement refers to the advertised profile. Runtime checks
      // it against the same profile-specific tool list after shape validation.
      schemas[`mcpStdioInput/${name}`] =
        name === "tool_help"
          ? z.strictObject(config.inputSchema.shape)
          : config.inputSchema;
      schemas[`mcpStdioOutput/${name}`] = config.outputSchema;
    }),
    "standalone-web": await sourceCatalog("standalone-web", (name, config) => {
      if (name === "tool_help")
        schemas.mcpStdioStandaloneToolHelpInput = z.strictObject(
          config.inputSchema.shape,
        );
    }),
  };
  for (const profile of Object.values(profiles))
    delete profile.serverInfo.version;
  const operations = Object.fromEntries(
    CANTRIP_MCP_TOOL_NAMES.map((name, index) => [
      name,
      CANTRIP_MCP_OPERATIONS[index],
    ]),
  );
  assert.deepEqual(
    profiles.ide.tools.map(({ name }) => name).sort(),
    Object.keys(operations).sort(),
  );
  const help = Object.fromEntries(
    CANTRIP_MCP_TOOL_NAMES.map((name) => [name, cantripMcpToolHelp(name)]),
  );
  const input = (name) => schemas[`mcpStdioInput/${name}`];
  const output = (name) => schemas[`mcpStdioOutput/${name}`];
  const mcpHostSessionClaims = z.discriminatedUnion(
    "contextKind",
    cantripMcpBindingSchema.options.map((variant) =>
      variant.omit({
        bindingId: true,
        executionLaneId: true,
        issuedAt: true,
        expiresAt: true,
      }),
    ),
  );
  const capabilities = workerCantripMcpServerCapabilitiesSchema.shape;
  const refinements = new Map([
    [capabilities.bindingProtocolVersions, "stdio-mcp-capability-unique"],
    [capabilities.operations, "stdio-mcp-capability-unique"],
    [output("policy_list").shape.data.shape.policies, "stdio-mcp-policy-keys"],
    [input("web_search"), "stdio-mcp-domain-overlap"],
    [input("web_read"), "stdio-mcp-web-read-source"],
    [input("web_session_open"), "stdio-mcp-browser-session"],
    [input("web_session_pointer"), "stdio-mcp-pointer"],
    [input("run_configuration_secret_set").shape.value, "stdio-mcp-secret-nul"],
    [input("browser_navigate").shape.url, "stdio-mcp-browser-url"],
    [output("browser_navigate").shape.data.shape.url, "stdio-mcp-browser-url"],
    ...[
      "client_notify",
      "client_focus_project",
      "client_focus_surface",
      "client_show_interaction",
    ].map((name) => [output(name), "stdio-mcp-client-mutation"]),
  ]);
  return [
    [
      new URL(
        "../../crates/cantrip-protocol/contracts/mcp-host.json",
        import.meta.url,
      ),
      buildContractManifest(
        [
          "cantripMcpConnectionDocumentSchema",
          "cantripMcpBrokerOperationRequestSchema",
          "cantripAgentOperationResultSchema",
          ...Object.keys(schemas),
          "cantripMcpBindingSchema",
          "workerCantripMcpServerCapabilitiesSchema",
          "cantripMcpToolHelpInputSchema",
          "cantripMcpContextGetInputSchema",
          "mcpHostSessionClaims",
        ],
        { schemas: { ...schemas, mcpHostSessionClaims }, refinements },
      ),
    ],
    [
      new URL(
        "../../cantrip_worker_rs/src/mcp/catalog.json.gz",
        import.meta.url,
      ),
      {
        protocol: {
          latest: LATEST_PROTOCOL_VERSION,
          supported: SUPPORTED_PROTOCOL_VERSIONS,
        },
        profiles,
        operations,
        help,
      },
    ],
  ];
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  for (const [destination, value] of await generate()) {
    const compressed = destination.pathname.endsWith(".gz");
    const formatted = JSON.stringify(value, null, compressed ? 0 : 2) + "\n";
    if (process.argv.includes("--check")) {
      const actual = await readFile(destination);
      assert.equal(
        (compressed ? gunzipSync(actual) : actual).toString(),
        formatted,
        destination.pathname,
      );
    } else {
      await writeFile(
        destination,
        compressed ? gzipSync(formatted, { level: 9 }) : formatted,
      );
    }
  }
}
