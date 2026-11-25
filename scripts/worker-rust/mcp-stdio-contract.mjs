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
  councilCreateToolInputSchema,
  councilCreateToolOutputSchema,
  councilListToolInputSchema,
  councilListToolOutputSchema,
  councilMemoryReadToolInputSchema,
  councilMemoryReadToolOutputSchema,
  councilMemoryWriteToolInputSchema,
  councilMemoryWriteToolOutputSchema,
  workerCantripMcpServerCapabilitiesSchema,
} from "../../packages/protocol/dist/index.js";
import { buildContractManifest } from "../server-rust/contracts.mjs";
import { createCantripMcpServer } from "../../tests/reference-node-worker/src/mcp/server.ts";
import { createCuaMcpServer } from "../../tests/reference-node-worker/src/mcp/cua-server.ts";
import {
  cuaMcpBrokerRequestSchema,
  cuaMcpResetArgumentsSchema,
  cuaMcpScriptArgumentsSchema,
  cuaMcpScriptSchema,
} from "../../tests/reference-node-worker/src/mcp/cua-contract.ts";
import { cantripMcpToolHelp } from "../../tests/reference-node-worker/src/mcp/tool-catalog.ts";

const requireWorker = createRequire(
  new URL("../../tests/reference-node-worker/package.json", import.meta.url),
);
const { z } = requireWorker("zod");
const { Client } = await import(
  requireWorker.resolve("@modelcontextprotocol/sdk/client/index.js")
);
const {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  CallToolResultSchema,
  TextContentSchema,
  ImageContentSchema,
} = await import(requireWorker.resolve("@modelcontextprotocol/sdk/types.js"));
const { InMemoryTransport } = await import(
  requireWorker.resolve("@modelcontextprotocol/sdk/inMemory.js")
);

export async function sourceCatalog(profile, inspect) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const unexpected = async () => {
    throw new Error("Tool catalog export must not invoke the broker.");
  };
  const server =
    profile === "cua" || profile === "cua-linux"
      ? createCuaMcpServer(
          unexpected,
          profile === "cua-linux" ? "linux-desktop" : undefined,
        )
      : createCantripMcpServer(unexpected, profile, undefined, inspect);
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
  const cuaSchemas = {
    cuaMcpBrokerRequestSchema,
    cuaMcpResetArgumentsSchema,
    cuaMcpScriptArgumentsSchema,
    cuaMcpResultSchema: CallToolResultSchema.extend({
      // Rust decodes and checks the image's canonical base64 and byte limits.
      content: z
        .array(
          z.union([
            TextContentSchema,
            ImageContentSchema.extend({ data: z.string() }),
          ]),
        )
        .default([]),
    }),
  };
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
    cua: await sourceCatalog("cua"),
    "cua-linux": await sourceCatalog("cua-linux"),
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
  const council = [
    [
      "council_list",
      "council.list",
      "List the Council agents in your Cantrip account.",
      councilListToolInputSchema,
      councilListToolOutputSchema,
    ],
    [
      "council_create",
      "council.create",
      "Create a fresh Council agent with the specified title and role.",
      councilCreateToolInputSchema,
      councilCreateToolOutputSchema,
    ],
    [
      "council_memory_read",
      "council.memory.read",
      "Read your current Council fast memory and its revision.",
      councilMemoryReadToolInputSchema,
      councilMemoryReadToolOutputSchema,
    ],
    [
      "council_memory_write",
      "council.memory.write",
      "Replace your fast memory using its current revision. Include all notes you want to keep. Supply empty text to clear it. Maximum 8 KiB.",
      councilMemoryWriteToolInputSchema,
      councilMemoryWriteToolOutputSchema,
    ],
  ];
  profiles.council = {
    ...profiles["standalone-web"],
    instructions:
      "Use council_list to find agents on this Cantrip account and council_create to create an agent from a requested role. Read and update your fast memory with council_memory_read and council_memory_write. Use web_search and web_read for research. A stale binding requires a fresh Council turn.",
    tools: [
      ...profiles["standalone-web"].tools,
      ...council.map(([name, operation, description, input, output]) => {
        schemas[`mcpStdioInput/${name}`] = input;
        schemas[`mcpStdioOutput/${name}`] = output;
        operations[name] = operation;
        help[name] = { summary: description };
        return {
          name,
          description,
          inputSchema: z.toJSONSchema(input),
          outputSchema: z.toJSONSchema(output),
        };
      }),
    ],
  };
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
    [cuaMcpScriptSchema, "stdio-mcp-cua-script-size"],
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
          ...Object.keys(cuaSchemas),
        ],
        {
          schemas: { ...schemas, mcpHostSessionClaims, ...cuaSchemas },
          refinements,
        },
      ),
    ],
    [
      new URL("../../cantrip_worker/src/mcp/catalog.json.gz", import.meta.url),
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
