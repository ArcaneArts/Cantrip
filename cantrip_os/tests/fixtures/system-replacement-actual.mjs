import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const script =
  "printf 'started\\n' >> /var/lib/cantrip-system-starts; exec sleep infinity";
export const originalBytes = Buffer.from([0, 255, 65, 10, 1, 2, 3, 66]);
export const checkpointBytes = Buffer.from([0, 255, 1, 2, 10, 65, 66, 67]);
export const sha = (data) => createHash("sha256").update(data).digest("hex");

export async function actualLab(directory, host, hostModule) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const config = join(directory, "docker-config");
  await mkdir(config, { mode: 0o700 });
  await writeFile(join(config, "config.json"), '{"auths":{}}', { mode: 0o600 });
  const engine = await host.LocalDocker.current(),
    request = engine.request.bind(engine),
    containers = new Set(),
    volumes = new Set(),
    images = new Set(),
    testNames = new Set(),
    cleanupProof = [];
  async function command(args, input) {
    const child = spawn("docker", ["--config", config, ...args], {
      env: { ...process.env, DOCKER_CONTEXT: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out = [],
      err = [];
    child.stdout.on("data", (b) => out.push(b));
    child.stderr.on("data", (b) => err.push(b));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    const [code] = await once(child, "close");
    const value = {
      code,
      stdout: Buffer.concat(out).toString(),
      stderr: Buffer.concat(err).toString(),
    };
    assert.equal(code, 0, JSON.stringify({ args, ...value }).slice(-4000));
    return value.stdout;
  }
  const base = await request(
    "GET",
    `/images/${encodeURIComponent(process.env.CANTRIP_OS_SYSTEM_TEST_IMAGE ?? "debian:trixie-slim")}/json`,
  );
  await writeFile(
    join(directory, "engine.json"),
    JSON.stringify(await request("GET", "/version"), null, 2),
  );
  const event = (name, data) =>
    appendFile(
      join(directory, "events.log"),
      "QA_EVT " + JSON.stringify({ event: name, data }) + "\n",
    );
  async function create({
    image = base.Id,
    name = `cantrip-replace-${randomUUID().slice(0, 12)}`,
    counter = true,
    volume = true,
  } = {}) {
    const volumeName = name + "-data";
    testNames.add(name);
    if (volume) {
      await request("POST", "/volumes/create", {
        Name: volumeName,
        Labels: { "io.cantrip.os.test": name },
      });
      volumes.add(volumeName);
    }
    const body = {
      Image: image,
      Labels: { "io.cantrip.os": "foundation", "io.cantrip.os.test": name },
      Env: ["PRIVATE_RUNTIME_OVERRIDE=retained"],
      HostConfig: {
        RestartPolicy: { Name: "always", MaximumRetryCount: 0 },
        Mounts: volume
          ? [{ Type: "volume", Source: volumeName, Target: "/workspace" }]
          : [],
      },
    };
    if (counter) body.Cmd = ["sh", "-c", script];
    const value = await request(
      "POST",
      `/containers/create?name=${name}`,
      body,
    );
    containers.add(value.Id);
    await request("POST", `/containers/${value.Id}/start`);
    return { id: value.Id, name, volume: volume ? volumeName : null };
  }
  async function install(id, pkg) {
    await command([
      "exec",
      id,
      "sh",
      "-c",
      `set -eu; apt-get update >/dev/null; apt-get install -y --no-install-recommends ${pkg} >/dev/null; apt-get clean; rm -rf /var/lib/apt/lists/*; dpkg-query -W -f='\${Version}' ${pkg}`,
    ]);
  }
  async function marker(id, bytes) {
    await command(
      [
        "exec",
        "-i",
        id,
        "sh",
        "-c",
        "set -eu; cat > /etc/cantrip-system-雪; chmod 640 /etc/cantrip-system-雪; chown 12345:23456 /etc/cantrip-system-雪",
      ],
      bytes,
    );
  }
  async function original({ image, counter = true } = {}) {
    const value = await create({ image, counter });
    await install(value.id, "bc");
    await marker(value.id, originalBytes);
    await command([
      "exec",
      value.id,
      "sh",
      "-c",
      "printf 'newer-root\\n' > /etc/cantrip-newer-root; printf 'workspace-before\\n' > /workspace/marker",
    ]);
    return value;
  }
  async function checkpoint() {
    const { CantripOsSystemCheckpointManager } =
      await import("../../../cantrip_worker/dist/os-executor/system-checkpoints.js");
    const { sealPrivateSystem } =
      await import("../../../cantrip_worker/dist/os-executor/private-system-file.js");
    const source = await create();
    await install(source.id, "ed");
    await marker(source.id, checkpointBytes);
    await command([
      "exec",
      source.id,
      "sh",
      "-c",
      "printf 'excluded-source-mount\\n' > /workspace/marker",
    ]);
    const context = {
      ownerId: "fixture-owner",
      serverId: "fixture-server",
      workerId: "fixture-worker",
      instanceId: randomUUID(),
      guestInstanceId: randomUUID(),
      attachmentGeneration: randomUUID(),
      targetGeneration: randomUUID(),
      operationId: randomUUID(),
      checkpointId: randomUUID(),
      containerId: source.id,
    };
    const key = randomBytes(32),
      keys = {
        ownerId: () => context.ownerId,
        serverIdentity: () => context.serverId,
        componentKey: (_scope, revision = 1) => {
          assert.equal(revision, 1);
          return { key: new Uint8Array(key), keyRevision: 1 };
        },
      };
    const admission = { context, container: source.name, resumeOriginal: true };
    const manager = new CantripOsSystemCheckpointManager(
      directory,
      context.workerId,
      keys,
      { docker: async () => engine, seal: sealPrivateSystem },
    );
    assert.equal((await manager.run(admission, "execute")).state, "ready");
    const path = join(directory, "authenticated-system.tar"),
      opened = await manager.open(admission, path);
    images.add(opened.manifest.snapshot.imageId);
    await writeFile(
      join(directory, "checkpoint.json"),
      JSON.stringify(
        { admission, key: key.toString("base64"), ...opened },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    await request("DELETE", `/containers/${source.id}?force=true`);
    containers.delete(source.id);
    await request("DELETE", `/volumes/${source.volume}`);
    volumes.delete(source.volume);
    await request(
      "DELETE",
      `/images/${encodeURIComponent(opened.manifest.snapshot.imageId)}`,
    );
    return {
      source: {
        kind: "checkpoint",
        imageId: opened.manifest.snapshot.imageId,
        operationId: context.operationId,
        requestSha256: opened.manifest.snapshot.requestSha256,
        containerId: context.containerId,
      },
      instanceId: context.instanceId,
      archive: {
        path,
        bytes: opened.receipt.archiveBytes,
        sha256: opened.receipt.archiveSha256,
      },
      ...opened,
    };
  }
  async function hold(input, hold, holdId, caseDirectory) {
    const trace = join(caseDirectory, "child-trace.jsonl"),
      marker = join(caseDirectory, "held.json"),
      path = join(caseDirectory, "child.json");
    await writeFile(
      path,
      JSON.stringify({ input, hold, holdId, hostModule, trace, marker }),
      { mode: 0o600 },
    );
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL("./system-replacement-child.mjs", import.meta.url),
        ),
        path,
      ],
      { env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    child.stdout.on("data", (b) => {
      void appendFile(join(caseDirectory, "child.log"), b);
    });
    child.stderr.on("data", (b) => {
      void appendFile(join(caseDirectory, "child.log"), b);
    });
    try {
      const value = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error("The actual operation did not reach its held point"),
            ),
          240_000,
        );
        child.once("message", (v) => {
          clearTimeout(timer);
          resolve(v);
        });
        child.once("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Child ended before held reply: ${code}`));
        });
      });
      assert.equal(value.held, hold, JSON.stringify(value));
      await event(
        "actual-reply-held",
        JSON.parse(await readFile(marker, "utf8")),
      );
      const closed = once(child, "close");
      child.kill("SIGKILL");
      const [code, signal] = await closed;
      assert.equal(code, null);
      assert.equal(signal, "SIGKILL");
      return (await readFile(trace, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close");
        child.kill("SIGKILL");
        await closed;
      }
    }
  }
  async function cleanup() {
    const proof = [];
    for (const name of testNames) {
      const filters = encodeURIComponent(
        JSON.stringify({ label: [`io.cantrip.os.test=${name}`] }),
      );
      for (const value of await request(
        "GET",
        `/containers/json?all=1&filters=${filters}`,
      ))
        containers.add(value.Id);
      for (const value of await request(
        "GET",
        `/images/json?filters=${filters}`,
      ))
        images.add(value.Id);
    }
    for (const id of containers) {
      try {
        await request("DELETE", `/containers/${id}?force=true`);
      } catch (e) {
        if (e.status !== 404) throw e;
      }
      try {
        await request("GET", `/containers/${id}/json`);
        throw new Error("Owned test container remains");
      } catch (e) {
        assert.equal(e.status, 404);
      }
      proof.push({ container: id, status: 404 });
    }
    for (const id of images) {
      try {
        await request("DELETE", `/images/${encodeURIComponent(id)}`);
      } catch (e) {
        if (e.status !== 404) throw e;
      }
      try {
        await request("GET", `/images/${encodeURIComponent(id)}/json`);
        throw new Error("Owned test image remains");
      } catch (e) {
        assert.equal(e.status, 404);
      }
      proof.push({ image: id, status: 404 });
    }
    for (const name of volumes) {
      await request("DELETE", `/volumes/${name}`);
      try {
        await request("GET", `/volumes/${name}`);
        throw new Error("Owned test volume remains");
      } catch (e) {
        assert.equal(e.status, 404);
      }
      proof.push({ volume: name, status: 404 });
    }
    cleanupProof.push(...proof);
    await writeFile(
      join(directory, "cleanup.json"),
      JSON.stringify(cleanupProof, null, 2),
    );
    containers.clear();
    volumes.clear();
    images.clear();
    testNames.clear();
  }
  return {
    directory,
    engine,
    request,
    command,
    event,
    base,
    create,
    original,
    checkpoint,
    hold,
    marker,
    containers,
    volumes,
    images,
    cleanup,
  };
}
