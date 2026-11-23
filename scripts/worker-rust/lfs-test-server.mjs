// Loopback-only Git LFS protocol fixture; real git-lfs clients exercise it.
import assert from "node:assert/strict";
import { createServer } from "node:http";
export async function startLfsFixture(objects = new Map()) {
  const lanes = new Map(),
    requests = [];
  const lane = (name) => {
    if (!lanes.has(name)) lanes.set(name, { next: 1, locks: new Map() });
    return lanes.get(name);
  };
  let origin;
  const server = createServer(async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, { "content-type": "application/vnd.git-lfs+json" });
      res.end(JSON.stringify(value));
    };
    try {
      const url = new URL(req.url, origin),
        [, name, ...parts] = url.pathname.split("/"),
        route = parts.join("/");
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
        : {};
      requests.push({
        lane: name,
        method: req.method,
        route,
        operation: body.operation,
      });
      if (name === "unavailable")
        return send(503, { message: "Owned LFS fixture unavailable" });
      const state = lane(name);
      if (route === "objects/batch" && req.method === "POST")
        return send(200, {
          transfer: "basic",
          objects: (body.objects ?? []).map(({ oid, size }) =>
            objects.has(oid)
              ? {
                  oid,
                  size,
                  actions: {
                    download: { href: `${origin}/${name}/objects/${oid}` },
                  },
                }
              : {
                  oid,
                  size,
                  error: { code: 404, message: "Owned object missing" },
                },
          ),
        });
      if (route.startsWith("objects/") && req.method === "GET") {
        const bytes = objects.get(route.slice("objects/".length));
        if (!bytes) return send(404, { message: "Owned object missing" });
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": bytes.length,
        });
        return res.end(bytes);
      }
      if (route === "locks" && req.method === "GET")
        return send(200, {
          locks: [...state.locks.values()].filter(
            (lock) =>
              !url.searchParams.has("path") ||
              lock.path === url.searchParams.get("path"),
          ),
          next_cursor: "",
        });
      if (route === "locks" && req.method === "POST") {
        const existing = [...state.locks.values()].find(
          (lock) => lock.path === body.path,
        );
        if (existing)
          return send(409, { message: "Lock exists", lock: existing });
        const lock = {
          id: String(state.next++),
          path: body.path,
          locked_at: "2026-11-17T12:00:00Z",
          owner: { name: "Fixture" },
        };
        state.locks.set(lock.id, lock);
        return send(201, { lock });
      }
      if (route === "locks/verify" && req.method === "POST")
        return send(200, {
          ours: [...state.locks.values()].filter(
            (lock) => lock.owner.name === "Fixture",
          ),
          theirs: [...state.locks.values()].filter(
            (lock) => lock.owner.name !== "Fixture",
          ),
          next_cursor: "",
        });
      const unlock = /^locks\/([^/]+)\/unlock$/.exec(route);
      if (unlock && req.method === "POST") {
        const lock = state.locks.get(unlock[1]);
        if (!lock) return send(404, { message: "Lock missing" });
        if (lock.owner.name !== "Fixture" && !body.force)
          return send(403, { message: "Lock belongs to another owner" });
        state.locks.delete(lock.id);
        return send(200, { lock });
      }
      send(404, { message: `Unsupported owned fixture route: ${route}` });
    } catch (error) {
      send(500, { message: error.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    objects,
    requests,
    reset(name) {
      lanes.delete(name);
    },
    foreign(name, path) {
      const state = lane(name);
      const lock = {
        id: String(state.next++),
        path,
        locked_at: "2026-11-17T12:00:00Z",
        owner: { name: "Other" },
      };
      state.locks.set(lock.id, lock);
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
