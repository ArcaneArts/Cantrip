import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import path from "node:path";
import { decryptCantripOsSystemOperationResult } from "../../packages/crypto/dist/index.js";
import {
  sealPrivateSystem,
  verifyPrivateSystem,
} from "../../cantrip_worker/src/os-executor/private-system-file.ts";

async function carrier(root, socket, container) {
  const endpoint = new URL(socket);
  assert.equal(endpoint.protocol, "unix:");
  const proxyPath = path.join(root, "system-docker.sock");
  const effects = [];
  const transitions = [];
  let dropped = false;
  let cutExport = false;
  let dropTransition;
  const proxy = createServer((incoming, response) => {
    const url = new URL(incoming.url, "http://docker");
    const decoded = decodeURIComponent(url.pathname);
    const commit =
      decoded.endsWith("/commit") &&
      url.searchParams.get("container") === container;
    const transition = /\/containers\/([^/]+)\/(stop|start)$/u.exec(decoded);
    if (commit) effects.push("commit");
    if (transition?.[1] === container) effects.push(transition[2]);
    const exporting = /\/images\/sha256:[a-f0-9]{64}\/get$/u.test(decoded);
    if (exporting) effects.push("export");
    const mutation =
      incoming.method === "POST" &&
      /\/(load|create|rename|start|stop|update)$/u.exec(decoded)?.[1];
    if (mutation) transitions.push(mutation);
    const upstream = request(
      {
        socketPath: decodeURIComponent(endpoint.pathname),
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
      },
      (reply) => {
        if (commit && reply.statusCode === 201 && !dropped) {
          dropped = true;
          reply.once("end", () => response.destroy());
          reply.resume();
          return;
        }
        if (
          mutation &&
          mutation === dropTransition &&
          (reply.statusCode === 200 || reply.statusCode === 201)
        ) {
          dropTransition = undefined;
          reply.once("end", () => response.destroy());
          reply.resume();
          return;
        }
        reply.once("error", () => response.destroy());
        response.writeHead(reply.statusCode, reply.headers);
        if (exporting && cutExport && reply.statusCode === 200) {
          cutExport = false;
          reply.once("data", (first) => {
            response.write(first, () => response.destroy());
          });
          return;
        }
        reply.pipe(response);
      },
    );
    upstream.once("error", () => response.destroy());
    response.once("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  proxy.listen(proxyPath);
  await once(proxy, "listening");
  return {
    endpoint: "unix://" + proxyPath,
    effects,
    transitions,
    dropMutation: (mutation) => {
      dropTransition = mutation;
    },
    interruptExport: () => {
      cutExport = true;
    },
    close: () =>
      new Promise((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

export async function verifyCantripOsSystemCapture({
  call,
  os,
  docker,
  container,
  name,
  root,
  data,
  scopeKey,
  repositoryKey,
  image,
  replacement,
  restartWorker,
}) {
  // Reuse the attached guest's identity on a tiny fixture so Docker export
  // verifies the actual carrier without copying the full guest base image.
  const config = path.join(root, "executor.json");
  const identity = path.join(root, "instance.json");
  await docker("cp", `${container}:/etc/cantrip-os/executor.json`, config);
  const { state_dir: stateDir } = JSON.parse(await readFile(config, "utf8"));
  await docker("cp", `${container}:${stateDir}/instance.json`, identity);
  await docker("rename", container, name + "-placement");
  const ids = [];
  const replacements = [];
  const spareImages = [];
  let target, proxy;
  try {
    const bind = path.join(root, "fixture-bind");
    await mkdir(bind);
    await writeFile(path.join(bind, "retained"), "host-bind");
    target = await docker(
      "run",
      "--detach",
      "--pull=never",
      "--network",
      "none",
      "--label",
      "io.cantrip.os=foundation",
      "--mount",
      "type=volume,dst=/fixture-mount",
      ...(replacement
        ? ["--mount", `type=bind,source=${bind},dst=/fixture-bind,readonly`]
        : []),
      "--name",
      name,
      image,
      "sleep",
      "7200",
    );
    await docker("exec", target, "mkdir", "-p", "/etc/cantrip-os", stateDir);
    await docker("cp", config, `${target}:/etc/cantrip-os/executor.json`);
    await docker("cp", identity, `${target}:${stateDir}/instance.json`);
    await docker(
      "exec",
      target,
      "sh",
      "-c",
      "printf A > /fixture-system-data && printf one > /fixture-mount/private",
    );
    const socket =
      process.env.DOCKER_HOST ||
      (await docker(
        "context",
        "inspect",
        "--format",
        "{{.Endpoints.docker.Host}}",
      ));
    proxy = await carrier(root, socket, target);
    await restartWorker(proxy.endpoint);

    const instance = `/api/cantrip-os/${os.id}`;
    const status = () => call("GET", instance + "/system");
    const operations = instance + "/system-operations";
    const fence = ({ attachmentGeneration, targetGeneration }) => ({
      attachmentGeneration,
      targetGeneration,
    });
    const create = async () => {
      const current = await status();
      assert.equal(current.target?.running, true, JSON.stringify(current));
      const operationId = randomUUID();
      ids.push(operationId);
      return call("POST", operations, {
        attachmentGeneration: current.target.attachmentGeneration,
        targetGeneration: current.target.generation,
        operationId,
        action: "capture",
        resumeOriginal: true,
      });
    };
    const journal = (id) =>
      path.join(data, "cantrip-os-system-checkpoints", scopeKey, id + ".json");
    const read = async (file) => JSON.parse(await readFile(file, "utf8"));
    const open = (cap) =>
      decryptCantripOsSystemOperationResult({
        context: cap.context,
        componentKey: repositoryKey,
        keyRevision: 1,
        envelope: cap.protectedResult,
      });
    const archiveKeys = (context) => ({
      ownerId: () => context.ownerId,
      serverIdentity: () => context.serverId,
      componentKey: () => ({ keyRevision: 1, key: repositoryKey.slice() }),
    });

    const uncertain = await create();
    assert.equal(uncertain.state, "unknown", JSON.stringify(uncertain));
    assert.equal(uncertain.phase, "capture-captured");
    assert.deepEqual(proxy.effects, ["stop", "commit"]);
    const file = journal(uncertain.operationId);
    const host = await read(file + ".docker");
    assert.equal(host.snapshot.evidence, "observed-labeled-image");
    assert.equal(
      await docker("inspect", "--format", "{{.State.Running}}", target),
      "false",
    );

    await restartWorker(proxy.endpoint);
    const url = operations + "/" + uncertain.operationId;
    assert.equal((await call("POST", url + "/observe")).state, "unknown");
    assert.deepEqual(proxy.effects, ["stop", "commit"]);

    const context = (await read(file)).admission.context;
    const sha256 = (value) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    assert.equal(host.request.scopeKey, sha256(context));
    assert.equal(host.requestSha256, sha256(host.request));
    const nodeTar = path.join(root, "node-system.tar");
    await docker("image", "save", "--output", nodeTar, host.snapshot.imageId);
    const nodeReceipt = await sealPrivateSystem({
      context,
      keys: archiveKeys(context),
      destination: file + ".ctos-system",
      manifest: { version: 1, snapshot: host.snapshot },
      archive: createReadStream(nodeTar),
    });
    const resumed = await call("POST", url + "/continue", fence(uncertain));
    assert.equal(resumed.state, "ready", JSON.stringify(resumed));
    assert.deepEqual(proxy.effects, ["stop", "commit", "start"]);
    assert.deepEqual((await open(resumed)).capture.archive, nodeReceipt);
    assert.equal(
      await docker("inspect", "--format", "{{.State.Running}}", target),
      "true",
    );

    proxy.interruptExport();
    const interrupted = await create();
    assert.equal(interrupted.state, "unknown", JSON.stringify(interrupted));
    assert.equal(interrupted.phase, "export-requested");
    const nativeFile = journal(interrupted.operationId);
    await assert.rejects(access(nativeFile + ".ctos-system"), {
      code: "ENOENT",
    });
    const nativeUrl = operations + "/" + interrupted.operationId;
    const observed = await call("POST", nativeUrl + "/observe");
    assert.equal(observed.state, "unknown");
    assert.deepEqual(proxy.effects, [
      "stop",
      "commit",
      "start",
      "stop",
      "commit",
      "start",
      "export",
    ]);
    const ready = await call(
      "POST",
      nativeUrl + "/continue",
      fence(interrupted),
    );
    assert.equal(ready.state, "ready", JSON.stringify(ready));
    assert.deepEqual(proxy.effects, [
      "stop",
      "commit",
      "start",
      "stop",
      "commit",
      "start",
      "export",
      "export",
    ]);
    const native = await open(ready);
    const nativeContext = (await read(nativeFile)).admission.context;
    const opened = await verifyPrivateSystem({
      context: nativeContext,
      keys: archiveKeys(nativeContext),
      source: nativeFile + ".ctos-system",
    });
    assert.deepEqual(native.capture, {
      manifest: opened.manifest,
      archive: opened.receipt,
    });
    assert.ok(opened.receipt.chunks > 1);
    assert.ok(
      opened.manifest.snapshot.mounts.some(
        (mount) =>
          mount.destination === "/fixture-mount" && mount.included === false,
      ),
    );
    assert.equal(
      await docker("inspect", "--format", "{{.State.Running}}", target),
      "true",
    );
    const discovered = await call("GET", instance + "/system");
    assert.ok(
      discovered.bases.every(
        (base) =>
          !base.tags.some((tag) =>
            ids.some((id) => tag === "cantrip-os-private-system:" + id),
          ),
      ),
    );
    if (replacement) {
      const { verifyCantripOsSystemReplacement } =
        await import("./cantrip-os-system-replacement-cases.mjs");
      await verifyCantripOsSystemReplacement({
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
      });
    }
  } finally {
    try {
      await proxy?.close();
    } finally {
      for (const id of replacements) {
        const owned = await docker(
          "ps",
          "-aq",
          "--filter",
          `label=io.cantrip.os.replacement.operation=${id}`,
        );
        for (const container of owned.split("\n").filter(Boolean)) {
          await docker("rm", "-f", "-v", container);
        }
      }
      if (target) await docker("rm", "-f", "-v", target);
      await docker("rename", container, name);
      for (const id of ids) {
        const tag = "cantrip-os-private-system:" + id;
        const known = await docker("image", "ls", "--quiet", tag);
        if (known) await docker("image", "rm", tag);
      }
      for (const tag of spareImages) await docker("image", "rm", tag);
    }
  }
}
