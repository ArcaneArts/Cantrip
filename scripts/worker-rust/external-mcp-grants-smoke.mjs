import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { fixtureEnvironment, startServer } from "../server-rust/process.mjs";
import { productionClient } from "../server-rust/production-server-process.mjs";

const { values } = parseArgs({
  options: {
    server: { type: "string" },
    worker: { type: "string" },
    codex: { type: "string" },
    browser: { type: "boolean" },
  },
});
assert.ok(values.server, "Pass the --server binary.");
const requireSdk = createRequire(
  new URL("../../tests/reference-node-worker/package.json", import.meta.url),
);
const { Client } = await import(
  requireSdk.resolve("@modelcontextprotocol/sdk/client/index.js")
);
const { StdioClientTransport } = await import(
  requireSdk.resolve("@modelcontextprotocol/sdk/client/stdio.js")
);
const integrations = "/api/account/external-mcp-integrations";
const capabilities = "/api/external-mcp/hosted/capabilities";
const discovery = "/api/external-mcp/hosted/discovery";
const readTools = [
  "workspace_list",
  "project_list",
  "chat_list",
  "agent_list",
  "agent_read",
  "chat_read",
  "chat_wait",
];
const password = "Isolated MCP fixture password 42";
const directory = await mkdtemp(
  path.join(tmpdir(), "cantrip-external-mcp-grants-"),
);
const env = {
  ...fixtureEnvironment(directory),
  CANTRIP_AUTH_MODE: "accounts",
  CANTRIP_APP_ORIGINS: "http://127.0.0.1:5173",
  CANTRIP_LICENSE_WHITELIST_ENABLED: "false",
  CANTRIP_PUBLIC_REGISTRATION: "true",
};
delete env.CANTRIP_WORKER_TOKEN;

