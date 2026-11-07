import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import * as host from "../host/index.mjs";
import {
  actualLab,
  checkpointBytes,
  originalBytes,
  sha,
} from "./fixtures/system-replacement-actual.mjs";
import { holdSystemWorker } from "./fixtures/system-worker-actual.mjs";

const enabled = process.env.CANTRIP_OS_SYSTEM_WORKER_INTEGRATION === "1";
let directory,
  lab,
  CantripOsSystemManager,
  systemOperationContext,
  workerCommandSchema,
  decryptCantripOsSystemOperationResult;
const managerModule = new URL(
  "../../cantrip_worker/dist/os-executor/system-manager.js",
  import.meta.url,
).href;
before(
  async () => {
    if (!enabled) return;
    ({ workerCommandSchema } =
      await import("../../packages/protocol/dist/index.js"));
    ({ decryptCantripOsSystemOperationResult } =
      await import("../../packages/crypto/dist/index.js"));
    ({ CantripOsSystemManager } = await import(managerModule));
    ({ systemOperationContext } =
      await import("../../cantrip_worker/dist/os-executor/system-job.js"));
    const root = process.env.CANTRIP_OS_SYSTEM_WORKER_EVIDENCE;
    if (root) await mkdir(resolve(root), { recursive: true, mode: 0o700 });
    directory = await mkdtemp(
      join(root ? resolve(root) : tmpdir(), "system-worker-"),
    );
    lab = await actualLab(
      directory,
      host,
      new URL("../host/index.mjs", import.meta.url).href,
    );
  },
  { timeout: 300_000 },
);
after(async () => {
  if (lab) await lab.cleanup();
  if (directory && !process.env.CANTRIP_OS_SYSTEM_WORKER_EVIDENCE)
    await rm(directory, { recursive: true, force: true });
});

