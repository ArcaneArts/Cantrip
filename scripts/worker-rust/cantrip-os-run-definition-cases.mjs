// Rust services and the packaged guest helper. The old helper is a read-only
// oracle for the response and definition bytes used by saved projects.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { cantripOsRunDefinitionRequestSchema } from "../../packages/protocol/dist/index.js";

const executable = "/usr/lib/cantrip-os-executor/cantrip-os-run-definitions";
const legacy = "/usr/lib/cantrip-os-executor/run-definitions.mjs";

export async function verifyRunDefinitions({
  call,
  route,
  binding,
  target,
  workspace,
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
  runPlan,
  runRuntime,
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
  const compare =
    (await guest(
      "/bin/sh",
      "-c",
      'if test -f "$1"; then printf yes; fi',
      "fixture",
      legacy,
    )) === "yes";
  const oracle = async (request) =>
    JSON.parse(
      await guest(
        "/bin/sh",
        "-c",
        'printf "%s\n" "$1" | /usr/bin/node "$3" "$2"',
        "run-definition-oracle",
        JSON.stringify(request),
        binding.guestPath,
        legacy,
      ),
    );

  const initial = request("list");
  const empty = await definition(initial);
  assert.equal(empty.source.bindingId, binding.id);
  assert.deepEqual(empty.result.inventory.entries, []);
  if (compare) assert.deepEqual(empty.result, await oracle(initial));
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
  const read = (await definition(get)).result;
  assert.deepEqual(read.result, { found: true, entry });
  if (compare) assert.deepEqual(read, await oracle(get));
  const list = request("list");
  const inventory = (await definition(list)).result;
  assert.deepEqual(inventory.inventory.entries, [entry]);
  if (compare) assert.deepEqual(inventory, await oracle(list));
  assert.equal(await guest("stat", "-c", "%u", filename), String(actual.uid));
  const validate = request("validate", { document: entry.document });
  const validated = (await definition(validate)).result;
  assert.equal(validated.validation.valid, true);
  if (compare) assert.deepEqual(validated, await oracle(validate));

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
  const absent = (await definition(after)).result;
  assert.deepEqual(absent.result, { found: false, id: configurationId });
  if (compare) assert.deepEqual(absent, await oracle(after));
  if (runPlan) {
    const { verifyRunPlan } = await import("./cantrip-os-run-plan-cases.mjs");
    await verifyRunPlan({
      definition,
      request,
      binding,
      target,
      workspace,
      os,
      actual,
      data,
      workerId,
      serverId,
      docker,
      container,
    });
  }
  if (runRuntime) {
    const { verifyGuestRuns } =
      await import("./cantrip-os-run-runtime-cases.mjs");
    await verifyGuestRuns({
      call,
      definition,
      request,
      binding,
      target,
      os,
      actual,
      data,
      serverId,
      hash,
      docker,
      container,
      ...runRuntime,
    });
  }
  console.log(
    `Native Linux Run definitions passed: package upgrade, revision guards and observation after worker restart${compare ? ", with Node read parity" : ""}.`,
  );
}
