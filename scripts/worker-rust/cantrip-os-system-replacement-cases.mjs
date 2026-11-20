import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export async function verifyCantripOsSystemReplacement({
  call,
  status,
  operations,
  fence,
  open,
  ready,
  opened,
  docker,
  proxy,
  target,
  name,
  image,
  root,
  stateDir,
  config,
  restartWorker,
  replacements,
  spareImages,
}) {
  const inspect = async (id) =>
    JSON.parse(await docker("inspect", "--format", "{{json .}}", id));
  const exec = (id, ...args) => docker("exec", id, ...args);
  const roots = async (id, system, mounted) => {
    assert.equal(await exec(id, "cat", "/fixture-system-data"), system);
    assert.equal(await exec(id, "cat", "/fixture-mount/private"), mounted);
    assert.equal(await exec(id, "cat", "/fixture-bind/retained"), "host-bind");
  };
  const create = async (request, chosen, attachmentGeneration) => {
    const current = attachmentGeneration ? null : (await status()).target;
    const operationId = randomUUID();
    if (request.action === "replace") replacements.push(operationId);
    return call("POST", operations, {
      operationId,
      ...request,
      attachmentGeneration:
        attachmentGeneration ?? current.attachmentGeneration,
      targetGeneration: chosen?.targetGeneration ?? current.generation,
      startTarget: true,
    });
  };
  const control = (operation, action) =>
    call(
      "POST",
      operations + "/" + operation.operationId + "/" + action,
      action === "observe" ? undefined : fence(operation),
    );
  const observeAfterRestart = async (operation) => {
    await restartWorker(proxy.endpoint);
    const sent = [...proxy.transitions];
    const observed = await control(operation, "observe");
    assert.equal(observed.state, "unknown", JSON.stringify(observed));
    assert.deepEqual(proxy.transitions, sent);
  };
  const exact = async (operation) => {
    assert.equal(operation.state, "ready", JSON.stringify(operation));
    const outcome = await open(operation);
    const target = operation.root.targetContainerId;
    const actual = await inspect(name);
    assert.equal(actual.Id, target);
    assert.equal(actual.State.Running, true);
    assert.equal(operation.root.runtimeHandlesRestored, false);
    assert.equal(outcome.replacement.operation.targetContainerId, target);
    assert.equal(
      outcome.replacement.operation.requestSha256,
      operation.root.requestSha256,
    );
    return target;
  };
  const stopped = async (id) => {
    const actual = await inspect(id);
    assert.equal(actual.State.Running, false);
    assert.equal(actual.HostConfig.RestartPolicy.Name, "no");
  };

  await exec(
    target,
    "sh",
    "-c",
    "printf B > /fixture-system-data && printf two > /fixture-mount/private",
  );
  await docker("image", "rm", opened.manifest.snapshot.imageId);
  proxy.dropMutation("load");
  const start = proxy.transitions.length;
  const uncertain = await create({
    action: "replace",
    source: { kind: "checkpoint", operationId: ready.operationId },
  });
  assert.equal(uncertain.state, "unknown", JSON.stringify(uncertain));
  assert.equal(uncertain.phase, "load-requested");
  assert.deepEqual(proxy.transitions.slice(start), ["load"]);
  const loaded = JSON.parse(
    await docker(
      "image",
      "inspect",
      "--format",
      "{{json .}}",
      opened.manifest.snapshot.imageId,
    ),
  );
  assert.equal(loaded.Id, opened.manifest.snapshot.imageId);
  await roots(target, "B", "two");
  await observeAfterRestart(uncertain);
  const restored = await control(uncertain, "continue");
  const restoredId = await exact(restored);
  assert.notEqual(restoredId, target);
  assert.equal(restored.root.originalContainerId, target);
  assert.equal(restored.root.retainedContainerId, target);
  assert.equal(restored.root.guestAttachment, "owned");
  assert.deepEqual(
    proxy.transitions.slice(start).filter((effect) => effect === "load"),
    ["load"],
  );
  await stopped(target);
  await roots(restoredId, "A", "two");
  await control(restored, "recover");

  await exec(
    restoredId,
    "sh",
    "-c",
    "printf C > /fixture-system-data && printf three > /fixture-mount/private",
  );
  const rollback = await create(
    { action: "rollback", replacementOperationId: restored.operationId },
    restored,
  );
  assert.equal(await exact(rollback), target);
  await stopped(restoredId);
  await roots(target, "B", "three");
  await control(rollback, "recover");

  const baseId = await docker(
    "create",
    "--label",
    "io.cantrip.os=foundation",
    image,
    "sleep",
    "7200",
  );
  const tag = name + ":public-base";
  const instance = path.join(root, "unattached-instance.json");
  try {
    await writeFile(
      instance,
      JSON.stringify({
        version: 1,
        instance_id: randomUUID(),
        attachment: null,
      }),
    );
    // Seed the minimal unattached image through the real Docker archive API.
    const seed = await docker("start", baseId);
    assert.ok(seed);
    await exec(baseId, "mkdir", "-p", "/etc/cantrip-os", stateDir);
    await docker("cp", config, baseId + ":/etc/cantrip-os/executor.json");
    await docker("cp", instance, baseId + ":" + stateDir + "/instance.json");
    await exec(baseId, "sh", "-c", "printf factory > /fixture-system-data");
    await docker("stop", "--time", "1", baseId);
    await docker(
      "commit",
      "--change",
      "ENV CANTRIP_FIXTURE_NEW_DEFAULT=base",
      baseId,
      tag,
    );
    spareImages.push(tag);
  } finally {
    await docker("rm", "-f", "-v", baseId);
  }
  const baseImage = await docker(
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    tag,
  );
  proxy.dropMutation("create");
  const fromBase = await create({
    action: "replace",
    source: { kind: "base", imageId: baseImage },
  });
  assert.equal(fromBase.state, "unknown", JSON.stringify(fromBase));
  assert.equal(fromBase.phase, "create-requested");
  await observeAfterRestart(fromBase);
  const base = await control(fromBase, "continue");
  const factory = await exact(base);
  assert.equal(base.root.guestAttachment, "unattached");
  assert.equal(
    await exec(factory, "printenv", "CANTRIP_FIXTURE_NEW_DEFAULT"),
    "base",
  );
  await roots(factory, "factory", "three");
  await stopped(target);
  const back = await create(
    { action: "rollback", replacementOperationId: base.operationId },
    base,
    base.attachmentGeneration,
  );
  assert.equal(await exact(back), target);
  await stopped(factory);
  await roots(target, "B", "three");
  await control(back, "recover");
}
