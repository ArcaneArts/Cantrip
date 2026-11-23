import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  stat,
  rm,
  appendFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  LocalDocker,
  captureSystemCheckpoint,
  observeSystemCheckpoint,
  continueSystemCheckpoint,
} from "../host/index.mjs";

const enabled = process.env.CANTRIP_OS_SYSTEM_INTEGRATION === "1";
const root = fileURLToPath(new URL("../../", import.meta.url));

for (const heldAction of ["commit", "start"])
  test(
    `real Docker ${heldAction} reply loss survives coordinator death and private root export/reload`,
    { skip: !enabled, timeout: 240_000 },
    async () => {
      const engine = await LocalDocker.current();
      let directory;
      if (process.env.CANTRIP_OS_SYSTEM_EVIDENCE) {
        const evidenceRoot = resolve(process.env.CANTRIP_OS_SYSTEM_EVIDENCE);
        await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
        directory = await mkdtemp(join(evidenceRoot, `${heldAction}-`));
        await writeFile(
          join(evidenceRoot, `latest-${heldAction}.json`),
          JSON.stringify({ directory, heldAction }),
        );
      } else
        directory = await mkdtemp(join(tmpdir(), "cantrip-system-engine-"));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const dockerConfig = join(directory, "docker-config");
      await mkdir(dockerConfig, { recursive: true, mode: 0o700 });
      await writeFile(
        join(dockerConfig, "config.json"),
        JSON.stringify({ auths: {} }),
        { mode: 0o600 },
      );
      const suffix = randomUUID().slice(0, 12),
        name = `cantrip-system-${suffix}`,
        volume = `${name}-workspace`;
      let originalId, probeId, child;
      const imageIds = new Set(),
        mutations = [];
      const request = engine.request.bind(engine);
      engine.request = async (method, path, body, options) => {
        if (method !== "GET") mutations.push({ method, path });
        return request(method, path, body, options);
      };
      const event = async (name, status, context) =>
        appendFile(
          join(directory, "events.log"),
          "QA_EVT " + JSON.stringify({ event: name, status, context }) + "\n",
        );
      async function command(args, { input, env } = {}) {
        const processArgs = ["--config", dockerConfig, ...args];
        const proc = spawn("docker", processArgs, {
          env: { ...process.env, DOCKER_CONTEXT: "", ...env },
          stdio: ["pipe", "pipe", "pipe"],
        });
        const stdout = [],
          stderr = [];
        proc.stdout.on("data", (data) => stdout.push(data));
        proc.stderr.on("data", (data) => stderr.push(data));
        proc.stdin.on("error", () => {});
        proc.stdin.end(input);
        const [code, signal] = await once(proc, "close");
        const result = {
          code,
          signal,
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
        };
        assert.equal(code, 0, JSON.stringify({ args, ...result }).slice(-6000));
        return result.stdout;
      }
      const probe = async (id) => {
        const text = await command([
          "exec",
          id,
          "sh",
          "-c",
          "sha256sum /etc/cantrip-system-雪; stat -c '%a %u %g' /etc/cantrip-system-雪; dpkg-query -W -f='${Package} ${Version} ${db:Status-Status}\\n' ed; cat /var/lib/cantrip-system-starts",
        ]);
        return text;
      };
      try {
        const version = await request("GET", "/version");
        await writeFile(
          join(directory, "engine.json"),
          JSON.stringify(version, null, 2),
        );
        const image =
          process.env.CANTRIP_OS_SYSTEM_TEST_IMAGE ?? "debian:trixie-slim";
        const base = await request(
          "GET",
          `/images/${encodeURIComponent(image)}/json`,
        );
        await writeFile(
          join(directory, "base-image.json"),
          JSON.stringify(base, null, 2),
        );
        await request("POST", "/volumes/create", {
          Name: volume,
          Labels: { "io.cantrip.os.test": name },
        });
        const created = await request(
          "POST",
          `/containers/create?name=${name}`,
          {
            Image: base.Id,
            Labels: {
              "io.cantrip.os": "foundation",
              "io.cantrip.os.test": name,
            },
            Env: ["PRIVATE_SYSTEM_FIXTURE=must-stay-private"],
            Cmd: [
              "sh",
              "-c",
              "printf 'started\\n' >> /var/lib/cantrip-system-starts; exec sleep infinity",
            ],
            HostConfig: {
              Mounts: [
                {
                  Type: "volume",
                  Source: volume,
                  Target: "/home/cantrip",
                  VolumeOptions: { NoCopy: true },
                },
              ],
            },
          },
        );
        originalId = created.Id;
        await request("POST", `/containers/${originalId}/start`);
        await command([
          "exec",
          originalId,
          "sh",
          "-c",
          "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ed && rm -rf /var/lib/apt/lists/*",
        ]);
        const marker = Buffer.from([
          0,
          255,
          ...Buffer.from("arbitrary shared OS customization"),
        ]);
        const sha256 = createHash("sha256").update(marker).digest("hex");
        await command(
          [
            "exec",
            "-i",
            originalId,
            "sh",
            "-c",
            "cat > /etc/cantrip-system-雪; chmod 640 /etc/cantrip-system-雪; chown 12345:23456 /etc/cantrip-system-雪; printf 'ignored workspace and browser fixture' > /home/cantrip/mounted-marker",
          ],
          { input: marker },
        );
        const before = await probe(originalId);
        await writeFile(
          join(directory, "before-fixture.json"),
          JSON.stringify(
            { expectedSha256: sha256, actualProbe: before },
            null,
            2,
          ),
        );
        assert.ok(
          before.includes(sha256),
          JSON.stringify({ expectedSha256: sha256, actualProbe: before }),
        );
        assert.ok(before.includes("640 12345 23456"));
        assert.ok(before.includes("ed "));
        const input = {
          request: {
            operationId: randomUUID(),
            container: name,
            expectedContainerId: originalId,
            instanceId: randomUUID(),
            scopeKey: createHash("sha256").update(name).digest("hex"),
            resumeOriginal: true,
          },
          journalPath: join(directory, "checkpoint.json"),
        };
        const inputPath = join(directory, "input.json");
        await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 });
        child = spawn(
          process.execPath,
          [
            fileURLToPath(
              new URL(
                "./fixtures/system-checkpoint-child.mjs",
                import.meta.url,
              ),
            ),
            engine.socketPath,
            inputPath,
            heldAction,
          ],
          { stdio: ["ignore", "pipe", "pipe", "ipc"] },
        );
        const errors = [];
        child.stderr.on("data", (chunk) => errors.push(chunk));
        child.stdout.on("data", () => {});
        const effect = await new Promise((resolveEffect, reject) => {
          const timeout = setTimeout(
            () =>
              reject(
                new Error(
                  "No actual commit effect arrived: " +
                    Buffer.concat(errors).toString(),
                ),
              ),
            60_000,
          );
          child.once("message", (value) => {
            clearTimeout(timeout);
            resolveEffect(value);
          });
          child.once("exit", (code) => {
            clearTimeout(timeout);
            reject(
              new Error(
                "Coordinator ended before held reply: " +
                  code +
                  " " +
                  Buffer.concat(errors).toString(),
              ),
            );
          });
        });
        assert.equal(effect.event, "real-effect-reply-withheld");
        assert.equal(effect.action, heldAction);
        const admitted = JSON.parse(await readFile(input.journalPath, "utf8"));
        const capturedImageId =
          heldAction === "commit"
            ? effect.receipt.Id
            : admitted.snapshot.imageId;
        imageIds.add(capturedImageId);
        assert.equal(
          admitted.phase,
          heldAction === "commit" ? "commit-requested" : "resume-requested",
        );
        assert.equal(
          (await engine.inspect(originalId)).State.Running,
          heldAction === "start",
        );
        child.kill("SIGKILL");
        const [, signal] = await once(child, "exit");
        assert.equal(signal, "SIGKILL");
        child = null;
        const beforeRecovery = mutations.length;
        const observed = await observeSystemCheckpoint(engine, input);
        assert.equal(
          observed.operation.phase,
          heldAction === "commit" ? "captured" : "complete",
        );
        assert.equal(
          observed.operation.snapshot.evidence,
          heldAction === "commit"
            ? "observed-labeled-image"
            : "acknowledged-and-verified",
        );
        assert.equal(observed.operation.snapshot.imageId, capturedImageId);
        assert.equal(
          observed.operation.state,
          heldAction === "commit" ? "unknown" : "ready",
        );
        assert.equal(mutations.length, beforeRecovery);
        const repeated = await captureSystemCheckpoint(engine, input);
        assert.equal(
          repeated.operation.phase,
          heldAction === "commit" ? "captured" : "complete",
        );
        assert.equal(mutations.length, beforeRecovery);
        const completed = await continueSystemCheckpoint(engine, input);
        assert.equal(completed.operation.state, "ready");
        assert.deepEqual(
          mutations.slice(beforeRecovery),
          heldAction === "commit"
            ? [{ method: "POST", path: `/containers/${originalId}/start` }]
            : [],
        );
        const after = await probe(originalId);
        assert.ok(after.startsWith(before.split("\n").slice(0, 3).join("\n")));
        assert.equal(
          after.split("\n").filter((line) => line === "started").length,
          2,
        );
        assert.equal(
          await command([
            "exec",
            originalId,
            "cat",
            "/home/cantrip/mounted-marker",
          ]),
          "ignored workspace and browser fixture",
        );
        assert.deepEqual(
          completed.operation.snapshot.mounts.map((mount) => [
            mount.destination,
            mount.included,
          ]),
          [["/home/cantrip", false]],
        );
        await event(`actual-${heldAction}-coordinator-loss-no-replay`, "pass", {
          operationId: input.request.operationId,
          imageId: capturedImageId,
          postLossMutations: mutations.slice(beforeRecovery),
          starts: 2,
        });
        const requestFile = join(directory, "request.json");
        await writeFile(requestFile, JSON.stringify(input.request), {
          mode: 0o600,
        });
        const exported = join(directory, "private-system.tar");
        const exporter = spawn(
          process.execPath,
          [
            resolve(root, "cantrip_os/scripts/manage-system.mjs"),
            "export",
            requestFile,
            input.journalPath,
            exported,
          ],
          {
            env: { ...process.env, DOCKER_CONTEXT: "" },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        const exportOut = [],
          exportErr = [];
        exporter.stdout.on("data", (chunk) => exportOut.push(chunk));
        exporter.stderr.on("data", (chunk) => exportErr.push(chunk));
        const [exportCode] = await once(exporter, "close");
        assert.equal(exportCode, 0, Buffer.concat(exportErr).toString());
        const exportReceipt = JSON.parse(Buffer.concat(exportOut).toString());
        assert.ok(exportReceipt.bytes > 4 * 1024 * 1024);
        assert.equal(exportReceipt.mountedDataIncluded, false);
        assert.equal(exportReceipt.containsPrivateIdentity, true);
        if (process.platform !== "win32")
          assert.equal((await stat(exported)).mode & 0o777, 0o600);
        const bytes = await readFile(exported);
        assert.equal(
          createHash("sha256").update(bytes).digest("hex"),
          exportReceipt.sha256,
        );
        // Removing only this test's committed image forces a real reload, rather
        // than accepting a no-op load into a store that already had the bytes.
        await request(
          "DELETE",
          `/images/${encodeURIComponent(capturedImageId)}`,
        );
        await assert.rejects(
          request("GET", `/images/${encodeURIComponent(capturedImageId)}/json`),
          { status: 404 },
        );
        await command(["image", "load", "--input", exported]);
        const reloaded = await request(
          "GET",
          `/images/${encodeURIComponent(capturedImageId)}/json`,
        );
        assert.equal(reloaded.Id, capturedImageId);
        const probeCreated = await request(
          "POST",
          `/containers/create?name=${name}-restored-probe`,
          {
            Image: reloaded.Id,
            Cmd: [
              "sh",
              "-c",
              "sha256sum /etc/cantrip-system-雪; stat -c '%a %u %g' /etc/cantrip-system-雪; dpkg-query -W -f='${Package} ${Version} ${db:Status-Status}\\n' ed; test ! -e /home/cantrip/mounted-marker",
            ],
            HostConfig: { NetworkMode: "none" },
            Labels: { "io.cantrip.os.test": name },
          },
        );
        probeId = probeCreated.Id;
        await command(["start", "--attach", probeId]);
        const logs = await command(["logs", probeId]);
        assert.ok(logs.includes(sha256));
        assert.ok(logs.includes("640 12345 23456"));
        assert.match(logs, /ed .* installed/);
        assert.equal((await engine.inspect(probeId)).State.ExitCode, 0);
        await writeFile(
          join(directory, "completion.json"),
          JSON.stringify(
            {
              originalId,
              before,
              after,
              snapshot: completed.operation.snapshot,
              exportReceipt,
              restoredProbe: { containerId: probeId, stdout: logs },
              mutationLog: mutations,
            },
            null,
            2,
          ),
        );
        await event(
          "private-image-export-reload-actual-root-package-and-ownership",
          "pass",
          { ...exportReceipt, sameImageId: true, mountedDataNotIncluded: true },
        );
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await once(child, "exit");
        }
        for (const id of [probeId, originalId].filter(Boolean))
          await request("DELETE", `/containers/${id}?force=true&v=false`).catch(
            () => {},
          );
        for (const id of imageIds)
          await request("DELETE", `/images/${encodeURIComponent(id)}`).catch(
            () => {},
          );
        await request("DELETE", `/volumes/${encodeURIComponent(volume)}`).catch(
          () => {},
        );
        if (!process.env.CANTRIP_OS_SYSTEM_EVIDENCE)
          await rm(directory, { recursive: true, force: true });
      }
    },
  );
