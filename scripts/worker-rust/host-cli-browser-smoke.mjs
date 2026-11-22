import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  decryptPrivateDisplayLabel,
  decryptSurfacePrivateState,
  deriveComponentKey,
  encryptPrivateDisplayLabel,
  encryptSurfacePrivateState,
  wrapComponentKeyForWorker,
} from "../../packages/crypto/dist/index.js";
import { LiveProbe, initialize } from "../server-rust/live-sockets.mjs";

const run = promisify(execFile);

export async function verifyHostCliBrowser({
  cli,
  call,
  server,
  projectId,
  workerId,
  workerDirectory,
  checkout,
  ownerId,
  serverId,
  master,
  surfaceKey,
}) {
  assert.ok(cli, "Pass the native CLI with --cli");
  const component = "private-surface-metadata";
  const keyRevision = 1;
  const metadataKey = deriveComponentKey({
    accountMasterKey: master,
    ownerId,
    component,
    keyRevision,
  });
  const identity = JSON.parse(
    await readFile(
      path.join(workerDirectory, "worker-encryption-key.json"),
      "utf8",
    ),
  );
  const wrappedKey = await wrapComponentKeyForWorker({
    ownerId,
    workerId,
    component,
    keyRevision,
    componentKey: metadataKey,
    workerPublicKey: identity.publicKey,
  });
  const grant = await call(
    "POST",
    `/api/encryption/principals/${identity.principalId}/grants`,
    {
      component,
      keyRevision,
      wrappedKey,
    },
  );
  assert.equal(grant.status, 201, JSON.stringify(grant));
  const refreshed = await call(
    "POST",
    `/api/workers/${workerId}/encryption/refresh`,
    {
      component,
      keyRevision,
    },
  );
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed));

  const terminalId = randomUUID();
  const terminal = await call("POST", `/api/projects/${projectId}/terminals`, {
    id: terminalId,
    titleProtection: await encryptPrivateDisplayLabel({
      ownerId,
      keyRevision,
      componentKey: metadataKey,
      recordKind: "terminal",
      rowId: terminalId,
      label: "CLI fixture terminal",
    }),
    stateProtection: await encryptSurfacePrivateState({
      ownerId,
      keyRevision,
      componentKey: surfaceKey,
      context: {
        serverId,
        resource: "terminal-row",
        resourceId: terminalId,
        operationId: null,
        recordKind: "terminal-state",
      },
      content: {
        version: 1,
        classification: { recordKind: "terminal-state" },
        directory: { kind: "project-root" },
        serviceCommand: "",
      },
    }),
  });
  assert.equal(terminal.status, 201, JSON.stringify(terminal));

  async function open(url, target) {
    const args = target ? ["--target", target, url] : [url];
    const { stdout } = await run(
      cli,
      ["--json", "--context", "lane", "browser", "open", ...args],
      {
        cwd: checkout,
        env: {
          PATH: "",
          CANTRIP_TERMINAL_ID: terminalId,
          CANTRIP_CLI_CONNECTION: path.join(
            workerDirectory,
            "cli-connection.json",
          ),
        },
        timeout: 15_000,
      },
    );
    return JSON.parse(stdout);
  }

  async function verify(result, id, revision, url) {
    assert.deepEqual(result.target, {
      kind: "surface",
      projectId,
      surfaceKind: "browser",
      surfaceId: id,
    });
    assert.equal(result.mutated, true);
    assert.equal(result.data.stateRevision, revision);
    assert.doesNotMatch(JSON.stringify(result), /cli-private-/u);
    const context = {
      serverId,
      resource: "browser-row",
      resourceId: id,
      operationId: null,
      recordKind: "browser-state",
    };
    assert.deepEqual(
      await decryptSurfacePrivateState({
        ownerId,
        context,
        keyRevision,
        componentKey: surfaceKey,
        opaque: result.data.stateProtection,
      }),
      {
        version: 1,
        classification: { recordKind: "browser-state" },
        revision,
        url: new URL(url).href,
      },
    );
  }

  const live = new LiveProbe({ server, client: () => ({ cookies: [] }) });
  try {
    await live.open();
    const hello = initialize();
    hello.client.controlCapabilities = ["focus-surface"];
    live.send(hello);
    await live.message(({ type }) => type === "ready");
    await live.subscribed("fixture-cli-browser", [
      { kind: "project", projectId },
    ]);

    const firstUrl = "https://example.invalid/cli-private-create/Montréal";
    const pending = open(firstUrl);
    const frame = await Promise.race([
      live.message(({ type }) => type === "client-control-request"),
      pending.then(() =>
        assert.fail(
          "Browser creation returned without requesting client focus.",
        ),
      ),
    ]);
    const id = frame.command.surfaceId;
    assert.deepEqual(frame.command, {
      kind: "focus-surface",
      projectId,
      surfaceKind: "browser",
      surfaceId: id,
    });
    live.send({
      type: "client-control-ack",
      correlationId: frame.correlationId,
      status: "applied",
    });
    const created = await pending;
    await verify(created, id, 1, firstUrl);
    assert.equal(
      await decryptPrivateDisplayLabel({
        ownerId,
        recordKind: "browser",
        rowId: id,
        keyRevision,
        componentKey: metadataKey,
        opaque: created.data.titleProtection,
      }),
      "Browser",
    );

    const nextUrl = "https://example.invalid/cli-private-update?q=Québec";
    const updated = await open(nextUrl, id);
    await verify(updated, id, 2, nextUrl);
    await assert.rejects(
      open("file:///cli-private-file", id),
      /requires HTTP or HTTPS/u,
    );
    await assert.rejects(open(nextUrl, randomUUID()), /was not found/u);
    const saved = await call("GET", `/api/projects/${projectId}/browsers`);
    assert.equal(saved.status, 200, JSON.stringify(saved));
    assert.equal(saved.body.length, 1);
    assert.deepEqual(
      saved.body[0].stateProtection,
      updated.data.stateProtection,
    );
    assert.doesNotMatch(JSON.stringify(live.history), /cli-private-/u);
  } finally {
    metadataKey.fill(0);
    await live.close();
  }
}