for (const fault of ["create", "start"])
  test(
    `real registered system commands recover ${fault} process death without replay`,
    {
      skip: !enabled,
      timeout: 480_000,
    },
    async () => {
      const path = join(directory, fault);
      await mkdir(path, { mode: 0o700 });
      const source = await lab.create(),
        key = randomBytes(32);
      const scope = {
        ownerId: "fixture-owner",
        workerId: "fixture-worker",
        serverId: "fixture-server",
        instanceId: randomUUID(),
        guestInstanceId: randomUUID(),
        attachmentGeneration: randomUUID(),
      };
      const identityPath = "/var/lib/cantrip-system-identity/instance.json";
      async function identity() {
        await lab.command(
          [
            "exec",
            "-i",
            source.id,
            "sh",
            "-c",
            "mkdir -p /etc/cantrip-os /var/lib/cantrip-system-identity; cat > /var/lib/cantrip-system-identity/instance.json; printf '%s' '{\"state_dir\":\"/var/lib/cantrip-system-identity\"}' > /etc/cantrip-os/executor.json",
          ],
          JSON.stringify({
            version: 1,
            instance_id: scope.guestInstanceId,
            attachment: { owner_id: scope.ownerId, worker_id: scope.workerId },
          }),
        );
      }
      await identity();
      await lab.command([
        "exec",
        source.id,
        "sh",
        "-c",
        "apt-get update >/dev/null && apt-get install -y --no-install-recommends ed >/dev/null && apt-get clean && rm -rf /var/lib/apt/lists/*",
      ]);
      await lab.marker(source.id, checkpointBytes);
      await lab.command([
        "exec",
        source.id,
        "sh",
        "-c",
        "printf 'mounted-before\n' > /workspace/marker",
      ]);
      const keys = {
        ownerId: () => scope.ownerId,
        serverIdentity: () => scope.serverId,
        componentKey: (_scope, revision = 1) => {
          assert.equal(revision, 1);
          return { key: new Uint8Array(key), keyRevision: 1 };
        },
      };
      const manager = () =>
        new CantripOsSystemManager(
          path,
          scope.workerId,
          keys,
          async () => lab.engine,
        );
      const transport = { kind: "docker", container: source.name };
      const status = (extra = {}) =>
        manager().handle(
          workerCommandSchema.parse({
            type: "cantrip-os.system.status",
            scope,
            transport,
            ...extra,
          }),
        );
      const invoke = (command) =>
        manager().handle(workerCommandSchema.parse(command));
      async function prepare(command) {
        const originalRequest = lab.engine.request;
        let calls = 0;
        lab.engine.request = (...args) => {
          calls++;
          return originalRequest.apply(lab.engine, args);
        };
        try {
          const prepared = await invoke({ ...command, mode: "prepare" });
          assert.equal(prepared.state, "running");
          assert.equal(prepared.phase, "prepared");
          assert.ok(prepared.protectedResult);
          assert.deepEqual(
            await invoke({ ...command, mode: "observe" }),
            prepared,
          );
          assert.deepEqual(
            await invoke({ ...command, mode: "prepare" }),
            prepared,
          );
          assert.equal(
            calls,
            0,
            "Preparation and its observation must not contact Docker",
          );
          return prepared;
        } finally {
          lab.engine.request = originalRequest;
        }
      }
      const first = await status();
      const capture = {
        type: "cantrip-os.system.capture",
        action: "capture",
        mode: "execute",
        operationId: randomUUID(),
        checkpointId: randomUUID(),
        resumeOriginal: true,
        scope: { ...scope },
        transport,
        target: first.target,
      };
      const preparedCapture = await prepare(capture);
      const captured = await invoke({ ...capture, mode: "continue" });
      assert.equal(captured.state, "ready", JSON.stringify(captured));
      const privateCapture = await decryptCantripOsSystemOperationResult({
        context: systemOperationContext(capture),
        componentKey: key,
        keyRevision: 1,
        envelope: captured.protectedResult,
      });
      lab.images.add(privateCapture.capture.manifest.snapshot.imageId);
      assert.equal(privateCapture.capture.manifest.snapshot.mounts.length, 1);
      assert.equal(
        privateCapture.capture.manifest.snapshot.mounts[0].included,
        false,
      );
      await lab.command([
        "exec",
        source.id,
        "sh",
        "-c",
        "apt-get update >/dev/null && apt-get install -y --no-install-recommends bc >/dev/null && apt-get clean && rm -rf /var/lib/apt/lists/*; printf 'newer-root\n' > /etc/cantrip-newer-root",
      ]);
      await lab.marker(source.id, originalBytes);
      // Restore an older guest identity only through proof of this exact completed
      // transition. Even one owner must not obtain fresh handles from a name alone.
      if (fault === "create") {
        scope.guestInstanceId = randomUUID();
        scope.attachmentGeneration = randomUUID();
        await identity();
      }
      const current = await status();
      if (fault === "create")
        await lab.command([
          "exec",
          source.id,
          "sh",
          "-c",
          `printf broken > /etc/cantrip-os/executor.json; printf broken > ${identityPath}`,
        ]);
      await lab.engine.request(
        "DELETE",
        `/images/${encodeURIComponent(privateCapture.capture.manifest.snapshot.imageId)}`,
      );
      const replace = {
        type: "cantrip-os.system.replace",
        action: "replace",
        mode: "execute",
        operationId: randomUUID(),
        scope: { ...scope },
        transport,
        target: current.target,
        startTarget: true,
        source: {
          kind: "checkpoint",
          capture: {
            context: {
              ...systemOperationContext(capture),
              checkpointId: capture.checkpointId,
            },
            container: source.name,
            resumeOriginal: true,
          },
        },
      };
      const effects = [],
        request = lab.engine.request.bind(lab.engine);
      lab.engine.request = async (method, route, body, options) => {
        if (method !== "GET") effects.push({ method, path: route });
        return request(method, route, body, options);
      };
      let childTrace = [],
        replaced;
      try {
        await prepare(replace);
        if (fault === "create") {
          childTrace = await holdSystemWorker({
            directory: path,
            command: { ...replace, mode: "continue" },
            hold: "create",
            key,
            managerModule,
          });
          const count = effects.length;
          const observed = await invoke({ ...replace, mode: "observe" });
          assert.equal(observed.state, "unknown", JSON.stringify(observed));
          assert.equal(effects.length, count);
          replaced = await invoke({ ...replace, mode: "continue" });
        } else replaced = await invoke({ ...replace, mode: "continue" });
        assert.equal(replaced.state, "ready", JSON.stringify(replaced));
        assert.equal(replaced.root.runtimeHandlesRestored, false);
        assert.equal(
          replaced.root.guestInstanceId,
          capture.scope.guestInstanceId,
        );
        const candidate = replaced.root.targetContainerId;
        lab.containers.add(candidate);
        if (fault === "create")
          await assert.rejects(status(), /identity changed/);
        const recovered = await status({
          recovery: {
            operationId: replace.operationId,
            scope: replace.scope,
            targetGeneration: replace.target.generation,
          },
        });
        assert.equal(recovered.target.containerId, candidate);
        assert.equal(
          recovered.target.expected.guestInstanceId,
          capture.scope.guestInstanceId,
        );
        const probe = await lab.command([
          "exec",
          candidate,
          "sh",
          "-c",
          "set -eu; sha256sum /etc/cantrip-system-雪; stat -c '%a %u %g' /etc/cantrip-system-雪; dpkg-query -W -f='${Version}\n' ed; if dpkg-query -W bc >/dev/null 2>&1; then exit 19; fi; test ! -e /etc/cantrip-newer-root; cat /workspace/marker /var/lib/cantrip-system-starts; printf 'replacement-later\n' > /etc/cantrip-replacement-later; printf 'mounted-later\n' > /workspace/marker",
        ]);
        assert.match(probe, new RegExp(sha(checkpointBytes)));
        assert.match(probe, /640 12345 23456/);
        assert.match(probe, /mounted-before/);
        assert.equal(probe.match(/started/g).length, 2);
        assert.equal(
          (await lab.engine.inspect(source.id)).State.Running,
          false,
        );
        const rollback = {
          type: "cantrip-os.system.rollback",
          action: "rollback",
          mode: "execute",
          operationId: randomUUID(),
          scope: replace.scope,
          transport,
          target: replace.target,
          startTarget: true,
          replacement: {
            operationId: replace.operationId,
            scope: replace.scope,
            targetGeneration: replace.target.generation,
          },
        };
        let undone;
        await prepare(rollback);
        if (fault === "start") {
          childTrace = await holdSystemWorker({
            directory: path,
            command: { ...rollback, mode: "continue" },
            hold: "start",
            holdId: source.id,
            key,
            managerModule,
          });
          const count = effects.length;
          const observed = await invoke({ ...rollback, mode: "observe" });
          assert.equal(effects.length, count);
          assert.equal(observed.state, "unknown", JSON.stringify(observed));
          undone = await invoke({ ...rollback, mode: "continue" });
        } else undone = await invoke({ ...rollback, mode: "continue" });
        assert.equal(undone.state, "ready", JSON.stringify(undone));
        assert.equal(undone.root.targetContainerId, source.id);
        assert.equal(
          undone.root.guestAttachment,
          fault === "create" ? "unavailable" : "owned",
        );
        const count = effects.length;
        assert.deepEqual(
          await invoke({ ...rollback, mode: "observe" }),
          undone,
        );
        assert.equal(effects.length, count);
        const original = await lab.command([
          "exec",
          source.id,
          "sh",
          "-c",
          "set -eu; sha256sum /etc/cantrip-system-雪; stat -c '%a %u %g' /etc/cantrip-system-雪; dpkg-query -W -f='${Version}\n' bc; cat /etc/cantrip-newer-root /workspace/marker /var/lib/cantrip-system-starts",
        ]);
        assert.match(original, new RegExp(sha(originalBytes)));
        assert.match(original, /640 12345 23456/);
        assert.match(original, /mounted-later/);
        assert.match(original, /newer-root/);
        assert.equal(original.match(/started/g).length, 3);
        const retained = join(path, "retained-later.txt");
        await lab.command([
          "cp",
          `${candidate}:/etc/cantrip-replacement-later`,
          retained,
        ]);
        assert.equal(await readFile(retained, "utf8"), "replacement-later\n");
        assert.equal(
          (await lab.engine.inspect(candidate)).HostConfig.RestartPolicy.Name,
          "no",
        );
        await lab.engine.request("POST", `/containers/${source.id}/stop`);
        const stopped = await status({ target: replace.target });
        assert.equal(stopped.running, false);
        assert.equal(stopped.target.containerId, source.id);
        assert.equal(
          childTrace.filter(
            (e) =>
              e.method === "POST" &&
              (fault === "create"
                ? e.path.startsWith("/containers/create?")
                : e.path === `/containers/${source.id}/start`),
          ).length,
          1,
        );
        await writeFile(
          join(path, "result.json"),
          JSON.stringify(
            {
              capture,
              preparedCapture,
              captured,
              privateCapture,
              replace,
              replaced,
              rollback,
              undone,
              effects,
              childTrace,
              probe,
              original,
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
      } finally {
        lab.engine.request = request;
      }
    },
  );
