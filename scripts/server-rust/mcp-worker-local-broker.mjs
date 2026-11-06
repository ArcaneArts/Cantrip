import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  CANTRIP_MCP_OPERATIONS,
  cantripMcpOperationsForPermissionProfile,
  cantripMcpToolNamesForOperations,
} from "../../packages/protocol/dist/index.js";
import { CantripMcpBroker } from "../../cantrip_worker/src/mcp/broker.ts";
import { CANTRIP_MCP_STANDALONE_OPERATIONS } from "../../cantrip_worker/src/mcp/profile.ts";
import {
  workerWebFixture,
  privateWebText,
  elementRef,
} from "./mcp-worker-local-fixtures.mjs";
const workerRequire = createRequire(
  new URL("../../cantrip_worker/package.json", import.meta.url),
);
const { Client } = await import(
  pathToFileURL(
    workerRequire.resolve("@modelcontextprotocol/sdk/client/index.js"),
  ).href
);
const { StreamableHTTPClientTransport } = await import(
  pathToFileURL(
    workerRequire.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"),
  ).href
);

export async function workerLocalBrokerCases(h, binding, root, result) {
  result.brokers = [];
  for (const mode of ["project", "read-only", "standalone"]) {
    const broker = new CantripMcpBroker({
      dataDirectory: path.join(
        root,
        "broker",
        h.fixture.name,
        h.fixture.kind,
        mode,
      ),
      serverUrl: h.fixture.server.origin,
      token: h.credential,
      workerId: binding.workerId,
    });
    const web = workerWebFixture(),
      clients = [];
    const record = { mode, tools: [], calls: [], boundaryCalls: web.calls };
    result.brokers.push(record);
    broker.setEncryptionService(h.encryption);
    broker.setWebService(web.service);
    await broker.start();
    try {
      const compatibility = await broker.serverCompatibility();
      assert.deepEqual(compatibility, {
        bindingProtocolVersion: 2,
        operations: [...CANTRIP_MCP_OPERATIONS],
      });
      const permission = mode === "read-only" ? ":read-only" : ":workspace";
      // The unchanged worker's actual negotiation rule, including tool.help.
      const candidates =
        mode === "standalone"
          ? CANTRIP_MCP_STANDALONE_OPERATIONS
          : cantripMcpOperationsForPermissionProfile(permission);
      const allowedOperations = candidates.filter(
        (op) => op === "tool.help" || compatibility.operations.includes(op),
      );
      const { bindingId, issuedAt, expiresAt, ...claims } = binding;
      const attachment = broker.createBinding({
        ...claims,
        permissionProfileId: permission,
        ...(mode === "standalone"
          ? {
              contextKind: "standalone",
              projectId: null,
              worktreeId: null,
              rootKind: null,
              scratchRootId: "worker-web-scratch",
            }
          : {}),
        allowedOperations,
        serverCompatibility: compatibility,
      });
      const endpoint = new URL(
        `/v1/mcp/${attachment.binding.bindingId}`,
        broker.endpoint,
      );
      const client = new Client({
        name: "rust-server-worker-local-compatibility",
        version: "1",
      });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(endpoint, {
          requestInit: {
            headers: {
              authorization: `Bearer ${attachment.connection.credential}`,
            },
          },
        }),
      );
      const catalog = await client.listTools();
      record.tools = catalog.tools;
      assert.deepEqual(
        catalog.tools.map((t) => t.name).sort(),
        cantripMcpToolNamesForOperations(allowedOperations).sort(),
      );
      async function call(name, args = {}, fails = false) {
        const response = await client.callTool({ name, arguments: args });
        record.calls.push({ name, args, response });
        assert.equal(
          Boolean(response.isError),
          fails,
          JSON.stringify({ name, response }),
        );
        return response.structuredContent;
      }
      await call("tool_help", { tool: "web_search" });
      const search = await call("web_search", {
        query: "Worker-private search query",
      });
      const id = search.data.results[0].id;
      assert.match(id, /^wsr_[A-Za-z0-9_-]{32}$/u);
      const read = await call("web_read", {
        searchResultId: id,
        maxChars: 1000,
      });
      assert.equal(read.data.content, privateWebText.trim().slice(0, 1000));
      assert.ok(
        read.data.cursor,
        "production read service returns a bounded cursor",
      );
      await call("web_read", { cursor: read.data.cursor, maxChars: 1000 });
      await call("web_read", { searchResultId: `wsr_${"Z".repeat(32)}` }, true);
      await call("web_search", { query: "x", unknown: "strict" }, true);
      if (mode === "project") {
        const opened = await call("web_session_open", {
          url: "https://example.com/research",
        });
        const sessionId = opened.data.sessionId;
        const snapshot = await call("web_session_snapshot", { sessionId });
        assert.equal(snapshot.data.elements[0].ref, elementRef);
        await call("web_session_click", { sessionId, elementRef });
        await call("web_session_pointer", {
          sessionId,
          action: "drag",
          x: 1,
          y: 2,
          to: { x: 3, y: 4 },
          durationMs: 10,
        });
        await call("web_session_type", {
          sessionId,
          elementRef,
          text: "Worker-private typed text",
          submit: true,
        });
        await call("web_session_close", { sessionId });
        await call("web_session_snapshot", { sessionId }, true);
      } else {
        await call(
          "web_session_open",
          { url: "https://example.com/research" },
          true,
        );
        await call(
          "web_session_snapshot",
          { sessionId: `wss_${"A".repeat(32)}` },
          true,
        );
        if (mode === "standalone")
          await call("tool_help", { tool: "target_list" }, true);
      }
      // Also prove the broker rejects a hidden operation independently of MCP.
      if (mode !== "project") {
        const denied = await fetch(new URL("/v1/execute", broker.endpoint), {
          method: "POST",
          headers: {
            authorization: `Bearer ${attachment.connection.credential}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            bindingId: attachment.binding.bindingId,
            request: {
              operation: "web.session.open",
              arguments: { url: "https://example.com" },
            },
          }),
        });
        assert.equal(denied.status, 403);
        record.brokerDenied = await denied.json();
      }
      const unauthorized = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: "Bearer wrong",
          "content-type": "application/json",
        },
        body: "{}",
      });
      assert.equal(unauthorized.status, 401);
      broker.revokeBinding(attachment.binding.bindingId);
      const revoked = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${attachment.connection.credential}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      assert.equal(revoked.status, 401);
      record.unauthorizedAndRevoked = [unauthorized.status, revoked.status];
    } finally {
      for (const client of clients) await client.close();
      await broker.close();
    }
  }
}
