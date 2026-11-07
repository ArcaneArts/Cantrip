// Existing browser administrative SDK -> production Server -> full Worker ->
// actual Docker root transitions. Only this disposable guest's files are edited.
import assert from "node:assert/strict";
import { eventually } from "./full-worker.mjs";
import { dockerResponseFault } from "./cantrip-os-docker-fault.mjs";

export async function actualCantripOsSystemClient({
  page,
  call,
  os,
  guest,
  record,
  instance,
  selected,
  fixture,
  startWorker,
  stopWorker,
  crashWorker,
  result,
  report,
}) {
  const fault = await dockerResponseFault(guest.name);
  const restartWorker = () =>
    startWorker(undefined, { environment: fault.environment });
  report.dockerRequests = fault.requests;
  try {
    await stopWorker();
    await restartWorker();
    const system = (method, ...args) =>
      call("api/cantrip-os-systems", method, ...args);
    const account = await call(
      "cantrip-os-system-draft",
      "cantripOsSystemAccountKey",
    );
    await system("authorizeCantripOsSystemWorker", instance.workerId, account);
    const rootFile = "/etc/cantrip-rust-root-proof";
    const mountedFile = `${selected.homeGuestPath}/mounted-proof`;
    const rootBytes = (version) =>
      Buffer.from(`Private Cantrip root ${version} 🍄\0\xff`, "utf8");
    const mountedBytes = (version) =>
      Buffer.from(`Private retained files ${version} 🌲\0\xfe`, "utf8");
    const write = async (rootVersion, mountedVersion) =>
      guest.exec(
        "python3",
        "-c",
        "from pathlib import Path;import sys,base64,os;entries=[(sys.argv[1],sys.argv[2],12345,23456),(sys.argv[3],sys.argv[4],int(sys.argv[5]),int(sys.argv[6]))];[(Path(p).write_bytes(base64.b64decode(b)),Path(p).chmod(0o640),os.chown(p,u,g)) for p,b,u,g in entries]",
        rootFile,
        rootBytes(rootVersion).toString("base64"),
        mountedFile,
        mountedBytes(mountedVersion).toString("base64"),
        String(selected.uid),
        String(selected.gid),
      );
    const proof = async (container, file, expected, owner, group) => {
      const actual = await guest.fileProof(container, file);
      assert.equal(actual.base64, expected.toString("base64"));
      assert.equal(actual.mode, 0o640);
      assert.equal(actual.uid, owner);
      assert.equal(actual.gid, group);
      return actual;
    };
    const verify = async (label, rootVersion, mountedVersion) =>
      record(label, {
        root: await proof(
          guest.id,
          rootFile,
          rootBytes(rootVersion),
          12345,
          23456,
        ),
        mounted: await proof(
          guest.id,
          mountedFile,
          mountedBytes(mountedVersion),
          selected.uid,
          selected.gid,
        ),
      });
    const readyGuest = () =>
      eventually(
        async () => {
          try {
            return {
              value: await os("inspectCantripOs", {
                workerId: instance.workerId,
                transport: { kind: "docker", container: guest.name },
              }),
            };
          } catch (error) {
            return { error: error.message };
          }
        },
        (value) => assert.ok(value.value, value.error),
      );
    const refreshInstance = async () => {
      instance = (await os("getCantripOsInstances")).find(
        (row) => row.id === instance.id,
      );
      assert.ok(instance);
      return instance;
    };
    const prepare = async (intent, original) => {
      await refreshInstance();
      const status = original
        ? null
        : record(
            `system-status-${intent.action}`,
            await system("getCantripOsSystem", instance, account),
          );
      if (status) {
        assert.equal(status.supported, true);
        assert.ok(status.target, JSON.stringify(status));
      }
      const target = original ?? status.target;
      const draft = await call(
        "cantrip-os-system-draft",
        "prepareCantripOsSystemDraft",
        {
          instanceId: instance.id,
          workerId: instance.workerId,
          attachmentGeneration: instance.attachmentGeneration,
          targetGeneration: target.targetGeneration ?? target.generation,
        },
        intent,
      );
      draft.submitted = true;
      await call("cantrip-os-system-draft", "saveCantripOsSystemDraft", draft);
      return draft;
    };
    const finish = async (label, draft, initial) => {
      const value = record(
        label,
        initial ?? (await system("submitCantripOsSystem", draft)),
      );
      if (value.protectedResult) {
        const opened = await call(
          "cantrip-os-system-encryption",
          "openCantripOsSystemResult",
          value,
        );
        assert.equal(opened.command.operationId, value.operationId);
        assert.equal(opened.command.target.generation, value.targetGeneration);
        assert.equal(
          opened.command.scope.attachmentGeneration,
          value.request.attachmentGeneration,
        );
        if (value.root) {
          const root = opened.replacement.operation;
          for (const key of [
            "requestSha256",
            "originalContainerId",
            "targetContainerId",
            "retainedContainerId",
            "runtimeHandlesRestored",
          ])
            assert.equal(value.root[key], root[key], key);
        }
        (report.privateSystemOutcomes ??= []).push({ label, value: opened });
      }
      assert.equal(value.state, "ready", JSON.stringify(value));
      assert.equal(value.dispatchStage, "executing");
      const replay = record(
        label + "-replayed",
        await system("submitCantripOsSystem", draft),
      );
      assert.deepEqual(replay, value);
      const observed = record(
        label + "-observed",
        await system("observeCantripOsSystemDraft", draft),
      );
      assert.deepEqual(observed, value);
      return value;
    };
    const recover = async (label, operation) => {
      await guest.adopt(operation.root);
      assert.equal(operation.root.runtimeHandlesRestored, false);
      await readyGuest();
      const adopted = record(
        label + "-identity",
        await system("recoverCantripOsSystemOperation", operation, account),
      );
      assert.equal(adopted.id, instance.id);
      assert.notEqual(
        adopted.attachmentGeneration,
        operation.attachmentGeneration,
      );
      instance = adopted;
      const current = await refreshInstance();
      const recovered = record(
        label + "-runtime",
        await os("recoverCantripOsInstance", current),
      );
      assert.equal(recovered.instance.status, "connected");
      instance = recovered.instance;
    };
    const originalId = guest.id;
    await write("A", "one");
    await verify("root-before-capture", "A", "one");
    const captureDraft = await prepare({
      action: "capture",
      resumeOriginal: true,
    });
    const commit = fault.arm("commit", originalId);
    await page.evaluate(async (draft) => {
      window.cantripRootCapture = (
        await import("/src/lib/api/cantrip-os-systems.ts")
      )
        .submitCantripOsSystem(draft)
        .then(
          (value) => ({ ok: true, value }),
          (error) => ({
            ok: false,
            name: error.name,
            status: error.status ?? null,
            code: error.code ?? null,
          }),
        );
    }, captureDraft);
    const committed = await fault.wait(commit);
    guest.privateImages.add(committed.receipt.Id);
    await guest.save();
    report.captureServerCrash = fixture.workerFixture
      ? await fixture.replacePeer(0, fixture.peers[0].kind, { crash: true })
      : await fixture.restart({ crash: true });
    commit.release();
    const lost = record(
      "root-capture-server-reply-lost",
      await page.evaluate(() => window.cantripRootCapture),
    );
    assert.equal(lost.ok, false);
    const recoveredCapture = await eventually(
      () => system("observeCantripOsSystemDraft", captureDraft),
      (value) => assert.equal(value.state, "ready", JSON.stringify(value)),
      180000,
    );
    const captured = await finish(
      "root-captured",
      captureDraft,
      recoveredCapture,
    );
    assert.equal(
      fault.requests.filter(
        (entry) => entry.method === "POST" && /\/commit\?/.test(entry.path),
      ).length,
      1,
    );
    result.steps.push(
      "actual Server SIGKILL after the real Docker commit but before Worker acknowledgement recovers one encrypted checkpoint without a second commit",
    );
    const privateCapture = report.privateSystemOutcomes.find(
      (row) => row.label === "root-captured",
    ).value;
    const manifest = privateCapture.capture.manifest;
    assert.equal(manifest.snapshot.sourceContainerId, originalId);
    assert.equal(manifest.snapshot.runtimeHandlesRestored, false);
    assert.equal(manifest.snapshot.consistency, "stopped-container-filesystem");
    assert.equal(manifest.snapshot.identityPolicy, "same-instance-only");
    assert.ok(
      manifest.snapshot.mounts.every((mount) => mount.included === false),
    );
    assert.ok(privateCapture.capture.archive.archiveBytes > 0);
    guest.privateImages.add(manifest.snapshot.imageId);
    await guest.save();
    assert.equal(
      (await guest.json("inspect", originalId))[0].State.Running,
      true,
    );
    await write("B", "two");
    // Force restoration from the encrypted Worker archive rather than allowing
    // Docker to reuse its already committed private image.
    await guest.docker("image", "rm", manifest.snapshot.imageId);
    const restored = await finish(
      "checkpoint-replaced",
      await prepare({
        action: "replace",
        startTarget: true,
        source: { kind: "checkpoint", operationId: captured.operationId },
      }),
    );
    await recover("checkpoint", restored);
    assert.notEqual(guest.id, originalId);
    await verify("checkpoint-root-and-live-mounted-files", "A", "two");
    assert.equal(
      (await guest.json("inspect", originalId))[0].State.Running,
      false,
    );
    await proof(originalId, rootFile, rootBytes("B"), 12345, 23456);
    const restoredId = guest.id;
    await write("C", "three");
    // Root management remains usable while the optional executor is disabled.
    await guest.exec("cantrip-executor", "disable");
    const undone = await finish(
      "checkpoint-rollback",
      await prepare(
        {
          action: "rollback",
          replacementOperationId: restored.operationId,
          startTarget: true,
        },
        restored,
      ),
    );
    await guest.adopt(undone.root);
    assert.equal(guest.id, originalId);
    await verify(
      "rollback-retains-original-root-and-current-files",
      "B",
      "three",
    );
    assert.equal(
      (await guest.json("inspect", restoredId))[0].State.Running,
      false,
    );
    await proof(restoredId, rootFile, rootBytes("C"), 12345, 23456);
    assert.equal(
      JSON.parse(await guest.exec("cantrip-executor", "status")).enabled,
      false,
    );
    await guest.exec("cantrip-executor", "enable");
    await recover("rollback", undone);
    result.steps.push(
      "encrypted root checkpoint restore and retained rollback preserve original/latest root layers, current mounted writes and ownership while requiring explicit physical identity/runtime recovery",
    );

    const baseDraft = await prepare({
      action: "replace",
      startTarget: true,
      source: { kind: "base", imageId: guest.image.Id },
    });
    const create = fault.arm("create");
    await page.evaluate(async (draft) => {
      window.cantripRootReplace = (
        await import("/src/lib/api/cantrip-os-systems.ts")
      )
        .submitCantripOsSystem(draft)
        .then(
          (value) => ({ ok: true, value }),
          (error) => ({
            ok: false,
            status: error.status ?? null,
            message: error.message,
          }),
        );
    }, baseDraft);
    const created = await fault.wait(create);
    guest.ownedContainers.add(created.receipt.Id);
    await guest.save();
    const originalBefore = (await guest.json("inspect", guest.id))[0];
    await crashWorker();
    create.release();
    const interrupted = await page.evaluate(() => window.cantripRootReplace);
    assert.equal(interrupted.ok, true, JSON.stringify(interrupted));
    assert.equal(interrupted.value.state, "unknown");
    record("base-reset-worker-lost", interrupted.value);
    await restartWorker();
    const count = fault.effects().length;
    const observed = record(
      "base-reset-after-worker-reconnect",
      await system("observeCantripOsSystemDraft", baseDraft),
    );
    assert.equal(observed.state, "unknown");
    assert.equal(
      fault.effects().length,
      count,
      "observation cannot start, stop, rename or recreate a root",
    );
    const candidate = (await guest.json("inspect", created.receipt.Id))[0];
    assert.equal(candidate.State.Running, false);
    const unchanged = (await guest.json("inspect", guest.id))[0];
    assert.equal(unchanged.Name, originalBefore.Name);
    assert.equal(unchanged.State.StartedAt, originalBefore.State.StartedAt);
    const continued = await system(
      "controlCantripOsSystemOperation",
      observed,
      "continue",
      account,
    );
    const reset = await finish("base-reset", baseDraft, continued);
    assert.equal(
      fault.requests.filter(
        (entry) =>
          entry.method === "POST" && /\/containers\/create\?/.test(entry.path),
      ).length,
      2,
    );
    result.steps.push(
      "actual full Worker SIGKILL after Docker creates the candidate leaves an unknown admission; observation performs no root effect and explicit continuation activates that same candidate once",
    );
    await recover("base-reset", reset);
    const baseId = guest.id;
    assert.notEqual(baseId, originalId);
    assert.equal(
      await guest.exec(
        "python3",
        "-c",
        "from pathlib import Path;import sys;print(Path(sys.argv[1]).exists())",
        rootFile,
      ),
      "False",
    );
    await proof(
      guest.id,
      mountedFile,
      mountedBytes("three"),
      selected.uid,
      selected.gid,
    );
    await write("D", "four");
    const baseUndone = await finish(
      "base-reset-rollback",
      await prepare(
        {
          action: "rollback",
          replacementOperationId: reset.operationId,
          startTarget: true,
        },
        reset,
      ),
    );
    await recover("base-reset-rollback", baseUndone);
    assert.equal(guest.id, originalId);
    await verify("base-rollback-retains-current-mounted-writes", "B", "four");
    assert.equal((await guest.json("inspect", baseId))[0].State.Running, false);
    await proof(baseId, rootFile, rootBytes("D"), 12345, 23456);
    result.steps.push(
      "exact-base system reset clears root customization while retaining mounted data; rollback preserves both the original root and the base candidate's later writes",
    );

    const history = record(
      "system-history-before-restart",
      await system(
        "getCantripOsSystemOperations",
        instance.id,
        undefined,
        account,
      ),
    );
    assert.equal(history.items.length, 5);
    for (const value of history.items) {
      assert.equal(value.state, "ready");
      assert.ok(
        await call(
          "cantrip-os-system-encryption",
          "openCantripOsSystemResult",
          value,
        ),
      );
    }
    const actual = (await guest.json("inspect", guest.id))[0];
    await stopWorker();
    await fixture.restart();
    await restartWorker();
    await eventually(
      () => call("api/worker-wire", "getWorkers"),
      (workers) =>
        assert.equal(
          workers.find((row) => row.workerId === instance.workerId)?.online,
          true,
        ),
    );
    const retained = record(
      "system-history-after-restart",
      await system(
        "getCantripOsSystemOperations",
        instance.id,
        undefined,
        account,
      ),
    );
    assert.deepEqual(retained, history);
    for (const value of retained.items)
      assert.ok(
        await call(
          "cantrip-os-system-encryption",
          "openCantripOsSystemResult",
          value,
        ),
      );
    const after = (await guest.json("inspect", guest.id))[0];
    assert.equal(after.Id, actual.Id);
    assert.equal(after.State.StartedAt, actual.State.StartedAt);
    await verify("root-files-after-server-worker-restart", "B", "four");
    result.steps.push(
      "complete system history and original encrypted contexts survive actual Server/Worker restart without another root transition or restored runtime handle",
    );
    const effects = fault.effects();
    const effectCounts = {
      commits: effects.filter((entry) => /\/commit\?/.test(entry.path)).length,
      creates: effects.filter((entry) =>
        /\/containers\/create\?/.test(entry.path),
      ).length,
      starts: effects.filter((entry) =>
        /\/containers\/[^/]+\/start(?:\?|$)/.test(entry.path),
      ).length,
      stops: effects.filter((entry) =>
        /\/containers\/[^/]+\/stop(?:\?|$)/.test(entry.path),
      ).length,
      renames: effects.filter((entry) =>
        /\/containers\/[^/]+\/rename(?:\?|$)/.test(entry.path),
      ).length,
    };
    assert.deepEqual(effectCounts, {
      commits: 1,
      creates: 2,
      starts: 5,
      stops: 5,
      renames: 8,
    });
    record("root-effect-counts", effectCounts);
  } finally {
    try {
      await stopWorker();
    } finally {
      report.dockerHeldResponses = fault.holds.map((hold) => ({
        kind: hold.kind,
        entered: hold.entered,
      }));
      await fault.close();
    }
  }
}
