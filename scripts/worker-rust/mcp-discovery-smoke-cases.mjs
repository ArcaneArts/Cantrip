import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import * as c from "../../packages/crypto/dist/index.js";
import * as p from "../../packages/protocol/dist/index.js";
import { discoveryWireFixtures } from "../server-rust/discovery-wire-fixtures.mjs";
import { projectLabel } from "../server-rust/security-fixtures.mjs";

const PRIVATE = "mcp-fixture-private-value";

export async function startMcpDiscoveryFixture(root, home) {
  const servers = [];
  const handshakes = [];
  async function start(kind, pathname, redirectTarget) {
    const server = createServer(async (request, response) => {
      const route = request.url;
      handshakes.push({
        kind,
        route,
        method: request.method,
        session: request.headers["mcp-session-id"],
      });
      if (route !== pathname) return response.writeHead(404).end();
      if (kind === "redirect") {
        return response
          .writeHead(307, {
            Location: "http://127.0.0.1:" + redirectTarget + "/must-not-follow",
          })
          .end();
      }
      if (request.method === "DELETE") return response.writeHead(204).end();
      if (request.method !== "POST") return response.writeHead(405).end();
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks));
      assert.equal(input.method, "initialize");
      assert.equal(input.params.clientInfo.name, "cantrip-mcp-discovery");
      const message = JSON.stringify({
        jsonrpc: "2.0",
        id: input.id,
        result: {
          protocolVersion: input.params.protocolVersion,
          serverInfo: {
            name: kind === "json" ? "Álpha Fixture MCP" : "Zulu Fixture MCP",
          },
          capabilities: {},
        },
      });
      response
        .writeHead(200, {
          "Content-Type":
            kind === "json" ? "application/json" : "text/event-stream",
          "MCP-Session-Id": "owned-" + kind,
        })
        .end(
          kind === "json"
            ? message
            : ": keepalive\n\ndata: malformed\n\ndata: " + message + "\n\n",
        );
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return server.address().port;
  }
  const close = () =>
    Promise.all(
      servers.map(
        (server) =>
          new Promise((resolve) => {
            server.close(resolve);
            server.closeAllConnections();
          }),
      ),
    );
  try {
    const jsonPort = await start("json", "/mcp");
    const ssePort = await start("sse", "/");
    const redirectPort = await start("redirect", "/mcp", jsonPort);

    const bin = path.join(root, "mcp-listener-tools");
    await mkdir(bin);
    // Limit this fixture to its own local listeners. The worker runs the normal
    // listener parser and HTTP handshakes against these actual endpoints.
    await writeFile(
      path.join(bin, "lsof"),
      "#!/bin/sh\nprintf '%s\\n' p123 cfixture " +
        [jsonPort, ssePort, redirectPort]
          .map((port) => "n127.0.0.1:" + port)
          .join(" ") +
        "\n",
      { mode: 0o700 },
    );
    await mkdir(path.join(home, ".codex"));
    await writeFile(
      path.join(home, ".codex", "config.toml"),
      [
        "[mcp_servers.zeta_stdio]",
        'command = "fixture-command"',
        'args = ["--example"]',
        'env = { PRIVATE = "' + PRIVATE + '" }',
        "[mcp_servers.alpha_http]",
        'url = "https://uncontacted-test-endpoint.invalid/mcp"',
        'bearer_token_env_var = "CONFIGURED_TOKEN"',
        'env_http_headers = { X_Auth = "AUTH_ENV" }',
        "[mcp_servers.CANTRIP_CUA]",
        'command = "ignored-managed-command"',
      ].join("\n"),
    );
    return { bin, jsonPort, ssePort, handshakes, close, home };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function verifyMcpDiscovery({
  call,
  eventually,
  fixture,
  data,
  ownerId,
  workerId,
  keyRevision,
  labelKey,
  componentKey,
}) {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const { nameProtection } =
    discoveryWireFixtures(projectLabel)
      .encryptedProjectWorkspaceCreateSchema[0];
  await call("POST", "/api/workspaces", 201, {
    id: workspaceId,
    nameProtection,
    storage: { kind: "managed" },
  });
  const projectUrl = "/api/projects/" + projectId;
  await call("POST", "/api/projects/from-folder", 202, {
    id: projectId,
    workerId,
    workspaceId,
    nameProtection: await c.encryptPrivateDisplayLabel({
      ownerId,
      keyRevision,
      recordKind: "project",
      rowId: projectId,
      componentKey: labelKey,
      label: "MCP import fixture",
    }),
  });
  await eventually(
    () => call("GET", projectUrl + "/folder-setup", 200),
    (row) => assert.equal(row.state, "succeeded", JSON.stringify(row)),
  );
  const checkout = path.join(
    data,
    "workspaces",
    workspaceId,
    "folders",
    projectId,
  );
  await mkdir(path.join(checkout, ".codex"));
  await writeFile(
    path.join(checkout, ".codex", "config.toml"),
    '[mcp_servers.checkout_stdio]\ncommand = "checkout-command"\n',
  );
  await writeFile(
    path.join(checkout, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        checkout_json: {
          type: "streamable-http",
          url: "https://checkout-fixture.invalid/mcp",
        },
      },
    }),
  );
  await writeFile(
    path.join(fixture.home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        claude_http: {
          url: "https://claude-fixture.invalid/mcp",
          headers: {
            Authorization: "Bearer ${CANTRIP_MCP_FIXTURE_TOKEN}",
            X_Fallback: "${UNSET_FIXTURE_FIELD:-default}",
          },
        },
        unsupported: {
          type: "sse",
          url: "https://ignored-fixture.invalid/sse",
        },
        invalid: { command: "${MISSING_MCP_FIXTURE_VARIABLE}" },
      },
      projects: {
        [checkout]: {
          mcpServers: {
            project_from_user: { command: "fixture", args: ["workspace"] },
          },
        },
        [checkout + "-other"]: {
          mcpServers: { unrelated_project: { command: "ignored" } },
        },
      },
    }),
  );

  const lookup = c.deriveLookupKey({
    componentKey,
    ownerId,
    component: "mcp-secret",
    table: "mcp_servers",
    field: "name",
    keyRevision,
  });
  async function scan(prefix) {
    const result = p.mcpServerDiscoveryResultSchema.parse(
      await call("GET", prefix + "/mcp-discovery/" + workerId, 200),
    );
    assert.equal(result.workerId, workerId);
    assert.equal(JSON.stringify(result).includes(PRIVATE), false);
    assert.equal(JSON.stringify(result).includes("https://"), false);
    assert.deepEqual(
      result.issues.map(({ code, source, sourceScope }) => [
        code,
        source,
        sourceScope,
      ]),
      [
        ["unsupported-transport", "claude", "user"],
        ["invalid-config", "claude", "user"],
      ],
    );
    return Promise.all(
      result.candidates.map(async ({ source, sourceScope, configuration }) => {
        assert.equal(configuration.workerId, workerId);
        const clear = await c.decryptProtectedSecret({
          ownerId,
          component: "mcp-secret",
          table: "mcp_servers",
          rowId: configuration.id,
          field: "protected_configuration",
          keyRevision,
          componentKey,
          encrypted: configuration.protectedConfiguration,
          contentSchema: p.mcpServerConfigurationSchema,
        });
        assert.equal(
          configuration.nameBlindIndex,
          c.computeBlindLookupTag(lookup, clear.name.toLowerCase()),
        );
        return { source, sourceScope, clear, configuration };
      }),
    );
  }
  try {
    const global = await scan("/api/settings");
    const project = await scan(projectUrl);
    const name = ({ clear }) => clear.name;
    const localNames = [
      "Alpha-Fixture-MCP-" + fixture.jsonPort,
      "Zulu-Fixture-MCP-" + fixture.ssePort,
    ];
    const userNames = ["zeta_stdio", "alpha_http", "claude_http"];
    assert.deepEqual(global.map(name), [...userNames, ...localNames]);
    assert.deepEqual(project.map(name), [
      ...userNames,
      "checkout_stdio",
      "checkout_json",
      "project_from_user",
      ...localNames,
    ]);
    assert.deepEqual(
      project
        .slice(3, 6)
        .map(({ source, sourceScope }) => [source, sourceScope]),
      [
        ["codex", "project"],
        ["claude", "project"],
        ["claude", "project"],
      ],
    );
    assert.deepEqual(global[0].clear.environment, { PRIVATE });
    assert.deepEqual(global[1].clear.environmentHeaders, {
      X_Auth: "AUTH_ENV",
    });
    assert.deepEqual(global[2].clear.headers, {
      Authorization: "Bearer " + PRIVATE,
      X_Fallback: "default",
    });
    assert.equal(
      global[3].clear.url,
      "http://127.0.0.1:" + fixture.jsonPort + "/mcp",
    );
    assert.equal(
      global[4].clear.url,
      "http://127.0.0.1:" + fixture.ssePort + "/",
    );
    for (const kind of ["json", "sse"]) {
      assert.equal(
        fixture.handshakes.filter(
          ({ method, session }) =>
            method === "DELETE" && session === "owned-" + kind,
        ).length,
        2,
      );
    }
    assert.equal(
      fixture.handshakes.some(({ route }) => route === "/must-not-follow"),
      false,
    );
    const selected = project.find(
      ({ clear }) => clear.name === "checkout_json",
    );
    await call(
      "POST",
      projectUrl + "/mcp-servers",
      201,
      selected.configuration,
    );
  } finally {
    lookup.fill(0);
  }
  console.log(JSON.stringify({ suite: "native-mcp-discovery", passed: true }));
}
