// Rust services and the packaged guest helper. The old helper is a read-only
// oracle for the response and definition bytes used by saved projects.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { cantripOsRunDefinitionRequestSchema } from "../../packages/protocol/dist/index.js";

const executable = "/usr/lib/cantrip-os-executor/cantrip-os-run-definitions";

export async function verifyRunDefinitions({
  call,
  route,
  binding,
  os,
  actual,
  data,
  workerId,
  serverId,
  hash,
  docker,
  container,
  stopWorker,
  restartWorker,
}) {
  const projectId = binding.projectId;
  const configurationId = randomUUID();
  const request = (action, fields = {}) =>
    cantripOsRunDefinitionRequestSchema.parse({
      type: "project.run-configuration-definitions." + action,
      operationId: randomUUID(),
      projectId,
      ...fields,
    });
  const definition = (request, status = 200) =>
    call(
      "POST",
      route + "/run-definitions",
      {
        runtimeGeneration: os.runtimeGeneration,
        bindingGeneration: binding.bindingGeneration,
        attachmentGeneration: os.attachmentGeneration,
        request,
      },
      status,
    );
  const guest = (...arguments_) =>
    docker("exec", "--user", String(actual.uid), container, ...arguments_);
  const oracle = async (request) =>
    JSON.parse(
      await guest(
        "/bin/sh",
        "-c",
        'printf "%s\n" "$1" | /usr/bin/node /usr/lib/cantrip-os-executor/run-definitions.mjs "$2"',
        "run-definition-oracle",
        JSON.stringify(request),
        binding.guestPath,
      ),
    );

  const initial = request("list");
  const empty = await definition(initial);
  assert.equal(empty.source.bindingId, binding.id);
  assert.deepEqual(empty.result, await oracle(initial));
  const write = request("write", {
    request: {
      document: {
        schema: "cantrip.run-configuration",
        version: 1,
        id: configurationId,
        name: "Guest 日本語",
        provider: "shell",
        target: { kind: "command", command: "printf fixture" },
      },
      expectedRevision: null,
    },
  });
  const created = await definition(write);
  assert.equal(created.result.result.outcome, "created");
  const entry = created.result.result.entry;
  const filename = `${binding.guestPath}/${entry.relativePath}`;
  const get = request("get", { configurationId });
  assert.deepEqual((await definition(get)).result, await oracle(get));
  const list = request("list");
  assert.deepEqual((await definition(list)).result, await oracle(list));
  assert.equal(await guest("stat", "-c", "%u", filename), String(actual.uid));
  const validate = request("validate", { document: entry.document });
  assert.deepEqual((await definition(validate)).result, await oracle(validate));

  // Reopen the exact native process using the durable pre-receipt state while
  // the guest retains its session. A replayed write would report already-exists.
  await stopWorker();
  const key = hash([serverId, os.ownerId, workerId, os.id, os.guestInstanceId]);
  const journal = path.join(
    data,
    "cantrip-os-operations",
    key,
    write.operationId + ".json",
  );
  const saved = JSON.parse(await readFile(journal, "utf8"));
  assert.equal(saved.state, "ready");
  assert.equal(saved.processes.length, 1);
  assert.deepEqual(saved.processes[0].argv, [executable, binding.guestPath]);
  await writeFile(
    journal,
    JSON.stringify({
      ...saved,
      state: "running",
      receipt: null,
    }) + "\n",
  );
  await restartWorker();
  assert.deepEqual(await definition(write), created);
  const recovered = JSON.parse(await readFile(journal, "utf8"));
  assert.equal(recovered.state, "ready");
  assert.deepEqual(recovered.native, saved.native);
  assert.deepEqual(recovered.processes, saved.processes);
  assert.deepEqual(recovered.receipt, saved.receipt);
  await definition(
    {
      ...write,
      request: { ...write.request, expectedRevision: entry.revision },
    },
    409,
  );

  const stale = await definition(
    request("delete", {
      request: { id: configurationId, expectedRevision: "c".repeat(64) },
    }),
  );
  assert.equal(stale.result.result.outcome, "revision-mismatch");
  const deleted = await definition(
    request("delete", {
      request: { id: configurationId, expectedRevision: entry.revision },
    }),
  );
  assert.equal(deleted.result.result.outcome, "deleted");
  const after = request("get", { configurationId });
  assert.deepEqual((await definition(after)).result, await oracle(after));
  console.log(
    "Native Linux Run definitions passed: package upgrade, Node read parity, revision guards and observation after worker restart.",
  );
}
