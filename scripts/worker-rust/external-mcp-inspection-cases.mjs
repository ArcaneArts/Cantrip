// The MCP client, relay, checkout, and CodeGraph runtime are all real. The
// disposable server and worker profiles are owned by the hosted grant smoke.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { WorkerRoutingRegistry } from "../../tests/reference-node-worker/src/routing-registry.ts";

export async function verifyInspection({
  client,
  workerDirectory,
  directory,
  projectId,
  ownerVisit,
}) {
  const tools = (await client.listTools()).tools.map(({ name }) => name);
  assert.deepEqual(tools, [
    "directory_list",
    "file_metadata",
    "file_read",
    "file_search",
    "codegraph_status",
    "codegraph_query",
  ]);
  const call = async (name, args = {}, errorPattern) => {
    const result = await client.callTool({
      name,
      arguments: { projectId, ...args },
    });
    if (errorPattern) {
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.match(JSON.stringify(result.content), errorPattern);
      return;
    }
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.ok(result.structuredContent?.worktreeId, JSON.stringify(result));
    assert.equal(result.structuredContent.projectId, projectId);
    assert.equal(JSON.stringify(result).includes(directory), false);
    return result.structuredContent;
  };

  const worktrees = await ownerVisit(
    "GET",
    `/api/projects/${projectId}/worktrees`,
    200,
  );
  const primary = worktrees.find(({ isPrimary }) => isPrimary);
  assert.ok(primary, JSON.stringify(worktrees));
  const registry = new WorkerRoutingRegistry(workerDirectory);
  const resolved = await registry.resolveMetadata({ path: primary.path });
  const checkout = await realpath(resolved.path);
  const relative = path.relative(await realpath(directory), checkout);
  assert.ok(
    relative && !relative.startsWith("..") && !path.isAbsolute(relative),
  );
  assert.ok((await lstat(checkout)).isDirectory());
  await mkdir(path.join(checkout, "src"));
  const source = [
    "export function mcpFixtureSymbol() { return 42; }",
    "export function mcpFixtureCaller() { return mcpFixtureSymbol(); }",
    "",
  ].join("\n");
  await writeFile(path.join(checkout, "src", "fixture.ts"), source);
  const utf8 = "ab🚀xyz\r\n";
  await writeFile(path.join(checkout, "utf8.txt"), utf8);
  await writeFile(
    path.join(checkout, "binary.bin"),
    Buffer.from([0, 127, 255]),
  );
  await writeFile(path.join(checkout, "large.txt"), "\t".repeat(24000));

  const first = await call("directory_list", { limit: 1 });
  const worktreeId = first.worktreeId;
  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0].kind, "directory");
  assert.ok(first.nextCursor);
  const rest = await call("directory_list", {
    worktreeId,
    cursor: first.nextCursor,
  });
  assert.ok(rest.entries.some(({ path }) => path === "utf8.txt"));
  assert.equal(rest.nextCursor, null);
  await call(
    "directory_list",
    { path: "src", cursor: first.nextCursor },
    /directory changed/iu,
  );
  await call(
    "directory_list",
    { worktreeId: randomUUID() },
    /not found|unavailable/iu,
  );
  assert.equal(
    (await call("file_metadata", { path: "src/fixture.ts" })).entry.size,
    Buffer.byteLength(source),
  );
  assert.equal(
    (await call("file_read", { worktreeId, path: "src/fixture.ts" })).text,
    source,
  );
  assert.deepEqual(
    (await call("file_search", { query: "fixture.ts" })).entries,
    [{ path: "src/fixture.ts" }],
  );
  const page = await call("file_read", { path: "utf8.txt", maxBytes: 4 });
  assert.equal(page.text, "ab");
  assert.equal(page.nextOffset, 2);
  const next = await call("file_read", {
    path: "utf8.txt",
    offset: page.nextOffset,
  });
  assert.equal(page.text + next.text, utf8);
  assert.equal(next.nextOffset, null);
  const large = await call("file_read", { path: "large.txt", maxBytes: 8192 });
  assert.ok(large.nextOffset > 0 && large.nextOffset < large.size);
  assert.ok(Buffer.byteLength(JSON.stringify(large), "utf8") < 21 * 1024);
  await call("file_read", { path: "missing.txt" }, /unavailable/iu);
  await call("file_read", { path: "binary.bin" }, /binary|UTF-8/iu);
  for (const invalid of [
    "../sibling.txt",
    "/tmp/sibling.txt",
    "C:\\secret",
    ".git/config",
    "src/../utf8.txt",
  ]) {
    await call("file_read", { path: invalid }, /tool.+|path/iu);
  }
  if (process.platform !== "win32") {
    await writeFile(
      path.join(directory, "external-secret.txt"),
      "Outside the checkout.",
    );
    await symlink(
      path.join(directory, "external-secret.txt"),
      path.join(checkout, "leaf-link"),
    );
    await symlink(directory, path.join(checkout, "outside-dir"));
    assert.equal(
      (await call("file_metadata", { path: "leaf-link" })).entry.kind,
      "symlink",
    );
    await call(
      "file_read",
      { path: "leaf-link" },
      /unavailable|symbolic link/iu,
    );
    await call(
      "file_read",
      { path: "outside-dir/external-secret.txt" },
      /unavailable|symbolic link/iu,
    );
    assert.deepEqual(
      (await call("file_search", { query: "external-secret.txt" })).entries,
      [],
    );
  }
  assert.equal((await call("codegraph_status")).state, "unavailable");
  await call(
    "codegraph_query",
    { kind: "symbols", query: "mcpFixtureSymbol" },
    /not installed/iu,
  );
}

