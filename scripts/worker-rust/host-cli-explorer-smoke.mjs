import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  encryptPrivateDisplayLabel,
  encryptSurfacePrivateState,
} from "../../packages/crypto/dist/index.js";

export async function verifyHostCliExplorer({
  call,
  core,
  run,
  cli,
  connection,
  terminalId,
  projectId,
  ownerId,
  checkout,
  workerDirectory,
  surfaceKey,
  metadataKey,
  serverId,
}) {
  const id = randomUUID();
  const titleProtection = await encryptPrivateDisplayLabel({
    ownerId,
    recordKind: "explorer",
    rowId: id,
    keyRevision: 1,
    componentKey: metadataKey,
    label: "Native CLI Explorer",
  });
  const stateProtection = await encryptSurfacePrivateState({
    ownerId,
    context: {
      serverId,
      resource: "explorer-row",
      resourceId: id,
      operationId: null,
      recordKind: "explorer-state",
    },
    keyRevision: 1,
    componentKey: surfaceKey,
    content: {
      version: 1,
      classification: { recordKind: "explorer-state" },
      selectedPath: null,
    },
  });
  const created = await call("POST", `/api/projects/${projectId}/explorers`, {
    id,
    titleProtection,
    stateProtection,
    attachToTabLayout: false,
  });
  assert.equal(created.status, 201, JSON.stringify(created));

  const directory = "cli-protected-explorer-fixture";
  const file = `${directory}/private-note.md`;
  const original = "A🛠 native CLI text\n";
  const replacement = "Replacement text from the native CLI 🔐";
  await mkdir(path.join(checkout, directory));
  await writeFile(path.join(checkout, file), original);
  await writeFile(path.join(checkout, directory, "second.txt"), "second file");

  const { CantripCliBroker } =
    await import("../../tests/reference-node-worker/src/cli-broker.ts");
  const relayed = [];
  const oracle = new CantripCliBroker(
    {
      dataDirectory: path.join(
        path.dirname(workerDirectory),
        "oracle-explorer-cli",
      ),
      serverUrl: connection.serverUrl,
      workerId: connection.workerId,
      token: "oracle-unused",
    },
    {
      binary: cli,
      execute: async (request) => {
        relayed.push(request);
        const result = await core(request.command, request.arguments);
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.doesNotMatch(
          JSON.stringify(result.body),
          /cli-protected-explorer-fixture|native CLI text/u,
        );
        return result.body;
      },
    },
  );
  oracle.setSurfacePrivateStateService({
    ownerId: () => ownerId,
    componentKey: () => ({ key: Uint8Array.from(surfaceKey), keyRevision: 1 }),
  });
  const request = async (broker, command, arguments_) => {
    const response = await fetch(broker.endpoint + "/v1/execute", {
      method: "POST",
      headers: {
        authorization: "Bearer " + broker.sessionToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command,
        context: { terminalId, selection: "lane" },
        arguments: { target: id, ...arguments_ },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  };
  const savedEnvironment = {
    PATH: process.env.PATH,
    CANTRIP_CLI_CONNECTION: process.env.CANTRIP_CLI_CONNECTION,
  };
  try {
    const reference = await oracle.start();
    const list = { path: directory, limit: 1, cursor: "1" };
    const actual = await request(connection, "explorer.list", list);
    assert.deepEqual(actual, await request(reference, "explorer.list", list));
    assert.equal(actual.data.entries.length, 1);
    assert.equal(actual.data.cursor, 1);

    const read = { path: file, maxChars: 2 };
    const trimmed = await request(connection, "explorer.read", read);
    assert.deepEqual(trimmed, await request(reference, "explorer.read", read));
    assert.equal(trimmed.data.content, original.slice(0, 2));
    assert.equal(trimmed.data.truncated, true);
    assert.doesNotMatch(
      JSON.stringify(relayed),
      /cli-protected-explorer-fixture|private-note\.md/u,
    );
  } finally {
    await oracle.close();
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  await run(
    [
      "set -e",
      `cantrip --json explorer list --target '${id}' '${directory}' > .cantrip-fixture-explorer-list`,
      `cantrip --json explorer read --target '${id}' '${file}' > .cantrip-fixture-explorer-read`,
      `printf '%s' '${replacement}' | cantrip --json explorer write --target '${id}' '${file}' > .cantrip-fixture-explorer-write`,
    ].join("\n"),
  );
  const readResult = async (kind) =>
    JSON.parse(
      await readFile(
        path.join(checkout, `.cantrip-fixture-explorer-${kind}`),
        "utf8",
      ),
    );
  const listed = await readResult("list");
  assert.equal(listed.target.surfaceId, id);
  assert.deepEqual(listed.data.entries.map(({ name }) => name).sort(), [
    "private-note.md",
    "second.txt",
  ]);
  const first = await readResult("read");
  assert.equal(first.data.content, original);
  const written = await readResult("write");
  assert.equal(written.target.surfaceId, id);
  assert.equal(written.mutated, true);
  assert.equal(written.data.content, replacement);
  assert.notEqual(written.data.version, first.data.version);
  assert.equal(await readFile(path.join(checkout, file), "utf8"), replacement);
}
