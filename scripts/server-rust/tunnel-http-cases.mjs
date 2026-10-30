import assert from "node:assert/strict";
import { tunnelCreateInput } from "./tunnel-wire-fixtures.mjs";
import { tunnelIds } from "./tunnel-state.mjs";
export const httpTunnelIds = Object.fromEntries(
  ["created", "insertError", "updateError", "deleteError", "invalidRecord"].map(
    (name, i) => [
      name,
      "99999999-9999-4999-8999-" + String(i + 1).padStart(12, "0"),
    ],
  ),
);
const input = (extra = {}) => ({ ...tunnelCreateInput, ...extra });
const record = (revision) => ({
  ...tunnelCreateInput.protectedRecord,
  revision,
  operationId: "66666666-6666-4666-8666-" + String(revision).padStart(12, "0"),
});
export async function tunnelHttpCases({ visit, profile }) {
  const route = (id) => "/api/tunnels/" + id;
  const create = (label, body, status = 201, options = {}) =>
    visit(label, "POST", "/api/tunnels", { json: body, status, ...options });
  const update = (label, body, status = 200, id = httpTunnelIds.created) =>
    visit(label, "PATCH", route(id), { json: body, status });
  const remove = (label, id = httpTunnelIds.created, status = 204) =>
    visit(label, "DELETE", route(id), { status });
  if (profile === "accounts")
    await visit(
      "anonymous catalog requires authentication",
      "GET",
      "/api/tunnels",
      { client: "guest", status: 401 },
    );
  for (const target of [
    "/api/tunnels",
    "/api/projects/github/tunnels",
    "/api/projects/folder/tunnels",
    route(tunnelIds.main),
    route(tunnelIds.durable),
  ]) {
    await visit("read " + target, "GET", target);
    await visit("head " + target, "HEAD", target, {
      compareContentLength: true,
    });
  }
  await visit("missing project", "GET", "/api/projects/missing/tunnels", {
    status: 404,
  });
  await visit("foreign project", "GET", "/api/projects/other/tunnels", {
    status: 404,
  });
  await visit("foreign tunnel", "GET", route(tunnelIds.foreign), {
    status: 404,
  });
  await visit("missing tunnel", "GET", route("missing"), { status: 404 });
  for (const body of [
    undefined,
    null,
    {},
    [],
    { ...input(), extra: true },
    { ...input(), destination: { kind: "worker-tcp" } },
    {
      ...input(),
      destination: {
        kind: "worker-tcp",
        workerId: "alpha",
        host: "127.0.0.1",
        port: 80,
      },
    },
    {
      ...input(),
      destination: {
        kind: "worker-adapter",
        workerId: "alpha",
        adapter: "project-share",
        resourceId: "share",
      },
    },
    { ...input(), protectedRecord: record(2) },
  ])
    await create("invalid create " + JSON.stringify(body), body, 400);
  if (profile === "accounts")
    await create("missing CSRF", input(), 403, { csrf: false });
  await create("foreign project create", input({ projectId: "other" }), 404);
  await create(
    "missing worker create",
    input({ destination: { kind: "worker-tcp", workerId: "missing" } }),
    404,
  );
  await create(
    "bound folder worker mismatch",
    input({
      projectId: "folder",
      destination: { kind: "worker-tcp", workerId: "beta" },
    }),
    409,
  );
  await create(
    "local Git worker mismatch",
    input({
      projectId: "local-git",
      destination: { kind: "worker-tcp", workerId: "�" },
    }),
    409,
  );
  const defaults = structuredClone(input());
  delete defaults.projectId;
  const created = await create("create project default", defaults);
  assert.equal(created.projectId, null);
  assert.deepEqual(created.protectedRecord, input().protectedRecord);
  await create("duplicate id maps to generic 500", input(), 500);
  await create(
    "actual insert trigger failure",
    input({
      id: httpTunnelIds.insertError,
      protectedRecord: {
        ...input().protectedRecord,
        operationId: httpTunnelIds.insertError,
      },
    }),
    500,
  );
  for (const body of [
    undefined,
    null,
    {},
    { protectedRecord: record(2), extra: true },
    {
      protectedRecord: record(2),
      destination: { kind: "worker-tcp", workerId: "alpha", host: "localhost" },
    },
  ])
    await update("invalid update " + JSON.stringify(body), body, 400);
  await update(
    "missing tunnel update",
    { protectedRecord: record(2) },
    404,
    "missing",
  );
  await update(
    "managed tunnel update",
    { protectedRecord: record(2) },
    409,
    tunnelIds.durable,
  );
  await update(
    "active attachment update",
    { protectedRecord: record(2) },
    409,
    tunnelIds.main,
  );
  await remove("active attachment delete", tunnelIds.main, 409);
  await remove("managed tunnel delete", tunnelIds.durable, 409);
  await remove("foreign tunnel delete", tunnelIds.foreign, 404);
  await update("stale revision update", { protectedRecord: record(1) }, 409);
  await update(
    "operation reuse update",
    { protectedRecord: { ...input().protectedRecord, revision: 2 } },
    409,
  );
  await update(
    "foreign project update",
    { projectId: "other", protectedRecord: record(2) },
    404,
  );
  await update(
    "bound folder update mismatch",
    {
      projectId: "folder",
      destination: { kind: "worker-tcp", workerId: "beta" },
      protectedRecord: record(2),
    },
    409,
  );
  await update(
    "actual update trigger failure",
    { protectedRecord: record(2) },
    500,
    httpTunnelIds.updateError,
  );
  await remove("actual delete trigger failure", httpTunnelIds.deleteError, 500);
  await update("assign project and protocol", {
    projectId: "github",
    protocolHint: "https",
    protectedRecord: record(2),
  });
  await update("preserve omitted project", { protectedRecord: record(3) });
  await update("clear nullable project", {
    projectId: null,
    protectedRecord: record(4),
  });
  await update("change destination and opaque content", {
    destination: { kind: "worker-tcp", workerId: "beta" },
    protectedRecord: record(5),
  });
  await visit("updated read", "GET", route(httpTunnelIds.created));
  if (profile === "accounts") {
    await visit(
      "other account read hidden",
      "GET",
      route(httpTunnelIds.created),
      { client: "other", status: 404 },
    );
    await visit(
      "other account update hidden",
      "PATCH",
      route(httpTunnelIds.created),
      { client: "other", json: { protectedRecord: record(6) }, status: 404 },
    );
    await visit(
      "other account delete hidden",
      "DELETE",
      route(httpTunnelIds.created),
      { client: "other", status: 404 },
    );
  }
  await remove("delete created tunnel");
  await remove("repeat delete is missing", httpTunnelIds.created, 404);
  for (const hint of [
    "tcp",
    "http",
    "https",
    "http-websocket",
    "https-websocket",
    "webdav",
  ]) {
    await create(
      "create protocol " + hint,
      input({ protocolHint: hint, projectId: "github" }),
    );
    await remove("delete protocol " + hint);
  }
  await create("create owned folder", input({ projectId: "folder" }));
  await remove("delete owned folder");
  await create("create local Git", input({ projectId: "local-git" }));
  // Leave a real accepted row to verify durability after process restart.
}