async function verifyIndexedCheckout({
  invoke,
  checkout,
  worktreeId,
  activate,
  eventually,
}) {
  const call = async (name, args = {}, errorPattern) => {
    const result = await invoke(name, { worktreeId, ...args });
    if (errorPattern) {
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.match(JSON.stringify(result.content), errorPattern);
      return;
    }
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(result.structuredContent?.worktreeId, worktreeId);
    return result.structuredContent;
  };
  await mkdir(path.join(checkout, "src"));
  const file = path.join(checkout, "src", "fixture.ts");
  const source = [
    "export function mcpFixtureSymbol() { return 42; }",
    "export function mcpFixtureCaller() { return mcpFixtureSymbol(); }",
    "",
  ].join("\n");
  await writeFile(file, source);
  await activate();
  await eventually(
    () => call("codegraph_status"),
    (snapshot) => {
      assert.equal(snapshot.state, "ready", JSON.stringify(snapshot));
      assert.ok(snapshot.nodeCount > 0, JSON.stringify(snapshot));
    },
    "external MCP CodeGraph index",
  );
  const symbol = await call("codegraph_query", {
    kind: "symbols",
    query: "mcpFixtureSymbol",
  });
  assert.ok(
    symbol.result.some(
      ({ name, path }) =>
        name === "mcpFixtureSymbol" && path === "src/fixture.ts",
    ),
  );
  const refs = await call("codegraph_query", {
    kind: "references",
    query: "mcpFixtureSymbol",
  });
  assert.ok(
    refs.result.some(({ name }) => name === "mcpFixtureCaller"),
    JSON.stringify(refs),
  );
  const context = await call("codegraph_query", {
    kind: "context",
    query: "mcpFixtureSymbol",
  });
  assert.ok(
    context.result.symbols.some(({ path }) => path === "src/fixture.ts"),
  );
  const option = await call("codegraph_query", {
    kind: "symbols",
    query: "--help",
  });
  assert.deepEqual(option.result, []);
  const pending = async () => {
    await writeFile(
      file,
      source + `export const pending = "${randomUUID()}";\n`,
    );
    return call("codegraph_status");
  };
  await eventually(
    pending,
    (snapshot) =>
      assert.equal(snapshot.state, "stale", JSON.stringify(snapshot)),
    "external MCP CodeGraph freshness",
  );
  await eventually(
    async () => {
      await writeFile(
        file,
        source + `export const pending = "${randomUUID()}";\n`,
      );
      const result = await invoke("codegraph_query", {
        worktreeId,
        kind: "symbols",
        query: "mcpFixtureSymbol",
      });
      return result;
    },
    (result) => {
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.match(JSON.stringify(result.content), /index is stale/iu);
    },
    "external MCP refuses stale CodeGraph queries",
  );
  await eventually(
    () => call("codegraph_status"),
    (snapshot) =>
      assert.equal(snapshot.state, "ready", JSON.stringify(snapshot)),
    "external MCP CodeGraph index resync",
  );
  const index = path.join(checkout, ".codegraph-cantrip");
  const away = path.join(path.dirname(checkout), "external-mcp-index-away");
  await rename(index, away);
  try {
    assert.equal((await call("codegraph_status")).state, "missing");
    await call(
      "codegraph_query",
      { kind: "symbols", query: "mcpFixtureSymbol" },
      /no local CodeGraph index/iu,
    );
  } finally {
    await rename(away, index);
  }
  if (process.platform !== "win32") {
    const database = path.join(index, "codegraph.db");
    const outside = path.join(path.dirname(checkout), "outside-codegraph.db");
    await rename(database, outside);
    try {
      await symlink(outside, database);
      try {
        assert.equal((await call("codegraph_status")).state, "missing");
      } finally {
        await unlink(database);
      }
    } finally {
      await rename(outside, database);
    }
  }
}

