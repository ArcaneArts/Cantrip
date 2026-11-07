// Only the provider HTTP boundary is controlled. Both servers, their actual
// worker protocol, snapshot paging and catalog repositories remain production.
import assert from "node:assert/strict";
import { createServer } from "node:http";

export const catalogLargeCount = 1050;
export const catalogPrivateMarker = "private-gateway-deployment-credential";
const language = (id, description = "Owned catalog model") => ({
  id,
  type: "llm",
  description,
  context_length: 1024,
});
const seed = () => [
  language("paged-language"),
  { id: "paged-embedding", type: "embedding" },
  { id: "paged-decision", type: "decision" },
];

export async function catalogProvider() {
  const key = "owned-catalog-provider-private-key";
  const requests = [],
    trapRequests = [],
    failures = [];
  const sockets = new Set(),
    phases = new Map(),
    tokens = new Map();
  let sequence = 0;
  const trap = createServer((request, response) => {
    trapRequests.push({ method: request.method, path: request.url });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [] }));
  });
  await new Promise((resolve, reject) => {
    trap.once("error", reject);
    trap.listen(0, "127.0.0.1", resolve);
  });
  const trapUrl = `http://127.0.0.1:${trap.address().port}/models`;
  const select = (group, name, { hold = false } = {}) => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const phase = {
      group,
      name,
      token: String(++sequence),
      hold,
      gate,
      release,
      entered: false,
    };
    phases.set(group, phase);
    tokens.set(phase.token, phase);
    return phase;
  };
  for (const group of ["paged", "studio", "gateway", "scope", "unsloth"])
    select(group, group === "scope" ? "language" : "seed");
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const group = url.pathname.split("/")[1];
    const phase =
      tokens.get(url.searchParams.get("token")) ?? phases.get(group);
    const entry = {
      method: request.method,
      path: url.pathname,
      query: url.search,
      group,
      phase: phase?.name,
      authenticated: request.headers.authorization === `Bearer ${key}`,
      completed: false,
      closed: false,
    };
    requests.push(entry);
    response.on("finish", () => {
      entry.completed = true;
    });
    response.on("close", () => {
      entry.closed = true;
    });
    const send = (value, status = 200) => {
      const text = JSON.stringify(value);
      entry.bytes = Buffer.byteLength(text);
      entry.status = status;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(text);
    };
    try {
      assert.ok(phase);
      if (!entry.authenticated) {
        send({ error: "Owned catalog authentication required" }, 401);
        return;
      }
      if (request.method === "POST") {
        assert.equal(group, "scope");
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        assert.equal(body.model, "shared-scope");
        entry.model = body.model;
        if (url.pathname.endsWith("/embeddings")) {
          send({
            model: "shared-scope",
            data: body.input.map((_, index) => ({
              index,
              embedding: [0.25, -0.5],
            })),
            usage: { prompt_tokens: 2, total_tokens: 2 },
          });
          return;
        }
        throw new Error("Unexpected catalog inference path");
      }
      assert.equal(request.method, "GET");
      if (group === "paged") {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        if (phase.hold && offset === 250) {
          phase.entered = true;
          await Promise.race([
            phase.gate,
            new Promise((resolve) => response.once("close", resolve)),
          ]);
          if (response.destroyed) return;
        }
        if (phase.name === "failure" && offset) {
          send({ error: catalogPrivateMarker }, 503);
          return;
        }
        const large = ["large", "failure"].includes(phase.name);
        const models = large
          ? Array.from({ length: catalogLargeCount }, (_, index) => ({
              ...(seed()[index] ??
                language(`paged-${String(index).padStart(4, "0")}`)),
              description: (phase.name === "failure"
                ? "Uncommitted catalog replacement "
                : "Owned large catalog description "
              ).padEnd(4300, "x"),
            }))
          : seed();
        if (phase.name === "foreign") {
          send({
            data: [language("uncommitted-foreign")],
            links: { next: trapUrl },
          });
          return;
        }
        if (phase.name === "loop") {
          send({
            data: [language("uncommitted-loop")],
            next: `?token=${phase.token}&offset=0`,
          });
          return;
        }
        const next = offset + 250;
        send({
          data: models.slice(offset, next),
          ...(next < models.length
            ? { links: { next: `?token=${phase.token}&offset=${next}` } }
            : {}),
        });
      } else if (group === "studio") {
        if (url.pathname === "/studio/v1/models") {
          send({
            data: [
              language("studio-common"),
              ...(["partial", "complete"].includes(phase.name)
                ? [language("studio-new")]
                : []),
            ],
          });
        } else {
          assert.equal(url.pathname, "/studio/api/v1/models");
          const common = {
            key: "studio-common",
            type: "llm",
            loaded_instances: [
              {
                config: {
                  context_length: phase.name === "partial" ? 8192 : 4096,
                },
              },
            ],
          };
          send({
            models:
              phase.name === "partial"
                ? [common, {}]
                : [
                    common,
                    ...(phase.name === "complete"
                      ? []
                      : [{ key: "studio-embedding", type: "embedding" }]),
                    { key: "studio-decision", type: "decision" },
                  ],
          });
        }
      } else if (group === "gateway") {
        if (url.pathname === "/gateway/v1/models") {
          send({
            data: [
              { id: "public-hybrid" },
              { id: "public-image" },
              { id: "public-legacy" },
            ],
          });
        } else {
          assert.equal(url.pathname, "/gateway/v1/model/info");
          const deployment = (name, mode, max) => ({
            model_name: name,
            model_info: {
              mode,
              max_input_tokens: max,
              id: catalogPrivateMarker,
            },
            litellm_params: {
              model: catalogPrivateMarker,
              api_key: catalogPrivateMarker,
            },
          });
          send({
            data:
              phase.name === "partial"
                ? [deployment("public-hybrid", "chat", 99)]
                : [
                    deployment("public-hybrid", "embedding", 2048),
                    deployment("public-hybrid", "embedding", 1024),
                    deployment("public-hybrid", "decisions", 512),
                    deployment("public-image", "image_generation"),
                    deployment("private-not-public", "chat"),
                  ],
            ...(phase.name === "partial" ? { has_more: true } : {}),
          });
        }
      } else if (group === "scope") {
        assert.equal(url.pathname, "/scope/v1/models");
        send({
          data: [
            {
              id: "shared-scope",
              type: phase.name === "embedding" ? "embedding" : "llm",
            },
          ],
        });
      } else {
        assert.equal(group, "unsloth");
        assert.equal(url.searchParams.get("output_modalities"), "all");
        send({
          data: [
            { id: "studio-image-task", task: "image-generation" },
            {
              id: "studio-native-decision",
              task: "decision",
              type: "decision",
            },
          ],
        });
      }
    } catch (error) {
      entry.failure = error.message;
      failures.push({ message: error.message, stack: error.stack });
      if (!response.headersSent)
        send({ error: "Owned catalog boundary assertion failed" }, 500);
      else response.destroy();
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    key,
    requests,
    trapRequests,
    failures,
    select,
    baseUrl(group) {
      return `http://127.0.0.1:${server.address().port}/${group}/v1`;
    },
    async close() {
      for (const phase of tokens.values()) phase.release();
      const ended = new Promise((resolve) => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await ended;
      await new Promise((resolve) => trap.close(resolve));
    },
  };
}
