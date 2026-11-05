import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OsTunnelServices } from "../src/os-executor/tunnel-services.js";
import {
  remoteControl,
  type OsExecutorTransport,
} from "../src/os-executor/connection.js";
import {
  protectedOsTunnel,
  type Descriptor,
} from "./fixtures/os-protected-tunnel.js";

const run = promisify(execFile);
const transport: OsExecutorTransport | undefined = process.env
  .CANTRIP_OS_CUA_TEST_TRANSPORT
  ? JSON.parse(readFileSync(process.env.CANTRIP_OS_CUA_TEST_TRANSPORT, "utf8"))
  : process.env.CANTRIP_OS_CUA_TEST_CONTAINER
    ? { kind: "docker", container: process.env.CANTRIP_OS_CUA_TEST_CONTAINER }
    : undefined;

describe.skipIf(!transport)("actual managed workspace SSH / SFTP", () => {
  it("admits its encrypted public key, pins the real host, transfers files and retires a live session", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cantrip-os-ssh-"));
    let services: OsTunnelServices | undefined;
    const sockets = new Set<Socket>();
    const listener = createServer({ allowHalfOpen: true });
    let idle: ReturnType<typeof spawn> | undefined;
    try {
      const key = path.join(directory, "client"),
        otherKey = path.join(directory, "other");
      await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
      await run("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        otherKey,
      ]);
      const publicKey = (await readFile(key + ".pub", "utf8"))
        .trim()
        .split(/\s+/u)
        .slice(0, 2)
        .join(" ");
      const descriptor = await remoteControl<Descriptor>(transport!, [
        "service-info",
        "cua-a",
        "--service",
        '{"kind":"ssh"}',
      ]);
      const fixture = await protectedOsTunnel(
        transport!,
        directory,
        descriptor,
        { kind: "worker-os-ssh", publicKey },
      );
      expect(JSON.stringify(fixture.record)).not.toContain(publicKey);
      services = new OsTunnelServices(fixture.worker, descriptor.worker_id);
      const prepared = await services.prepare(fixture.prepared);
      expect(prepared.ssh).toEqual({
        user: descriptor.user,
        hostAlias: `cantrip-os-${descriptor.instance_id}`,
        hostKey: descriptor.ssh_host_key,
      });
      services.activate(fixture.grant, fixture.session);
      const connectionErrors: Error[] = [];
      listener.on("connection", (socket) => {
        sockets.add(socket);
        socket.pause();
        socket.on("error", () => {});
        socket.once("close", () => sockets.delete(socket));
        void services!
          .open(
            fixture.attachmentId,
            fixture.tunnelId,
            fixture.record,
            fixture.content,
          )
          .then(
            (stream) => {
              if (socket.destroyed) {
                stream.destroy();
                return;
              }
              stream.on("error", () => socket.destroy());
              stream.once("close", () => socket.destroy());
              socket.once("close", () => stream.destroy());
              socket.pipe(stream).pipe(socket);
              socket.resume();
            },
            (error) => {
              connectionErrors.push(error);
              socket.destroy();
            },
          );
      });
      listener.listen(0, "127.0.0.1");
      await once(listener, "listening");
      const port = (listener.address() as { port: number }).port;
      const known = path.join(directory, "known_hosts");
      await writeFile(
        known,
        `${prepared.ssh!.hostAlias} ${prepared.ssh!.hostKey}\n`,
        { mode: 0o600 },
      );
      const options = [
        "-oBatchMode=yes",
        "-oConnectTimeout=15",
        "-oStrictHostKeyChecking=yes",
        `-oUserKnownHostsFile=${known}`,
        `-oHostKeyAlias=${prepared.ssh!.hostAlias}`,
        "-oIdentitiesOnly=yes",
        "-i",
        key,
      ];
      const target = `${prepared.ssh!.user}@127.0.0.1`;
      const result = await run(
        "ssh",
        [...options, "-p", String(port), target, "id -u; pwd; sudo -n id -u"],
        { timeout: 30_000 },
      );
      expect(result.stdout.trim().split("\n")).toEqual([
        String(descriptor.uid),
        descriptor.home,
        "0",
      ]);
      await expect(
        run(
          "ssh",
          [
            ...options.slice(0, -1),
            otherKey,
            "-p",
            String(port),
            target,
            "true",
          ],
          { timeout: 30_000 },
        ),
      ).rejects.toMatchObject({ code: 255 });
      await expect(
        run("ssh", [...options, "-p", String(port), "root@127.0.0.1", "true"], {
          timeout: 30_000,
        }),
      ).rejects.toMatchObject({ code: 255 });
      const payload = Buffer.from("Cantrip SFTP\nClipboard café 日本語\n");
      const local = path.join(directory, "input.txt"),
        downloaded = path.join(directory, "output.txt");
      const remote = `cantrip-ssh-proof-${randomUUID()}.txt`;
      await writeFile(local, payload);
      const batch = path.join(directory, "sftp.batch");
      await writeFile(
        batch,
        `put "${local}" ${remote}\nget ${remote} "${downloaded}"\nrm ${remote}\n`,
      );
      await run(
        "sftp",
        [...options, "-q", "-b", batch, "-P", String(port), target],
        { timeout: 30_000 },
      );
      expect(await readFile(downloaded)).toEqual(payload);
      const wrongKnown = path.join(directory, "wrong_hosts");
      const otherPublic = (await readFile(otherKey + ".pub", "utf8"))
        .trim()
        .split(/\s+/u)
        .slice(0, 2)
        .join(" ");
      await writeFile(
        wrongKnown,
        `${prepared.ssh!.hostAlias} ${otherPublic}\n`,
      );
      await expect(
        run(
          "ssh",
          [
            ...options.filter((x) => !x.startsWith("-oUserKnownHostsFile=")),
            `-oUserKnownHostsFile=${wrongKnown}`,
            "-p",
            String(port),
            target,
            "true",
          ],
          { timeout: 30_000 },
        ),
      ).rejects.toMatchObject({ code: 255 });
      idle = spawn(
        "ssh",
        [...options, "-p", String(port), target, "echo READY; exec sleep 60"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const exited = once(idle, "exit");
      const ready = await Promise.race([
        once(idle.stdout!, "data").then(([bytes]) => String(bytes)),
        exited.then(() => {
          throw new Error("Idle SSH exited before admission.");
        }),
        new Promise<string>((_, reject) => {
          const t = setTimeout(
            () => reject(new Error("Idle SSH readiness timed out.")),
            20_000,
          );
          t.unref();
        }),
      ]);
      expect(ready).toContain("READY");
      await services.revoke(fixture.attachmentId, fixture.grantId);
      const [code] = await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          const t = setTimeout(
            () => reject(new Error("Retired SSH remained connected.")),
            5_000,
          );
          t.unref();
        }),
      ]);
      expect(code).not.toBe(0);
      expect(connectionErrors).toEqual([]);
      await expect(
        services.open(
          fixture.attachmentId,
          fixture.tunnelId,
          fixture.record,
          fixture.content,
        ),
      ).rejects.toThrow(/canonical grant/);
    } finally {
      idle?.kill();
      for (const socket of sockets) socket.destroy();
      await services?.disconnect();
      if (listener.listening)
        await new Promise<void>((resolve, reject) =>
          listener.close((error) => (error ? reject(error) : resolve())),
        );
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
