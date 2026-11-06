import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { LocalDocker } from "@cantrip/os-host";
import { CantripOsSystemCheckpointManager } from "../src/os-executor/system-checkpoints.js";
import { privateSystemFixture } from "../src/os-executor/private-system-fixture.js";

const enabled = process.env.CANTRIP_OS_SYSTEM_INTEGRATION === "1";
for (const fault of ["published", "partial"] as const)
  it.skipIf(!enabled)(
    `actual Docker encrypted system transfer recovers ${fault} process death without recapturing`,
    async () => {
      const evidence = process.env.CANTRIP_OS_SYSTEM_EVIDENCE;
      if (evidence)
        await mkdir(resolve(evidence), { recursive: true, mode: 0o700 });
      const directory = await mkdtemp(
        join(evidence ? resolve(evidence) : tmpdir(), `system-${fault}-`),
      );
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const events = join(directory, "events.log");
      async function fileHash(file: string) {
        const digest = createHash("sha256");
        for await (const bytes of (await import("node:fs")).createReadStream(
          file,
        ))
          digest.update(bytes);
        return digest.digest("hex");
      }
      async function fileHeader(file: string) {
        const stream = createReadStream(file);
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        try {
          for await (const line of lines)
            return JSON.parse(line) as { streamId: string };
        } finally {
          lines.close();
          stream.destroy();
        }
        throw new Error("The fixture archive has no header");
      }
      const event = (name: string, context: unknown) =>
        appendFile(
          events,
          "QA_EVT " + JSON.stringify({ event: name, context }) + "\n",
        );
      const f = privateSystemFixture(),
        engine = await LocalDocker.current();
      const dockerConfig = join(directory, "docker-config");
      await mkdir(dockerConfig, { mode: 0o700 });
      await writeFile(join(dockerConfig, "config.json"), '{"auths":{}}', {
        mode: 0o600,
      });
      const name = `cantrip-private-system-${randomUUID().slice(0, 12)}`,
        volume = name + "-workspace";
      let originalId: string | undefined,
        loadedImage: string | undefined,
        child: ChildProcess | undefined;
      const request = engine.request.bind(engine);
      const mutations: string[] = [];
      engine.request = async (method, path, body, options) => {
        if (method !== "GET") mutations.push(path);
        return request(method, path, body, options);
      };
      async function command(args: string[], input?: Uint8Array) {
        const proc = spawn("docker", ["--config", dockerConfig, ...args], {
          env: { ...process.env, DOCKER_CONTEXT: "" },
          stdio: ["pipe", "pipe", "pipe"],
        });
        const stdout: Buffer[] = [],
          stderr: Buffer[] = [];
        proc.stdout.on("data", (b) => stdout.push(b));
        proc.stderr.on("data", (b) => stderr.push(b));
        proc.stdin.on("error", () => {});
        proc.stdin.end(input);
        const [code] = await once(proc, "close");
        const result = {
          code,
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
        };
        if (code !== 0)
          throw new Error(JSON.stringify({ args, ...result }).slice(-4000));
        return result.stdout;
      }
      try {
        const base = await request<{ Id: string }>(
          "GET",
          `/images/${encodeURIComponent(process.env.CANTRIP_OS_SYSTEM_TEST_IMAGE ?? "debian:trixie-slim")}/json`,
        );
        await writeFile(
          join(directory, "engine.json"),
          JSON.stringify(await request("GET", "/version"), null, 2),
        );
        await request("POST", "/volumes/create", {
          Name: volume,
          Labels: { "io.cantrip.os.test": name },
        });
        const created = await request<{ Id: string }>(
          "POST",
          `/containers/create?name=${name}`,
          {
            Image: base.Id,
            Labels: {
              "io.cantrip.os": "foundation",
              "io.cantrip.os.test": name,
            },
            Cmd: [
              "sh",
              "-c",
              "printf 'started\\n' >> /var/lib/cantrip-system-starts; exec sleep infinity",
            ],
            HostConfig: {
              Mounts: [
                { Type: "volume", Source: volume, Target: "/workspace" },
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
          "set -eu; apt-get update >/dev/null; apt-get install -y --no-install-recommends ed >/dev/null; dpkg-query -W -f='${Version}' ed; apt-get clean; rm -rf /var/lib/apt/lists/*",
        ]);
        const marker = Buffer.from([0, 255, 1, 2, 10, 65, 66, 67]);
        await command(
          [
            "exec",
            "-i",
            originalId,
            "sh",
            "-c",
            "cat > /etc/cantrip-system-雪; chmod 640 /etc/cantrip-system-雪; chown 12345:23456 /etc/cantrip-system-雪; printf 'mounted-before\\n' > /workspace/marker",
          ],
          marker,
        );
        const admission = {
          context: { ...f.context, containerId: originalId },
          container: name,
          resumeOriginal: true,
        };
        const markerPath = join(directory, "held.json"),
          configPath = join(directory, "child.json");
        await writeFile(
          configPath,
          JSON.stringify({
            directory,
            admission,
            key: Buffer.from(f.revisions.get(1)!).toString("base64"),
            fault,
            marker: markerPath,
            trace: join(directory, "child-engine.jsonl"),
          }),
          { mode: 0o600 },
        );
        child = spawn(
          process.execPath,
          [
            fileURLToPath(
              new URL(
                "fixtures/os-system-checkpoint-child.mjs",
                import.meta.url,
              ),
            ),
            configPath,
          ],
          {
            cwd: fileURLToPath(new URL("../", import.meta.url)),
            env: process.env,
            stdio: ["ignore", "pipe", "pipe", "ipc"],
          },
        );
        child.stdout!.on("data", (bytes) => {
          void appendFile(join(directory, "child.log"), bytes);
        });
        child.stderr!.on("data", (bytes) => {
          void appendFile(join(directory, "child.log"), bytes);
        });
        const message = await new Promise<{
          held?: string;
          unexpectedResult?: unknown;
        }>((resolveMessage, reject) => {
          const timer = setTimeout(
            () =>
              reject(
                new Error("The actual transfer never reached its held point"),
              ),
            180_000,
          );
          child!.once("message", (value) => {
            clearTimeout(timer);
            resolveMessage(value as { held?: string });
          });
          child!.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child!.once("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`Transfer exited before held reply: ${code}`));
          });
        });
        expect(message.held).toBe(fault);
        await event(
          "actual-transfer-held",
          JSON.parse(await readFile(markerPath, "utf8")),
        );
        const closed = once(child, "close");
        child.kill("SIGKILL");
        const [code, signal] = await closed;
        expect(code).toBeNull();
        expect(signal).toBe("SIGKILL");
        child = undefined;
        const trace = (
          await readFile(join(directory, "child-engine.jsonl"), "utf8")
        )
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line) as { method: string; path: string });
        expect(
          trace.filter(
            (item) =>
              item.path.startsWith("/commit?") && item.method === "POST",
          ),
        ).toHaveLength(1);
        expect(
          trace.filter(
            (item) => item.path.includes("/stop?") && item.method === "POST",
          ),
        ).toHaveLength(1);
        expect(
          trace.filter(
            (item) => item.path.endsWith("/start") && item.method === "POST",
          ),
        ).toHaveLength(1);
        expect(trace.filter((item) => item.method === "STREAM")).toHaveLength(
          1,
        );
        await command([
          "exec",
          originalId,
          "sh",
          "-c",
          "printf 'later-root\\n' > /etc/cantrip-later-root; printf 'mounted-after\\n' > /workspace/marker",
        ]);
        const scopeDirectory = join(
          directory,
          "cantrip-os-system-checkpoints",
          (await readdir(join(directory, "cantrip-os-system-checkpoints")))[0]!,
        );
        const archivePath = join(
          scopeDirectory,
          `${admission.context.operationId}.json.ctos-system`,
        );
        const before =
          fault === "published" ? await fileHash(archivePath) : null;
        const partial = (await readdir(scopeDirectory)).find((p) =>
          p.endsWith(".partial"),
        );
        if (fault === "partial") {
          expect(partial).toBeTruthy();
          expect(
            (await stat(join(scopeDirectory, partial!))).mode & 0o777,
          ).toBe(0o600);
        }
        // In the publication-loss case the Engine is deliberately unavailable to
        // the recovered Manager. The authenticated local artifact must suffice.
        const manager = new CantripOsSystemCheckpointManager(
          directory,
          f.context.workerId,
          f.keys,
          {
            docker: async () => {
              if (fault === "published")
                throw new Error(
                  "Engine intentionally unavailable after publication",
                );
              return engine;
            },
            seal: (await import("../src/os-executor/private-system-file.js"))
              .sealPrivateSystem,
          },
        );
        const observed = await manager.run(admission, "observe");
        expect(observed?.state).toBe(
          fault === "published" ? "ready" : "unknown",
        );
        const ready =
          fault === "partial"
            ? await manager.run(admission, "continue")
            : observed;
        expect(ready?.state).toBe("ready");
        if (before) expect(await fileHash(archivePath)).toBe(before);
        if (partial) {
          const header = await fileHeader(join(scopeDirectory, partial));
          const final = await fileHeader(archivePath);
          expect(header.streamId).not.toBe(final.streamId);
        }
        expect(await manager.run(admission, "execute")).toEqual(ready);
        const plaintextPath = join(directory, "verified-system.tar");
        const opened = await manager.open(admission, plaintextPath);
        loadedImage = opened.manifest.snapshot.imageId;
        expect(opened.manifest.snapshot.mounts).toMatchObject([
          { destination: "/workspace", included: false },
        ]);
        const actualHash = createHash("sha256");
        for await (const bytes of (await import("node:fs")).createReadStream(
          plaintextPath,
        ))
          actualHash.update(bytes);
        expect(actualHash.digest("hex")).toBe(opened.receipt.archiveSha256);
        // Remove only the image produced by this test, forcing load to supply it.
        await request("DELETE", `/images/${encodeURIComponent(loadedImage)}`);
        await command(["load", "--input", plaintextPath]);
        const loaded = await request<{ Id: string }>(
          "GET",
          `/images/${encodeURIComponent(loadedImage)}/json`,
        );
        expect(loaded.Id).toBe(loadedImage);
        const probe = await command([
          "run",
          "--rm",
          "--network",
          "none",
          loadedImage,
          "sh",
          "-c",
          "set -eu; sha256sum /etc/cantrip-system-雪; stat -c '%a %u %g' /etc/cantrip-system-雪; dpkg-query -W -f='${Version}\\n' ed; test ! -e /workspace/marker; test ! -e /etc/cantrip-later-root; cat /var/lib/cantrip-system-starts",
        ]);
        expect(probe).toContain(
          createHash("sha256").update(marker).digest("hex"),
        );
        expect(probe).toContain("640 12345 23456");
        expect(probe.match(/started/g)).toHaveLength(1);
        const original = await command([
          "exec",
          originalId,
          "sh",
          "-c",
          "cat /var/lib/cantrip-system-starts /workspace/marker /etc/cantrip-later-root",
        ]);
        expect(original.match(/started/g)).toHaveLength(2);
        expect(original).toContain("mounted-after");
        expect(original).toContain("later-root");
        await writeFile(
          join(directory, "result.json"),
          JSON.stringify(
            {
              admission,
              ready,
              receipt: opened.receipt,
              manifest: opened.manifest,
              probe,
              original,
              mutations,
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
        await event("verified-private-root-reload", {
          imageId: loadedImage,
          receipt: opened.receipt,
          originalStarts: 2,
        });
      } finally {
        if (child) {
          const closed = once(child, "close");
          child.kill("SIGKILL");
          await closed;
        }
        if (originalId)
          await request("DELETE", `/containers/${originalId}?force=true`);
        if (loadedImage)
          await request("DELETE", `/images/${encodeURIComponent(loadedImage)}`);
        else if (originalId) {
          const images = await request<Array<{ Id: string }>>(
            "GET",
            `/images/json?filters=${encodeURIComponent(JSON.stringify({ label: [`io.cantrip.os.system.container=${originalId}`] }))}`,
          );
          for (const image of images)
            await request("DELETE", `/images/${encodeURIComponent(image.Id)}`);
        }
        await request("DELETE", `/volumes/${volume}`);
        if (!evidence) await rm(directory, { recursive: true, force: true });
      }
    },
    420_000,
  );