export async function verifyLocalWorktreeInspection({
  call,
  origin,
  binary,
  projectId,
  workerDirectory,
  checkout,
  cwd,
  registerMetadata,
  codegraphInstalled,
  eventually,
}) {
  const requireSdk = createRequire(
    new URL("../../tests/reference-node-worker/package.json", import.meta.url),
  );
  const { Client } = await import(
    requireSdk.resolve("@modelcontextprotocol/sdk/client/index.js")
  );
  const { StdioClientTransport } = await import(
    requireSdk.resolve("@modelcontextprotocol/sdk/client/stdio.js")
  );
  const client = new Client({
    name: "local-worktree-inspection",
    version: "1",
  });
  const transport = new StdioClientTransport({
    command: binary,
    args: ["external-mcp", "--server", origin],
    cwd,
  });
  const prefix = `/api/projects/${projectId}/worktrees`;
  const inventory = await call("GET", prefix);
  assert.equal(inventory.status, 200);
  const primary = inventory.body.find(({ isPrimary }) => isPrimary);
  assert.ok(primary);
  const protectedFields = await registerMetadata(projectId, {
    name: "External MCP checkout fixture",
    branch: "external-mcp-fixture",
  });
  const secondary = await call("POST", prefix, {
    name: protectedFields.name,
    mode: {
      type: "newBranch",
      branch: protectedFields.branch,
      startPoint: null,
    },
    sourceWorktreeId: primary.id,
  });
  assert.equal(secondary.status, 201, JSON.stringify(secondary));
  const registry = new WorkerRoutingRegistry(workerDirectory);
  const target = await registry.resolveMetadata({ path: secondary.body.path });
  const otherCheckout = await realpath(target.path);
  const relative = path.relative(cwd, otherCheckout);
  assert.ok(
    relative && !relative.startsWith("..") && !path.isAbsolute(relative),
  );
  await writeFile(path.join(checkout, "branch.txt"), "primary fixture\n");
  await writeFile(
    path.join(otherCheckout, "branch.txt"),
    "secondary fixture\n",
  );
  await writeFile(
    path.join(otherCheckout, "secondary-only.txt"),
    "secondary fixture only\n",
  );
  const invoke = (name, arguments_) =>
    client.callTool({ name, arguments: { projectId, ...arguments_ } });
  const read = (worktreeId) =>
    invoke("file_read", { worktreeId, path: "branch.txt" });
  try {
    await client.connect(transport);
    const placement = await invoke("placement_list", {});
    assert.ok(
      placement.structuredContent?.entries.some(
        ({ target }) => target.worktreeId === secondary.body.id,
      ),
    );
    const first = await read(primary.id);
    assert.equal(first.isError, undefined, JSON.stringify(first));
    assert.equal(first.structuredContent.text, "primary fixture\n");
    const second = await read(secondary.body.id);
    assert.equal(second.isError, undefined, JSON.stringify(second));
    assert.equal(second.structuredContent.text, "secondary fixture\n");
    assert.equal(second.structuredContent.worktreeId, secondary.body.id);
    const cli = await invoke("cantrip_cli", {
      worktreeId: secondary.body.id,
      command: { name: "worktree_status" },
    });
    assert.equal(cli.isError, undefined, JSON.stringify(cli));
    assert.equal(cli.structuredContent.worktreeId, secondary.body.id);
    const worktrees = await invoke("cantrip_cli", {
      command: { name: "worktree_list" },
    });
    assert.equal(worktrees.isError, undefined, JSON.stringify(worktrees));
    assert.ok(
      JSON.stringify(worktrees.structuredContent.data).includes(
        secondary.body.id,
      ),
    );

    if (codegraphInstalled) {
      await verifyIndexedCheckout({
        invoke,
        checkout,
        worktreeId: primary.id,
        eventually,
        activate: async () => {
          const rebuild = await call(
            "POST",
            `${prefix}/${primary.id}/codegraph/rebuild`,
            {},
          );
          assert.equal(rebuild.status, 202, JSON.stringify(rebuild));
        },
      });
    }

    const page = await invoke("directory_list", {
      worktreeId: secondary.body.id,
      limit: 1,
    });
    const cursor = page.structuredContent?.nextCursor;
    assert.ok(cursor, JSON.stringify(page));
    const foreignCursor = await invoke("directory_list", {
      worktreeId: primary.id,
      cursor,
    });
    assert.equal(foreignCursor.isError, true, JSON.stringify(foreignCursor));
    const hidden = await invoke("file_read", {
      worktreeId: primary.id,
      path: "secondary-only.txt",
    });
    assert.equal(hidden.isError, true, JSON.stringify(hidden));
    const moved = otherCheckout + "-moved";
    await rename(otherCheckout, moved);
    try {
      const stale = await read(secondary.body.id);
      assert.equal(stale.isError, true, JSON.stringify(stale));
    } finally {
      await rename(moved, otherCheckout);
    }
    assert.equal(
      (await read(secondary.body.id)).structuredContent?.text,
      "secondary fixture\n",
    );
  } finally {
    await client.close();
  }
}
