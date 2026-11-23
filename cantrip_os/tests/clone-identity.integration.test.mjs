import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const image = process.env.CANTRIP_OS_CLONE_TEST_IMAGE;
const docker = async (...args) =>
  (await execute("docker", args, { maxBuffer: 1024 * 1024 })).stdout.trim();
async function json(name, ...args) {
  return JSON.parse(await docker("exec", name, ...args));
}
async function running(name) {
  for (let attempt = 0; ; attempt++) {
    try {
      const value = await json(name, "cantrip-executor", "status");
      assert.equal(value.service, "running");
      return value;
    } catch (error) {
      if (attempt === 49) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
async function copyStoppedState(source, target, path) {
  // Only the small, stopped fixture accounts/state are copied. No user project
  // data or image archive is staged on the host. Keep the transfer bounded.
  const { stdout } = await execute(
    "docker",
    ["cp", `${source}:${path}/.`, "-"],
    {
      encoding: "buffer",
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  await new Promise((resolve, reject) => {
    const child = spawn("docker", ["cp", "-", `${target}:${path}/`], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let error = "";
    child.stderr.on("data", (part) => {
      error = (error + part).slice(-4096);
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(error)),
    );
    child.stdin.once("error", reject);
    child.stdin.end(stdout);
  });
}

test(
  "offline OS clones get fresh enrollment and SSH keys while the original keeps its identity",
  {
    skip: !image,
    timeout: 180_000,
  },
  async (t) => {
    const prefix = `cantrip-clone-${randomUUID()}`;
    const source = `${prefix}-source`,
      peer = `${prefix}-peer`,
      clone = `${prefix}-clone`;
    const snapshot = `${prefix}:private-copy`;
    const owned = [],
      images = [];
    let passed = false;
    t.after(async () => {
      const cleanup = await Promise.allSettled(
        owned.map(async (name) => {
          if (!passed) {
            try {
              t.diagnostic(
                `${name}: ${await docker("logs", "--tail", "20", name)}`,
              );
            } catch {
              /* Preserve the actual test error. */
            }
          }
          try {
            await docker("rm", "-fv", name);
          } catch (error) {
            if (!error.stderr?.includes("No such container")) throw error;
          }
        }),
      );
      for (const reference of images) await docker("image", "rm", reference);
      const failed = cleanup.find((entry) => entry.status === "rejected");
      if (failed) throw failed.reason;
    });
    for (const name of [source, peer]) {
      owned.push(name);
      await docker("run", "-d", "--name", name, "--shm-size=256m", image);
    }
    const owner = "clone-identity-qa-owner",
      worker = "clone-identity-qa-worker";
    const machine = (name) =>
      docker("exec", name, "dbus-uuidgen", "--get=/etc/machine-id");
    const ssh = (name) =>
      json(
        name,
        "cantrip-remote",
        "service-info",
        "identity",
        "--service",
        '{"kind":"ssh"}',
      );
    const before = {};
    for (const name of [source, peer]) {
      const status = await running(name);
      assert.equal(status.attachment, null);
      await docker("exec", name, "cantrip-executor", "attach", owner, worker);
      await docker("exec", name, "cantrip-workspaces", "create", "identity");
      const binding = await json(name, "cantrip-executor", "open", "identity");
      before[name] = {
        machine: await machine(name),
        status,
        binding,
        ssh: await ssh(name),
      };
    }
    assert.notEqual(before[source].machine, before[peer].machine);
    assert.notEqual(
      before[source].status.instance_id,
      before[peer].status.instance_id,
    );
    assert.notEqual(
      before[source].ssh.ssh_host_key,
      before[peer].ssh.ssh_host_key,
    );
    assert.match(before[source].ssh.ssh_host_key, /^ssh-ed25519 /);
    await docker(
      "exec",
      source,
      "sh",
      "-c",
      "printf 'retained workspace data\\n' > /var/lib/cantrip-os-workspaces/homes/identity/clone-proof.txt",
    );

    await docker("stop", source);
    images.push(snapshot);
    await docker(
      "commit",
      "--change",
      `LABEL io.cantrip.os.system.instance=${before[source].status.instance_id}`,
      source,
      snapshot,
    );
    owned.push(clone);
    await docker(
      "create",
      "--name",
      clone,
      "--shm-size=256m",
      "--entrypoint",
      "sh",
      snapshot,
      "-c",
      "/usr/local/sbin/cantrip-os-identity prepare-clone && exec /usr/local/sbin/cantrip-os-start",
    );
    await copyStoppedState(source, clone, "/var/lib/cantrip-os-executor");
    await copyStoppedState(source, clone, "/var/lib/cantrip-os-workspaces");
    await docker("start", clone);
    const cloneStatus = await running(clone);
    assert.equal(cloneStatus.attachment, null);
    assert.notEqual(cloneStatus.instance_id, before[source].status.instance_id);
    assert.notEqual(await machine(clone), before[source].machine);
    await docker("exec", clone, "cantrip-executor", "attach", owner, worker);
    const clonedBinding = await json(
      clone,
      "cantrip-executor",
      "open",
      "identity",
    );
    assert.notEqual(
      clonedBinding.executor_generation,
      before[source].binding.executor_generation,
    );
    const cloneSsh = await ssh(clone);
    assert.notEqual(cloneSsh.ssh_host_key, before[source].ssh.ssh_host_key);
    assert.equal(
      await docker(
        "exec",
        clone,
        "cat",
        "/var/lib/cantrip-os-workspaces/homes/identity/clone-proof.txt",
      ),
      "retained workspace data",
    );
    await assert.rejects(
      docker(
        "exec",
        clone,
        "cantrip-executor",
        "connect",
        "identity",
        "--expect",
        JSON.stringify(before[source].binding),
      ),
      /Executor attachment or generation mismatch/,
    );

    await docker("start", source);
    const retained = await running(source);
    assert.equal(retained.instance_id, before[source].status.instance_id);
    assert.equal(await machine(source), before[source].machine);
    assert.equal(
      (await ssh(source)).ssh_host_key,
      before[source].ssh.ssh_host_key,
    );
    assert.notEqual(retained.generation, before[source].status.generation);
    t.diagnostic(
      JSON.stringify({
        originalGuest: retained.instance_id,
        cloneGuest: cloneStatus.instance_id,
        originalMachine: before[source].machine,
        cloneMachine: await machine(clone),
        distinctSshKeys: true,
        staleBindingRejected: true,
      }),
    );
    passed = true;
  },
);
