import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import {
  decryptSurfacePrivateState,
  encryptPrivateDisplayLabel,
  encryptSurfacePrivateState,
} from "../../packages/crypto/dist/index.js";
import { createPreparedProjectChat } from "./console-interaction-cases.mjs";
import {
  approveManagedMcpTool,
  managedMcpClient,
  managedMcpRpc,
  managedMcpTurn,
} from "./mcp-tool-cases.mjs";
import { RemoteSurfaceWorkerLink } from "./remote-surface-worker-link-client.mjs";

export async function browserFixtureEnvironment(root, chromium) {
  const bin = path.join(root, "browser-fixture-bin");
  await mkdir(bin);
  const tool = (name) =>
    execFileSync("which", [name], { encoding: "utf8" }).trim();
  const lsof = "'" + tool("lsof").replaceAll("'", "'\\''") + "'";
  // Only probe listeners owned by this fixture process.
  await writeFile(
    path.join(bin, "lsof"),
    "#!/bin/sh\nexec " + lsof + " -a -p " + process.pid + ' "$@"\n',
    { mode: 0o700 },
  );
  await symlink(tool("ps"), path.join(bin, "ps"));
  return { PATH: bin, CANTRIP_CHROMIUM_EXECUTABLE: path.resolve(chromium) };
}

export async function verifyManagedMcpBrowser({
  call,
  eventually,
  createModel,
  encryptedTurn,
  ownerId,
  workerId,
  keyRevision,
  labelKey,
  surfaceKey,
  interactionKey,
  data,
  origin,
}) {
  const { profile, model } = await createModel("Managed MCP Browser");
  await call("PATCH", "/api/settings", 200, {
    defaultModelId: profile.id,
    autoNameChats: false,
  });
  const { chatId, chatUrl, projectUrl } = await createPreparedProjectChat({
    call,
    eventually,
    ownerId,
    workerId,
    keyRevision,
    labelKey,
    title: "Managed MCP Browser",
  });
  const projectId = projectUrl.split("/").at(-1);
  const id = randomUUID();
  const browsers = projectUrl + "/browsers";
  const target = {
    kind: "surface",
    projectId,
    surfaceKind: "browser",
    surfaceId: id,
  };
  const attachment = {
    model,
    profile,
    call,
    eventually,
    encryptedTurn,
    chatId,
    chatUrl,
    projectUrl,
  };
  const invoke = managedMcpClient(attachment);
  const visits = [];
  const site = createServer((request, response) => {
    visits.push({ url: request.url, agent: request.headers["user-agent"] });
    response
      .writeHead(200, { "content-type": "text/html" })
      .end("<!doctype html><title>Managed MCP fixture site</title>");
  });
  let view;
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  try {
    const address = "http://127.0.0.1:" + site.address().port;
    const initial = address + "/first";
    const location = {
      ownerId,
      keyRevision,
      componentKey: surfaceKey,
      context: {
        serverId: (await call("GET", "/api/bootstrap", 200)).server.id,
        resource: "browser-row",
        resourceId: id,
        operationId: null,
        recordKind: "browser-state",
      },
    };
    const classification = { recordKind: "browser-state" };
    await call("POST", browsers, 201, {
      id,
      titleProtection: await encryptPrivateDisplayLabel({
        ownerId,
        keyRevision,
        componentKey: labelKey,
        recordKind: "browser",
        rowId: id,
        label: "Private MCP browser",
      }),
      stateProtection: await encryptSurfacePrivateState({
        ...location,
        content: { version: 1, classification, revision: 1, url: initial },
      }),
    });

    const services = await invoke("browser_services", { target });
    assert.deepEqual(services.target, target);
    assert.equal(services.mutated, false);
    const service = services.data.find(({ url }) => url === address + "/");
    assert.ok(service);
    assert.equal(service.workerId, workerId);
    assert.equal(service.title, "Managed MCP fixture site");

    view = await RemoteSurfaceWorkerLink.connect({
      origin,
      call,
      workerId,
      surfaceId: id,
      viewport: { width: 640, height: 480, devicePixelRatio: 1 },
      route: "relay",
      onFrame() {},
    });
    const visit = (url) =>
      eventually(
        () =>
          visits.some(
            (entry) => entry.url === url && /HeadlessChrome/u.test(entry.agent),
          ),
        (loaded) => assert.ok(loaded, "Expected Chromium to load " + url),
      );
    await visit("/first");
    const getBrowser = async () => {
      const row = (await call("GET", browsers, 200)).find(
        (entry) => entry.id === id,
      );
      assert.ok(row);
      return row;
    };
    const before = await getBrowser();
    const url = address + "/nested/../second?q=café#fragment";
    const normalized = new URL(url).href;
    const navigate = async (args, error) => {
      const [result] = await managedMcpTurn(attachment, [
        {
          name: "browser_navigate",
          args,
          error,
          afterInvoke: () =>
            approveManagedMcpTool({
              call,
              eventually,
              chatId,
              ownerId,
              keyRevision,
              interactionKey,
              expectedTool: /browser[_ ]navigate|Navigate a Cantrip browser/iu,
            }),
        },
      ]);
      return result;
    };
    const navigated = await navigate({ target, url });
    assert.deepEqual(navigated.target, target);
    assert.equal(navigated.mutated, true);
    assert.deepEqual(navigated.data, {
      url: normalized,
      stateRevision: before.stateRevision + 1,
    });
    const next = new URL(normalized);
    await visit(next.pathname + next.search);
    const persisted = await getBrowser();
    assert.equal(persisted.stateRevision, navigated.data.stateRevision);
    assert.ok(!JSON.stringify(persisted).includes(normalized));
    const opened = await decryptSurfacePrivateState({
      ...location,
      opaque: persisted.stateProtection,
    });
    assert.equal(opened.url, normalized);
    assert.equal(opened.revision, persisted.stateRevision);

    await navigate(
      {
        target: { ...target, projectId: randomUUID() },
        url: initial,
      },
      /target cannot receive protected operations/iu,
    );
    const settings = await eventually(
      () => call("GET", chatUrl + "/native-settings", 200),
      (state) => assert.ok(state.binding && state.effective),
    );
    await call("PATCH", chatUrl + "/permission-profile", 200, {
      id: ":read-only",
      bindingId: settings.binding.bindingId,
      expectedRevision: settings.permissionPolicy?.revision ?? "0",
      operationId: randomUUID(),
    });
    await eventually(
      () => call("GET", chatUrl + "/native-settings", 200),
      (state) =>
        assert.equal(state.permissionPolicy?.effectiveId, ":read-only"),
    );
    await managedMcpTurn(attachment, [
      {
        name: "browser_services",
        args: { target },
        async verify(readOnly) {
          assert.ok(readOnly.data.some(({ url }) => url === address + "/"));
          const rpc = await managedMcpRpc(data);
          const { tools } = await rpc("tools/list");
          assert.ok(!tools.some(({ name }) => name === "browser_navigate"));
          const denied = await rpc("tools/call", {
            name: "browser_navigate",
            arguments: { target, url: initial },
          });
          assert.equal(denied.isError, true);
          assert.equal(
            (await getBrowser()).stateRevision,
            persisted.stateRevision,
          );
        },
      },
    ]);
    assert.equal(view.failure, undefined);
    console.log(
      JSON.stringify({ suite: "native-managed-mcp-browser", passed: true }),
    );
  } finally {
    try {
      await view?.close();
    } finally {
      await new Promise((resolve) => {
        site.close(resolve);
        site.closeAllConnections();
      });
    }
  }
}