let server, app;
try {
  if (values.browser) {
    assert.ok(
      values.worker && values.codex,
      "--browser requires --worker and --codex.",
    );
    const { startAppClient } =
      await import("./external-mcp-orchestration-cases.mjs");
    app = await startAppClient(directory);
    env.CANTRIP_APP_ORIGINS += "," + app.origin;
  }
  server = await startServer(
    path.resolve(values.server),
    ["--port", "0", "--shutdown-on-stdin-close"],
    {
      cwd: directory,
      env,
    },
  );
  const owner = productionClient(server);
  const unrelated = productionClient(server);
  let ownerId;
  for (const [ordinal, client] of [owner, unrelated].entries()) {
    const registration = await client.visit(
      "register",
      "POST",
      "/api/auth/register",
      {
        status: 201,
        json: {
          displayName: `External MCP fixture ${ordinal}`,
          email: `external-mcp-${ordinal}@example.invalid`,
          password,
        },
      },
    );
    if (client === owner) ownerId = registration.currentUser.id;
  }

  async function createProjects(client, count) {
    const workerId = randomUUID();
    const enrollment = await client.visit(
      "enrollment code",
      "POST",
      "/api/workers/enrollment-codes",
      {
        status: 201,
        json: { label: "Offline integration fixture" },
      },
    );
    await client.visit(
      "worker enrollment",
      "POST",
      "/api/internal/workers/enroll",
      {
        status: 201,
        json: {
          code: enrollment.code,
          heartbeat: {
            workerId,
            name: "Offline integration fixture",
            platform: process.platform,
            architecture: process.arch,
            startedAt: new Date().toISOString(),
            codexVersion: null,
            managedFolders: { create: true, remove: true },
          },
        },
      },
    );
    const projects = [];
    for (let index = 0; index < count; index++) {
      const id = randomUUID();
      await client.visit(
        "project fixture",
        "POST",
        "/api/projects/from-folder",
        {
          status: 202,
          json: {
            id,
            workerId,
            nameProtection: {
              classification: { recordKind: "project" },
              protectedLabel: {
                formatVersion: 1,
                keyRevision: 1,
                envelope: {
                  version: 1,
                  algorithm: "AES-256-GCM",
                  keyRevision: 1,
                  nonce: Buffer.alloc(12).toString("base64url"),
                  ciphertext: Buffer.alloc(32).toString("base64url"),
                },
              },
            },
          },
        },
      );
      projects.push(id);
    }
    return projects;
  }

  const [allowed, outsideScope] = await createProjects(owner, 2);
  const [outsideAccount] = await createProjects(unrelated, 1);
  const grantInput = {
    label: "Integration fixture",
    permissions: {
      projects: { kind: "selected", projectIds: [allowed] },
      scopes: ["projects-read", "chats-read"],
    },
    expiresInSeconds: 60,
  };
  await owner.visit("missing selected project", "POST", integrations, {
    status: 404,
    json: {
      ...grantInput,
      permissions: {
        ...grantInput.permissions,
        projects: { kind: "selected", projectIds: [outsideAccount] },
      },
    },
  });
  const created = await owner.visit("create", "POST", integrations, {
    status: 201,
    json: grantInput,
  });
  assert.match(created.credential, /^ctmcp_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.integration.generation, 1);
  const target = `${integrations}/${created.integration.id}`;
  const listed = await owner.visit("owner list", "GET", integrations);
  assert.equal(listed[0].id, created.integration.id);
  assert.equal(Object.hasOwn(listed[0], "credential"), false);
  assert.deepEqual(
    await unrelated.visit("other account list", "GET", integrations),
    [],
  );
  await unrelated.visit("other account rotation", "POST", target + "/rotate", {
    status: 404,
    json: { expiresInSeconds: 60 },
  });
  await unrelated.visit("other account revocation", "DELETE", target, {
    status: 404,
  });

  const request = async (route, credential, body, status) => {
    const response = await fetch(server.origin + route, {
      method: body ? "POST" : "GET",
      headers: {
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(response.status, status, route);
    return response.json();
  };
  const projects = { tool: "project_list", arguments: {} };
  await request(capabilities, null, null, 401);
  await request(discovery, null, projects, 401);
  assert.deepEqual(
    (await request(capabilities, created.credential, null, 200)).tools,
    readTools,
  );
  await request(
    discovery,
    created.credential,
    { tool: "worker_list", arguments: {} },
    403,
  );
  await request(
    discovery,
    created.credential,
    { tool: "chat_list", arguments: { projectId: outsideScope } },
    404,
  );
  await request(
    discovery,
    created.credential,
    { tool: "chat_list", arguments: { projectId: outsideAccount } },
    404,
  );
  const credentialFile = path.join(directory, "integration.credential");
  await writeFile(credentialFile, created.credential + "\n", { mode: 0o600 });
  const connectMcp = async (file, suppressOperation) => {
    const client = new Client({
      name: "hosted-external-mcp-smoke",
      version: "1",
    });
    try {
      const transport = new StdioClientTransport({
        command: path.resolve(values.worker),
        args: [
          "external-mcp",
          "--server",
          server.origin,
          "--credential-file",
          file,
        ],
        cwd: directory,
      });
      await client.connect(transport);
      if (suppressOperation) {
        const forward = transport.onmessage;
        transport.onmessage = (message) => {
          if (
            message.result?.structuredContent?.operationId !== suppressOperation
          )
            forward(message);
        };
      }
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  };
  const mcp = values.worker ? await connectMcp(credentialFile) : undefined;
  try {
    if (mcp) {
      assert.deepEqual(
        (await mcp.listTools()).tools.map(({ name }) => name),
        readTools,
      );
      const result = await mcp.callTool({
        name: "project_list",
        arguments: {},
      });
      assert.equal(result.isError, undefined);
      assert.deepEqual(
        result.structuredContent.entries.map(({ id }) => id),
        [allowed],
      );
    }

    const rotated = await owner.visit("rotate", "POST", target + "/rotate", {
      json: { expiresInSeconds: 60 },
    });
    assert.equal(rotated.integration.generation, 2);
    assert.notEqual(rotated.credential, created.credential);
    await request(discovery, created.credential, projects, 401);
    if (mcp) {
      assert.equal(
        (await mcp.callTool({ name: "project_list", arguments: {} })).isError,
        true,
      );
    }
    await request(discovery, rotated.credential, projects, 200);
    const revoked = await owner.visit("revoke", "DELETE", target);
    assert.ok(revoked.revokedAt);
    await request(capabilities, rotated.credential, null, 401);
    await request(discovery, rotated.credential, projects, 401);
  } finally {
    await mcp?.close();
  }

  const expiring = await owner.visit("short grant", "POST", integrations, {
    status: 201,
    json: { ...grantInput, expiresInSeconds: 1 },
  });
  await delay(1_100);
  await request(discovery, expiring.credential, projects, 401);
  if (values.worker) {
    const { verifyHostedRelay } =
      await import("./external-mcp-relay-cases.mjs");
    await verifyHostedRelay({
      binary: values.worker,
      codex: values.codex,
      directory,
      env,
      server,
      owner,
      ownerId,
      password,
      unrelated,
      outsideScope,
      outsideAccount,
      integrations,
      request,
      connectMcp,
      verifyApp:
        app &&
        ((input) =>
          app.verify({ ...input, serverUrl: server.origin, password })),
    });
  }
  console.log(
    JSON.stringify({
      result: "passed",
      hostedCredentialLifecycle: true,
      sdkScopeDiscovery: Boolean(values.worker),
      encryptedHostedRelay: Boolean(values.worker),
      orchestration: Boolean(values.worker && values.codex),
      checkoutInspection: Boolean(values.worker),
      appClient: Boolean(app),
    }),
  );
} finally {
  await app?.close();
  await server?.close();
  await rm(directory, { recursive: true, force: true });
}
