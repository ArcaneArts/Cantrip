import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import path from "node:path";
import { observeRetainedContainer } from "../../cantrip_os/host/retained-lifecycle.mjs";

export async function proxyPowerCarrier(root, endpoint, name, container) {
  const real = new URL(endpoint);
  assert.equal(real.protocol, "unix:");
  const socketPath = path.join(root, "docker-power.sock");
  const mutations = [];
  let droppedRestart = false;
  const proxy = createServer((incoming, response) => {
    const mutation = incoming.method === "POST";
    const match =
      /^\/v1\.41\/containers\/([^/]+)\/(json|start|stop\?t=20|restart\?t=20)$/u.exec(
        incoming.url,
      );
    const target = match && decodeURIComponent(match[1]);
    const action = match && match[2].split("?")[0];
    if (
      !match ||
      (mutation
        ? action === "json" || target !== container
        : incoming.method !== "GET" ||
          action !== "json" ||
          (target !== name && target !== container))
    ) {
      response.writeHead(403).end();
      return;
    }
    if (mutation) mutations.push(action);
    const upstream = request(
      {
        socketPath: decodeURIComponent(real.pathname),
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
      },
      (reply) => {
        if (
          mutation &&
          action === "restart" &&
          reply.statusCode === 204 &&
          !droppedRestart
        ) {
          droppedRestart = true;
          reply.resume();
          response.destroy();
          return;
        }
        response.writeHead(reply.statusCode, reply.headers);
        reply.pipe(response);
      },
    );
    upstream.on("error", () => response.destroy());
    incoming.pipe(upstream);
  });
  proxy.listen(socketPath);
  await once(proxy, "listening");
  return {
    endpoint: "unix://" + socketPath,
    mutations,
    close: () =>
      new Promise((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

export async function verifyCantripOsPower({
  call,
  os,
  actual,
  docker,
  name,
  container,
  proxy,
  journalDir,
  eventually,
  restartWorker,
}) {
  const base = "/api/cantrip-os/" + os.id;
  const operations = base + "/power-operations";
  const inspect = async (id) => JSON.parse(await docker("inspect", id))[0];
  const actualState = async () => (await inspect(container)).State;
  const get = () => call("GET", base + "/power");
  const marker = actual.home + "/power-durability";
  await docker("exec", "--user", "0", container, "touch", marker);
  const target = (await get()).target;
  assert.ok(target, "Core retained the attached Docker target");
  assert.equal((await get()).observation.running, true);
  let instance = os;
  const recover = async () => {
    await eventually(async () => {
      await docker(
        "exec",
        "--user",
        "0",
        container,
        "cantrip-executor",
        "status",
      );
    });
    const result = await call("POST", base + "/recovery", {
      attachmentGeneration: instance.attachmentGeneration,
      runtimeGeneration: instance.runtimeGeneration,
    });
    assert.equal(result.recovery.kind, "runtime-changed");
    assert.equal(result.instance.guestInstanceId, instance.guestInstanceId);
    assert.notEqual(
      result.instance.runtimeGeneration,
      instance.runtimeGeneration,
    );
    instance = result.instance;
  };
  const start = async (action) => ({
    operationId: randomUUID(),
    action,
    attachmentGeneration: instance.attachmentGeneration,
    targetGeneration: (await get()).target.generation,
  });

  const stopped = await start("stop");
  const stopReceipt = await call("POST", operations, stopped);
  assert.equal(stopReceipt.state, "ready", JSON.stringify(stopReceipt));
  assert.equal(stopReceipt.completionEvidence, "acknowledged-and-observed");
  assert.equal((await get()).observation.running, false);
  const stopState = await actualState();
  assert.equal(stopState.Running, false);
  assert.equal((await call("POST", operations, stopped)).state, "ready");
  assert.equal((await actualState()).FinishedAt, stopState.FinishedAt);
  assert.deepEqual(proxy.mutations, ["stop"]);

  const startReceipt = await call("POST", operations, await start("start"));
  assert.equal(startReceipt.state, "ready", JSON.stringify(startReceipt));
  const beforeRestart = await actualState();
  assert.equal(beforeRestart.Running, true);

  await recover();
  const restart = await start("restart");
  const uncertain = await call("POST", operations, restart);
  assert.equal(uncertain.state, "unknown", JSON.stringify(uncertain));
  const afterRestart = await actualState();
  assert.equal(afterRestart.Running, true);
  assert.notEqual(afterRestart.StartedAt, beforeRestart.StartedAt);
  assert.deepEqual(proxy.mutations, ["stop", "start", "restart"]);
  const operationFile = path.join(journalDir, restart.operationId + ".json");
  const journalPath = operationFile + ".docker";
  const operation = JSON.parse(await readFile(operationFile, "utf8"));
  const admission = {
    action: restart.action,
    transport: { kind: "docker", container: name },
    powerTarget: {
      kind: "docker",
      containerId: container,
      generation: restart.targetGeneration,
    },
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(["cantrip-os.power.operation", admission]))
    .digest("hex");
  assert.deepEqual(operation.checkpoint, {
    version: 1,
    admission,
    journalPath,
  });
  assert.equal(operation.admissionFingerprint, fingerprint);
  const uncertainJournal = JSON.parse(await readFile(journalPath, "utf8"));
  assert.equal(uncertainJournal.state, "unknown");
  assert.equal(uncertainJournal.phase, "mutation-requested");

  await restartWorker();
  const observed = await call(
    "POST",
    operations + "/" + restart.operationId + "/observe",
  );
  assert.equal(observed.state, "ready", JSON.stringify(observed));
  assert.equal(observed.completionEvidence, "observed-state");
  assert.equal((await call("POST", operations, restart)).state, "ready");
  assert.equal((await actualState()).StartedAt, afterRestart.StartedAt);
  assert.deepEqual(proxy.mutations, ["stop", "start", "restart"]);
  const carrier = await observeRetainedContainer(
    { inspect },
    {
      journalPath,
      operationId: restart.operationId,
      action: restart.action,
      container: name,
      expectedContainerId: container,
    },
  );
  assert.equal(carrier.operation.after.startedAt, afterRestart.StartedAt);
  assert.equal(carrier.operation.completionEvidence, "observed-state");
  await recover();
  await docker("exec", "--user", "0", container, "test", "-f", marker);
}
