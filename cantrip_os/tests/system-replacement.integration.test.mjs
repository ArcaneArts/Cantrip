import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import {
  actualLab,
  checkpointBytes,
  originalBytes,
  sha,
} from "./fixtures/system-replacement-actual.mjs";

const enabled = process.env.CANTRIP_OS_REPLACEMENT_INTEGRATION === "1";
let lab, directory, checkpoint, host, hostModule;
before(
  async () => {
    if (!enabled) return;
    const root = process.env.CANTRIP_OS_REPLACEMENT_EVIDENCE;
    if (root) await mkdir(resolve(root), { recursive: true, mode: 0o700 });
    directory = await mkdtemp(
      join(root ? resolve(root) : tmpdir(), "retained-system-"),
    );
    hostModule = process.env.CANTRIP_OS_REPLACEMENT_HOST_MODULE
      ? pathToFileURL(resolve(process.env.CANTRIP_OS_REPLACEMENT_HOST_MODULE))
          .href
      : new URL("../host/index.mjs", import.meta.url).href;
    host = await import(hostModule);
    lab = await actualLab(directory, host, hostModule);
    checkpoint = await lab.checkpoint();
  },
  { timeout: 300_000 },
);
after(async () => {
  if (lab) await lab.cleanup();
  if (directory && !process.env.CANTRIP_OS_REPLACEMENT_EVIDENCE)
    await rm(directory, { recursive: true, force: true });
});
function replacement(original, caseDirectory) {
  return {
    journalPath: join(caseDirectory, "replacement.json"),
    request: {
      action: "replace",
      operationId: randomUUID(),
      container: original.name,
      expectedContainerId: original.id,
      instanceId: checkpoint.instanceId,
      scopeKey: "a".repeat(64),
      startTarget: true,
      source: checkpoint.source,
      archive: checkpoint.archive,
    },
  };
}
function rollback(input, result, caseDirectory) {
  return {
    journalPath: join(caseDirectory, "rollback.json"),
    replacementJournalPath: input.journalPath,
    request: {
      action: "rollback",
      operationId: randomUUID(),
      container: input.request.container,
      instanceId: input.request.instanceId,
      scopeKey: "b".repeat(64),
      startTarget: true,
      replacementOperationId: input.request.operationId,
      replacementRequestSha256: result.operation.requestSha256,
      expectedOriginalId: input.request.expectedContainerId,
    },
  };
}
for (const fault of ["replacement-create", "rollback-start"])
  test(
    `real encrypted root replacement and rollback recover ${fault} process death`,
    { skip: !enabled, timeout: 420_000 },
    async () => {
      const caseDirectory = join(directory, fault);
      await mkdir(caseDirectory, { mode: 0o700 });
      const original = await lab.original(),
        input = replacement(original, caseDirectory);
      lab.images.add(checkpoint.source.imageId);
      const effects = [],
        request = lab.engine.request.bind(lab.engine),
        loadImage = lab.engine.loadImage.bind(lab.engine);
      lab.engine.request = async (method, path, body, options) => {
        if (method !== "GET") effects.push({ method, path });
        return request(method, path, body, options);
      };
      lab.engine.loadImage = async (source, options) => {
        effects.push({ method: "STREAM-LOAD", path: "/images/load" });
        return loadImage(source, options);
      };
      let childTrace = [];
      try {
        if (fault === "replacement-create") {
          childTrace = await lab.hold(input, "create", null, caseDirectory);
          const count = effects.length;
          const observed = await host.observeSystemReplacement(
            lab.engine,
            input,
          );
          assert.equal(observed.operation.state, "unknown");
          assert.equal(effects.length, count);
        }
        const restored =
          fault === "replacement-create"
            ? await host.continueSystemReplacement(lab.engine, input)
            : await host.replaceSystem(lab.engine, input);
        assert.equal(
          restored.operation.state,
          "ready",
          JSON.stringify(restored),
        );
        const targetId = restored.operation.targetContainerId;
        lab.containers.add(targetId);
        const retired = await lab.engine.inspect(original.id),
          active = await lab.engine.inspect(targetId);
        assert.equal(retired.State.Running, false);
        assert.equal(retired.HostConfig.RestartPolicy.Name, "no");
        assert.equal(active.State.Running, true);
        assert.equal(active.HostConfig.RestartPolicy.Name, "always");
        assert.equal(
          active.Mounts.find((m) => m.Destination === "/workspace").Name,
          original.volume,
        );
        const probe = await lab.command([
          "exec",
          targetId,
          "sh",
          "-c",
          "set -eu; sha256sum /etc/cantrip-system-雪; stat -c '%a %u %g' /etc/cantrip-system-雪; dpkg-query -W -f='${Version}\\n' ed; if dpkg-query -W bc >/dev/null 2>&1; then exit 19; fi; test ! -e /etc/cantrip-newer-root; cat /var/lib/cantrip-system-starts /workspace/marker; printf 'replacement-later\\n' > /etc/cantrip-replacement-later; printf 'workspace-from-replacement\\n' > /workspace/marker",
        ]);
        assert.match(probe, new RegExp(sha(checkpointBytes)));
        assert.match(probe, /640 12345 23456/);
        assert.equal(probe.match(/started/g).length, 2);
        assert.match(probe, /workspace-before/);
        const undo = rollback(input, restored, caseDirectory);
        if (fault === "rollback-start") {
          childTrace = await lab.hold(
            undo,
            "start",
            original.id,
            caseDirectory,
          );
          const count = effects.length;
          const observed = await host.observeSystemReplacement(
            lab.engine,
            undo,
          );
          assert.equal(observed.operation.state, "unknown");
          assert.equal(effects.length, count);
        }
        const undone =
          fault === "rollback-start"
            ? await host.continueSystemReplacement(lab.engine, undo)
            : await host.replaceSystem(lab.engine, undo);
        assert.equal(undone.operation.state, "ready", JSON.stringify(undone));
        assert.equal(undone.operation.targetContainerId, original.id);
        assert.equal((await lab.engine.inspect(targetId)).State.Running, false);
        assert.equal(
          (await lab.engine.inspect(targetId)).HostConfig.RestartPolicy.Name,
          "no",
        );
        const originalProbe = await lab.command([
          "exec",
          original.id,
          "sh",
          "-c",
          "set -eu; sha256sum /etc/cantrip-system-雪; stat -c '%a %u %g' /etc/cantrip-system-雪; dpkg-query -W -f='${Version}\\n' bc; cat /etc/cantrip-newer-root /var/lib/cantrip-system-starts /workspace/marker",
        ]);
        assert.match(originalProbe, new RegExp(sha(originalBytes)));
        assert.match(originalProbe, /640 12345 23456/);
        assert.match(originalProbe, /newer-root/);
        assert.match(originalProbe, /workspace-from-replacement/);
        assert.equal(originalProbe.match(/started/g).length, 2);
        const retainedPath = join(caseDirectory, "retained-later.txt");
        await lab.command([
          "cp",
          `${targetId}:/etc/cantrip-replacement-later`,
          retainedPath,
        ]);
        assert.equal(
          await readFile(retainedPath, "utf8"),
          "replacement-later\n",
        );
        const all = [...effects, ...childTrace];
        assert.equal(
          all.filter(
            (e) =>
              e.method === "POST" && e.path.startsWith("/containers/create?"),
          ).length,
          1,
        );
        assert.equal(all.filter((e) => e.method === "STREAM-LOAD").length, 1);
        assert.equal(
          all.filter(
            (e) =>
              e.method === "POST" && e.path === `/containers/${targetId}/start`,
          ).length,
          1,
        );
        assert.equal(
          all.filter(
            (e) =>
              e.method === "POST" &&
              e.path === `/containers/${original.id}/start`,
          ).length,
          1,
        );
        const count = effects.length;
        assert.deepEqual(
          (await host.replaceSystem(lab.engine, undo)).operation,
          undone.operation,
        );
        assert.equal(effects.length, count);
        assert.deepEqual(
          (await host.observeSystemReplacement(lab.engine, input)).operation,
          restored.operation,
        );
        await writeFile(
          join(caseDirectory, "result.json"),
          JSON.stringify(
            {
              input,
              restored,
              undo,
              undone,
              probe,
              originalProbe,
              effects,
              childTrace,
              checkpointReceipt: checkpoint.receipt,
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
        await lab.event("verified-root-replacement-rollback", {
          fault,
          originalId: original.id,
          targetId,
          sourceImage: checkpoint.source.imageId,
        });
      } finally {
        lab.engine.request = request;
        lab.engine.loadImage = loadImage;
        await lab.cleanup();
      }
    },
  );

test(
  "real Docker start refusal preserves the root layer for explicit rollback",
  { skip: !enabled, timeout: 300_000 },
  async () => {
    const caseDirectory = join(directory, "failed-start");
    await mkdir(caseDirectory, { mode: 0o700 });
    const seed = await lab.create({ volume: false });
    const oldBase = await lab.request(
      "POST",
      `/commit?container=${seed.id}&pause=true`,
      {
        ...lab.base.Config,
        Cmd: ["sleep", "infinity"],
        Labels: {
          "io.cantrip.os": "foundation",
          "io.cantrip.os.test": seed.name,
        },
      },
    );
    lab.images.add(oldBase.Id);
    const badBase = await lab.request(
      "POST",
      `/commit?container=${seed.id}&pause=true`,
      {
        ...lab.base.Config,
        Cmd: ["/cantrip-deliberately-missing-executable"],
        Labels: {
          "io.cantrip.os": "foundation",
          "io.cantrip.os.test": seed.name,
        },
      },
    );
    lab.images.add(badBase.Id);
    const original = await lab.original({ image: oldBase.Id, counter: false }),
      input = replacement(original, caseDirectory);
    input.request.source = { kind: "base", imageId: badBase.Id };
    input.request.archive = null;
    try {
      const failed = await host.replaceSystem(lab.engine, input);
      assert.equal(failed.operation.state, "failed", JSON.stringify(failed));
      const targetId = failed.operation.targetContainerId;
      assert.ok(targetId);
      lab.containers.add(targetId);
      assert.match(
        failed.operation.error,
        /missing-executable|executable file not found/,
      );
      const undo = rollback(input, failed, caseDirectory),
        undone = await host.replaceSystem(lab.engine, undo);
      assert.equal(undone.operation.state, "ready", JSON.stringify(undone));
      assert.equal(undone.operation.targetContainerId, original.id);
      const probe = await lab.command([
        "exec",
        original.id,
        "sh",
        "-c",
        "set -eu; sha256sum /etc/cantrip-system-雪; dpkg-query -W -f='${Version}\\n' bc; cat /etc/cantrip-newer-root /workspace/marker",
      ]);
      assert.match(probe, new RegExp(sha(originalBytes)));
      assert.match(probe, /newer-root/);
      assert.match(probe, /workspace-before/);
      assert.equal((await lab.engine.inspect(targetId)).State.Running, false);
      await writeFile(
        join(caseDirectory, "result.json"),
        JSON.stringify({ input, failed, undo, undone, probe }, null, 2),
        { mode: 0o600 },
      );
      await lab.event("verified-real-start-failure-rollback", {
        originalId: original.id,
        failedTargetId: targetId,
      });
    } finally {
      await lab.cleanup();
    }
  },
);
