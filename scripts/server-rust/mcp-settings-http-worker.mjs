// Run unchanged discovery, endpoint cryptography and WorkerConnection. Only the
// discovery filesystem/home and loopback inventory belong to this test.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  computeBlindLookupTag,
  deriveLookupKey,
  encryptProtectedSecret,
  decryptProtectedSecret,
  clearSensitiveBytes,
} from "../../packages/crypto/dist/index.js";
import { mcpServerConfigurationSchema } from "../../packages/protocol/dist/index.js";
import { discoverMcpConfigurations } from "../../cantrip_worker/src/mcp/discovery.ts";
import { openMcpServers } from "../../cantrip_worker/src/protected-secrets.ts";
import { settingsWorker as worker } from "./native-settings-http-fixture.mjs";

export const mcpSettingsMarker = "private-mcp-endpoint-proof";
export const mcpSettingsId = (n) =>
  `88888888-8888-4888-8888-${String(n).padStart(12, "0")}`;
export const mcpSettingsKey = (n) => Buffer.alloc(32, n).toString("base64url");
const stable = (v) =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x).sort(([a], [b]) => a.localeCompare(b)),
        )
      : x,
  );

export async function mcpSettingsHttpWorker(result, current, root) {
  const homeDirectory = path.join(root, "owned-mcp-home"),
    projectRoot = path.join(root, "owned-mcp-project"),
    envelopes = new Map(),
    tags = new Map(),
    expected = new Map();
  let mode = "normal",
    held;
  await mkdir(path.join(homeDirectory, ".codex"), { recursive: true });
  await mkdir(path.join(projectRoot, ".codex"), { recursive: true });
  await writeFile(
    path.join(homeDirectory, ".codex/config.toml"),
    `[mcp_servers.user_stdio]\ncommand = "${mcpSettingsMarker}"\nargs = ["--private"]\nenv = { PRIVATE = "${mcpSettingsMarker}" }\n`,
  );
  await writeFile(
    path.join(homeDirectory, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        user_http: {
          type: "http",
          url: "http://127.0.0.1:43210/mcp",
          headers: { Authorization: mcpSettingsMarker },
        },
        invalid: { type: "unsupported" },
      },
    }),
  );
  await writeFile(
    path.join(projectRoot, ".codex/config.toml"),
    `[mcp_servers.project_stdio]\ncommand = "${mcpSettingsMarker}"\nargs = ["--project"]\n`,
  );
  await writeFile(
    path.join(projectRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        project_http: {
          type: "http",
          url: "http://127.0.0.1:43211/mcp",
          headers: { Private: mcpSettingsMarker },
        },
      },
    }),
  );
  const canonical = (v) => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object")
      return (
        envelopes.get(stable(v)) ??
        Object.fromEntries(Object.entries(v).map(([k, x]) => [k, canonical(x)]))
      );
    return tags.get(v) ?? v;
  };
  function remember(server, configuration, alias) {
    expected.set(server.id, configuration);
    envelopes.set(
      stable(server.protectedConfiguration),
      `<authenticated MCP ciphertext:${alias}>`,
    );
    if (!tags.has(server.nameBlindIndex))
      tags.set(server.nameBlindIndex, `<authenticated MCP name:${tags.size}>`);
  }
  async function open(server) {
    const h = current(),
      component = h.encryption.componentKey("mcp-secret");
    try {
      const configuration = await decryptProtectedSecret({
        ownerId: h.owner,
        component: "mcp-secret",
        table: "mcp_servers",
        rowId: server.id,
        field: "protected_configuration",
        keyRevision: server.protectedConfiguration.keyRevision,
        componentKey: component.key,
        encrypted: server.protectedConfiguration,
        contentSchema: mcpServerConfigurationSchema,
        maximumBytes: 1024 * 1024,
      });
      if (expected.has(server.id))
        assert.deepEqual(configuration, expected.get(server.id));
      result.cryptoProofs++;
      return configuration;
    } finally {
      clearSensitiveBytes(component.key);
    }
  }
  return {
    projectRoot,
    canonical,
    open,
    setMode: (v) => {
      mode = v;
    },
    hold() {
      mode = "hold";
      held = { requests: 0, completed: 0, releases: [] };
      return held;
    },
    release() {
      held?.releases.forEach((r) => r());
      mode = "normal";
    },
    async body(
      n,
      {
        name = `endpoint-${n}`,
        enabled = true,
        audience,
        workerId = null,
        ...patch
      } = {},
    ) {
      const h = current(),
        id = mcpSettingsId(n),
        configuration = mcpServerConfigurationSchema.parse({
          name,
          enabled,
          transport: "stdio",
          command: mcpSettingsMarker,
          args: [mcpSettingsMarker],
          environment: { PRIVATE: mcpSettingsMarker },
          ...patch,
        }),
        component = h.encryption.componentKey("mcp-secret"),
        lookup = deriveLookupKey({
          componentKey: component.key,
          ownerId: h.owner,
          component: "mcp-secret",
          table: "mcp_servers",
          field: "name",
          keyRevision: component.keyRevision,
        });
      try {
        const server = {
          id,
          enabled,
          workerId,
          ...(audience === undefined ? {} : { audience }),
          nameBlindIndex: computeBlindLookupTag(
            lookup,
            configuration.name.toLowerCase(),
          ),
          protectedConfiguration: await encryptProtectedSecret({
            ownerId: h.owner,
            component: "mcp-secret",
            table: "mcp_servers",
            rowId: id,
            field: "protected_configuration",
            keyRevision: component.keyRevision,
            componentKey: component.key,
            content: configuration,
            contentSchema: mcpServerConfigurationSchema,
            maximumBytes: 1024 * 1024,
          }),
        };
        remember(server, configuration, `${n}:${enabled}`);
        return server;
      } finally {
        clearSensitiveBytes(lookup);
        clearSensitiveBytes(component.key);
      }
    },
    async openRuntime(servers) {
      const configurations = await openMcpServers({
        servers,
        service: current().encryption,
      });
      for (const configuration of configurations)
        assert.equal(configuration.command, mcpSettingsMarker);
      return configurations;
    },
    async onCommand(command, _emit, { encryption }) {
      if (command.type !== "mcp.configurations.discover") return;
      assert.deepEqual(Object.keys(command).sort(), ["projectRoot", "type"]);
      assert.ok(
        command.projectRoot === null || command.projectRoot === projectRoot,
      );
      const requestNumber = result.commands.length;
      result.commands.push({
        type: command.type,
        projectRoot:
          command.projectRoot === null ? null : "<owned MCP project>",
      });
      const requestMode = mode;
      if (requestMode === "hold") {
        held.requests++;
        await new Promise((resolve) => held.releases.push(resolve));
      }
      if (requestMode === "failed")
        throw new Error("Controlled MCP discovery failed.");
      const reply = await discoverMcpConfigurations({
        workerId: worker,
        projectRoot: command.projectRoot,
        service: encryption,
        homeDirectory,
        runningHttpDiscovery: async () => [],
      });
      assert.equal(reply.candidates.length, command.projectRoot ? 4 : 2);
      assert.equal(reply.issues.length, 1);
      for (const candidate of reply.candidates) {
        const configuration = await open(candidate.configuration);
        assert.ok(
          ["user_stdio", "user_http", "project_stdio", "project_http"].includes(
            configuration.name,
          ),
        );
        assert.equal(candidate.configuration.workerId, worker);
        const alias = `discovered:${requestNumber}:${reply.candidates.indexOf(candidate)}`;
        current().fixture.ids.set(candidate.configuration.id, `<${alias}>`);
        remember(candidate.configuration, configuration, alias);
      }
      if (requestMode === "invalid") return { workerId: worker };
      if (requestMode === "unknown") reply.extra = true;
      if (requestMode === "wrong-worker") reply.workerId = "unrelated-worker";
      if (requestMode === "unbound")
        reply.candidates[0].configuration.workerId = null;
      if (requestMode === "overflow")
        reply.candidates = Array(201).fill(reply.candidates[0]);
      if (requestMode === "hold") held.completed++;
      return reply;
    },
  };
}
