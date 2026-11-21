import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rename, symlink } from "node:fs/promises";
import path from "node:path";
import { ExplorerFileImports } from "../../tests/reference-node-worker/src/explorer-file-imports.ts";

const pageSize = 256 * 1024;
const content = Buffer.concat([
  Buffer.alloc(pageSize, 0xea),
  Buffer.from([0, 255, 192, 10]),
]);
const request = {
  type: "explorer.file.import",
  path: "drop",
  name: "café.md",
  size: content.length,
};
const first = {
  ...request,
  offset: 0,
  data: content.subarray(0, pageSize).toString("base64"),
  eof: false,
};
const last = {
  ...request,
  offset: pageSize,
  data: content.subarray(pageSize).toString("base64"),
  eof: true,
};
const cancel = { type: "explorer.file.import.cancel" };

function imported(outcome) {
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.result.type, "explorer.file.imported");
  return outcome.result.value;
}

function refused(outcome, error) {
  assert.equal(outcome.ok, false, JSON.stringify(outcome));
  assert.match(outcome.error, error);
}

export async function verifyHostFileImports({ checkout, send, restartWorker }) {
  const drop = path.join(checkout, request.path);
  const oracleRoot = path.join(checkout, "oracle");
  await mkdir(drop);
  await mkdir(path.join(oracleRoot, request.path), { recursive: true });
  const legacy = new ExplorerFileImports();
  const operationId = crypto.randomUUID();
  const invoke = (operationId, sequence, request) =>
    send(request, { operationId, sequence });
  try {
    const start = await legacy.write("oracle", oracleRoot, 0, first);
    assert.deepEqual(imported(await invoke(operationId, 0, first)), start);
    assert.deepEqual(await readdir(drop), []);
    const result = imported(await invoke(operationId, 1, last));
    const oracle = await legacy.write("oracle", oracleRoot, 1, last);
    assert.deepEqual(
      { ...result, entry: { ...result.entry, modifiedAt: undefined } },
      { ...oracle, entry: { ...oracle.entry, modifiedAt: undefined } },
    );
    assert.deepEqual(await readFile(path.join(drop, request.name)), content);
  } finally {
    await legacy.dispose();
  }

  const empty = (name) => ({ ...first, name, size: 0, data: "", eof: true });
  refused(await send(empty(request.name)), /already exists/u);
  assert.deepEqual(await readFile(path.join(drop, request.name)), content);
  await symlink(path.join(drop, "missing"), path.join(drop, "link"));
  refused(await send(empty("link")), /already exists/u);
  const race = await Promise.all([send(empty("race")), send(empty("race"))]);
  assert.equal(race.filter((outcome) => outcome.ok).length, 1);
  refused(
    race.find((outcome) => !outcome.ok),
    /already exists/u,
  );
  assert.equal((await readFile(path.join(drop, "race"))).length, 0);
  for (const malformed of [{ offset: 1 }, { size: content.length + 1 }]) {
    const id = crypto.randomUUID();
    imported(await invoke(id, 0, { ...first, name: "rejected" }));
    refused(
      await invoke(id, 1, { ...last, name: "rejected", ...malformed }),
      /destination or offset changed/u,
    );
  }
  const moved = crypto.randomUUID();
  imported(await invoke(moved, 0, { ...first, name: "moved" }));
  await rename(drop, drop + "-old");
  await mkdir(drop);
  refused(
    await invoke(moved, 1, { ...last, name: "moved" }),
    /destination folder moved/u,
  );
  assert.deepEqual(await readdir(drop), []);
  await symlink(path.dirname(checkout), path.join(checkout, "external"));
  refused(await send({ ...empty("escaped"), path: "external" }), /outside/u);

  const active = Array.from({ length: 16 }, () => crypto.randomUUID());
  for (const id of active) imported(await invoke(id, 0, first));
  refused(await send(first), /Too many file imports/u);
  assert.deepEqual(imported(await invoke(active[0], 1, cancel)), {
    offset: 0,
    entry: null,
  });
  assert.deepEqual(await readdir(drop), []);
  const lost = crypto.randomUUID();
  imported(await invoke(lost, 0, first));
  await restartWorker();
  assert.deepEqual(await readdir(drop), []);
  const final = imported(await send(empty("after-restart")));
  assert.equal(final.entry.size, 0);
  assert.deepEqual(await readdir(drop), ["after-restart"]);

  // JS Buffer accepts nonzero trailing padding bits in validated Base64.
  const rootFile = imported(
    await send({ ...empty("root.bin"), path: "", size: 1, data: "/x==" }),
  );
  assert.equal(rootFile.entry.path, "root.bin");
  assert.deepEqual(
    await readFile(path.join(checkout, "root.bin")),
    Buffer.from([255]),
  );
}
