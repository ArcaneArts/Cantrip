// A disposable Z.ai-shaped HTTPS peer for the unchanged native Codex process.
// CONNECT accepts exactly this owned listener; no request reaches api.z.ai.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer as httpsServer } from "node:https";
import { createServer as httpServer } from "node:http";
import { connect } from "node:net";
import path from "node:path";

const execute = promisify(execFile);
export async function providerTestBoundary(directory) {
  await mkdir(directory, { recursive: true });
  const file = (name) => path.join(directory, name);
  await execute("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    file("ca.key"),
    "-out",
    file("ca.pem"),
    "-days",
    "1",
    "-subj",
    "/CN=Cantrip disposable provider CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
  ]);
  await execute("openssl", [
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    file("server.key"),
    "-out",
    file("server.csr"),
    "-subj",
    "/CN=api.z.ai",
  ]);
  await writeFile(
    file("extensions.cnf"),
    "subjectAltName=DNS:api.z.ai\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n",
  );
  await execute("openssl", [
    "x509",
    "-req",
    "-in",
    file("server.csr"),
    "-CA",
    file("ca.pem"),
    "-CAkey",
    file("ca.key"),
    "-CAcreateserial",
    "-out",
    file("server.pem"),
    "-days",
    "1",
    "-extfile",
    file("extensions.cnf"),
  ]);
  const apiKey = "cantrip-disposable-provider-test-key",
    requests = [],
    tunnels = [],
    blockedTunnels = [],
    discoveryProbes = [],
    failures = [],
    replies = [],
    sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const peer = httpsServer(
    {
      key: await readFile(file("server.key")),
      cert: await readFile(file("server.pem")),
    },
    async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const text = Buffer.concat(chunks).toString();
        const input = text ? JSON.parse(text) : null;
        assert.equal(request.socket.servername, "api.z.ai");
        assert.equal(request.headers.authorization, "Bearer " + apiKey);
        const record = {
          method: request.method,
          path: request.url,
          input,
          authenticated: true,
          completed: false,
        };
        requests.push(record);
        if (request.method === "GET" && request.url === "/api/v1/models") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              object: "list",
              data: [
                {
                  id: "glm-5.3",
                  object: "model",
                  created: 0,
                  owned_by: "acceptance",
                },
              ],
            }),
          );
        } else {
          assert.equal(request.method, "POST");
          assert.equal(request.url, "/api/v1/responses");
          assert.equal(input.model, "glm-5.3");
          assert.equal(input.stream, true);
          const plan = replies[0];
          assert.ok(
            plan,
            "native provider check requested an unscripted response",
          );
          if (!plan.repeat) replies.shift();
          record.responseStatus = plan.status ?? 200;
          if (plan.status) {
            response.writeHead(plan.status, {
              "content-type": "application/json",
            });
            response.end(
              JSON.stringify({
                error: { message: plan.message, type: "authentication_error" },
              }),
            );
          } else {
            const id = "cantrip-provider-check-" + requests.length;
            const item = {
              id: id + "-message",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "OK" }],
            };
            response.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
            });
            const send = (event) =>
              response.write(
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              );
            send({ type: "response.created", response: { id } });
            send({
              type: "response.output_item.added",
              output_index: 0,
              item: { ...item, content: [] },
            });
            send({
              type: "response.output_text.delta",
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              delta: "OK",
            });
            send({ type: "response.output_item.done", output_index: 0, item });
            send({
              type: "response.completed",
              response: {
                id,
                usage: {
                  input_tokens: 1,
                  input_tokens_details: null,
                  output_tokens: 1,
                  output_tokens_details: null,
                  total_tokens: 2,
                },
              },
            });
            response.end();
          }
        }
        record.completed = true;
      } catch (error) {
        failures.push(error.message);
        if (!response.headersSent)
          response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: "Controlled provider boundary failed" },
          }),
        );
      }
    },
  );
  peer.on("connection", track);
  peer.listen(0, "127.0.0.1");
  await once(peer, "listening");
  const target = "api.z.ai:" + peer.address().port;
  const proxy = httpServer(async (request, response) => {
    if (
      request.method === "POST" &&
      ["/mcp", "/"].includes(request.url) &&
      request.headers["user-agent"] === "Cantrip-MCP-Discovery/1.0"
    ) {
      // The unchanged discovery code scans HTTP URLs in the worker environment,
      // including HTTPS_PROXY. Validate its actual initialize probe and report
      // that this owned URL is not an MCP server, as the model fixture does.
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks).toString());
        assert.deepEqual(input, {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: input.params.protocolVersion,
            capabilities: {},
            clientInfo: { name: "cantrip-mcp-discovery", version: "1.0.0" },
          },
        });
        assert.equal(typeof input.params.protocolVersion, "string");
        discoveryProbes.push({
          method: request.method,
          path: request.url,
          input,
        });
        response.writeHead(404, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: "This fixture serves the owned provider proxy.",
          }),
        );
      } catch (error) {
        failures.push("invalid MCP probe of owned proxy: " + error.message);
        response.writeHead(500);
        response.end();
      }
      return;
    }
    const target = new URL(request.url, "http://proxy.invalid");
    failures.push(
      "unexpected non-CONNECT proxy request " +
        request.method +
        " " +
        target.origin +
        target.pathname,
    );
    response.writeHead(502);
    response.end();
  });
  proxy.on("connection", track);
  proxy.on("connect", (request, socket, head) => {
    if (request.url !== target) {
      // These real startup/catalog lookups were observed in the reference
      // worker. Deny them locally as well; only the owned model peer is routed.
      const housekeeping = new Set([
        "github.com:443",
        "api.github.com:443",
        "raw.githubusercontent.com:443",
        "chatgpt.com:443",
      ]);
      if (housekeeping.has(request.url)) blockedTunnels.push(request.url);
      else failures.push("unexpected CONNECT target " + request.url);
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      return;
    }
    tunnels.push(request.url);
    const upstream = connect(peer.address().port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    track(upstream);
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const proxyUrl = "http://127.0.0.1:" + proxy.address().port;
  return {
    apiKey,
    requests,
    tunnels,
    blockedTunnels,
    discoveryProbes,
    failures,
    baseUrl: "https://" + target + "/api/v1",
    environment: {
      HTTPS_PROXY: proxyUrl,
      https_proxy: proxyUrl,
      NO_PROXY: "127.0.0.1,localhost,::1",
      no_proxy: "127.0.0.1,localhost,::1",
      CODEX_CA_CERTIFICATE: file("ca.pem"),
    },
    reply: (plan) => replies.push(plan),
    clearReply: () => replies.shift(),
    async close() {
      const stopped = Promise.all([once(peer, "close"), once(proxy, "close")]);
      peer.close();
      proxy.close();
      for (const socket of sockets) socket.destroy();
      await stopped;
    },
  };
}
