import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  LocalDocker,
  DockerDeliveryError,
  changeRetainedContainer,
  observeRetainedContainer,
} from "../host/index.mjs";

const execute = promisify(execFile);
const container = process.env.CANTRIP_OS_TEST_RETAINED_CONTAINER;

test(
  "actual retained Docker stop/start/restart preserve root customization and volumes without replay",
  {
    skip: !container,
    timeout: 180_000,
  },
  async (t) => {
    const engine = await LocalDocker.current();
    const original = await engine.inspect(container);
    const id = original.Id;
    t.after(async () => {
      if (!(await engine.inspect(id)).State.Running)
        await engine.request("POST", `/containers/${id}/start`);
    });
    const operationRoot = await mkdtemp(
      join(tmpdir(), "cantrip-retained-actual-"),
    );
    const suffix = randomUUID();
    const rootFile = `/etc/cantrip-lifecycle-${suffix}`;
    const volumeFile = `/var/lib/cantrip-os-workspaces/lifecycle-${suffix}`;
    const python = async (code) =>
      (
        await execute("docker", [
          "exec",
          id,
          "python3",
          "-c",
          code,
          rootFile,
          volumeFile,
        ])
      ).stdout;
    await python(
      "from pathlib import Path;import sys;[(Path(p).write_bytes(b'Cantrip retained lifecycle proof\\x00\\xff'),Path(p).chmod(0o640)) for p in sys.argv[1:]]",
    );
    const bytes = async () =>
      JSON.parse(
        await python(
          "from pathlib import Path;import hashlib,json,stat,sys;print(json.dumps([{'sha256':hashlib.sha256(Path(p).read_bytes()).hexdigest(),'mode':stat.S_IMODE(Path(p).stat().st_mode)} for p in sys.argv[1:]]))",
        ),
      );
    const before = await bytes();
    const packages = async () =>
      (
        await execute("docker", [
          "exec",
          id,
          "dpkg-query",
          "-W",
          "-f=${binary:Package}=${Version}\\n",
        ])
      ).stdout;
    const beforePackages = await packages();
    const input = (action) => ({
      operationId: randomUUID(),
      action,
      container,
      expectedContainerId: id,
      journalPath: join(operationRoot, `${action}.json`),
    });
    const stopInput = input("stop");
    const stopped = await changeRetainedContainer(engine, stopInput);
    assert.equal(stopped.operation.state, "ready");
    assert.equal((await engine.inspect(id)).State.Running, false);
    await assert.rejects(execute("docker", ["exec", id, "true"]));
    const started = await changeRetainedContainer(engine, input("start"));
    assert.equal(started.operation.state, "ready");
    assert.equal((await engine.inspect(id)).State.Running, true);
    assert.deepEqual(await bytes(), before);
    assert.equal(await packages(), beforePackages);

    let restartPosts = 0;
    const loseReply = {
      inspect: (...args) => engine.inspect(...args),
      request: async (...args) => {
        await engine.request(...args);
        restartPosts++;
        throw new DockerDeliveryError(
          "Acceptance: dropped the actual restart response after its mutation",
        );
      },
    };
    const restartInput = input("restart");
    const lost = await changeRetainedContainer(loseReply, restartInput);
    assert.equal(lost.operation.state, "unknown");
    const observed = await observeRetainedContainer(loseReply, restartInput);
    assert.equal(observed.operation.state, "ready");
    assert.equal(observed.operation.completionEvidence, "observed-state");
    assert.equal(
      (await changeRetainedContainer(loseReply, restartInput)).operation.state,
      "ready",
    );
    assert.equal(restartPosts, 1);
    assert.deepEqual(await bytes(), before);
    assert.equal(await packages(), beforePackages);
    const retained = await engine.inspect(id);
    assert.equal(retained.Id, original.Id);
    assert.equal(retained.Image, original.Image);
    const mounts = (record) =>
      record.Mounts.map(({ Type, Name, Source, Destination, RW }) => ({
        Type,
        Name,
        Source,
        Destination,
        RW,
      }));
    assert.deepEqual(mounts(retained), mounts(original));
    const history = await observeRetainedContainer(engine, stopInput);
    assert.equal(history.operation.state, "ready");
    assert.equal(history.operation.after.running, false);
    assert.equal(history.observation.running, true);

    const artifacts = new URL(
      "../artifacts/phase5-instance-lifecycle/",
      import.meta.url,
    );
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    await writeFile(
      new URL(`retained-${suffix}.json`, artifacts),
      JSON.stringify(
        {
          containerId: id,
          operationRoot,
          rootFile,
          volumeFile,
          rootAndVolumeBytes: before,
          packageInventoryRetained: true,
          sameContainerAndImage: true,
          sameMounts: true,
          restartPosts,
          stopped,
          started,
          lost,
          observed,
          stoppedHistoryAfterRestart: history,
          fullWorkerProductAcceptance: false,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
  },
);
