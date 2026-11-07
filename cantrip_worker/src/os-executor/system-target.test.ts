import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { systemFixture, tarFile } from "./system-test-fixture.js";
import { systemTarget, readSystemFile } from "./system-target.js";

describe("external Docker system identity", () => {
  it("keeps verified management authority when optional image metadata is unavailable", async () => {
    const f = systemFixture();
    f.images.delete(f.baseId);
    const current = await systemTarget(f.engine, f.name, f.scope);
    expect(current.target.containerId).toBe(f.rootId);
    expect(current.target.architecture).toBeNull();
  });
  it("reads a stopped container without executing helpers and follows configured relocation", async () => {
    const f = systemFixture();
    f.root.State.Running = false;
    f.files.set(
      "/etc/cantrip-os/executor.json",
      Buffer.from(JSON.stringify({ state_dir: "/custom/雪/../identity" })),
    );
    f.files.set(
      "/custom/identity/instance.json",
      Buffer.from(JSON.stringify(f.identity)),
    );
    const first = await systemTarget(f.engine, f.name, f.scope);
    expect(first.running).toBe(false);
    expect(first.target.expected.identityPath).toBe(
      "/custom/identity/instance.json",
    );
    expect(
      (await systemTarget(f.engine, f.name, f.scope, first.target)).target,
    ).toEqual(first.target);
    expect(f.effects).toEqual([]);
  });
  it("retains only a previously verified physical identity when its files are broken, and refuses valid foreign identities", async () => {
    const f = systemFixture(),
      first = await systemTarget(f.engine, f.name, f.scope);
    f.files.set("/etc/cantrip-os/executor.json", Buffer.from("broken config"));
    f.files.set(f.identityPath, Buffer.from("broken identity"));
    await expect(systemTarget(f.engine, f.name, f.scope)).rejects.toThrow();
    expect(
      (await systemTarget(f.engine, f.name, f.scope, first.target)).target
        .identityEvidence,
    ).toBe("retained-container");
    f.files.set(
      f.identityPath,
      Buffer.from(
        JSON.stringify({
          ...f.identity,
          audit: true,
          attachment: {
            owner_id: "foreign-owner",
            worker_id: f.scope.workerId,
          },
        }),
      ),
    );
    await expect(
      systemTarget(f.engine, f.name, f.scope, first.target),
    ).rejects.toThrow("identity changed");
    f.files.set(
      f.identityPath,
      Buffer.from(JSON.stringify({ ...f.identity, instance_id: randomUUID() })),
    );
    await expect(
      systemTarget(f.engine, f.name, f.scope, first.target),
    ).rejects.toThrow("identity changed");
  });
  it("does not substitute a replacement physical container when the old locator is unavailable", async () => {
    const f = systemFixture(),
      first = await systemTarget(f.engine, f.name, f.scope);
    f.root.Id = "d".repeat(64);
    f.files.clear();
    await expect(
      systemTarget(f.engine, f.name, f.scope, first.target),
    ).rejects.toThrow();
    expect(f.effects).toEqual([]);
  });
  it("follows guest-local symlinks without extracting them and rejects corrupt or multiple-file archives", async () => {
    const f = systemFixture();
    let calls = 0;
    f.engine.readStream = async () =>
      Readable.from([
        calls++
          ? tarFile(Buffer.from("verified"))
          : tarFile(Buffer.alloc(0), { kind: "2", link: "../identity.json" }),
      ]);
    expect(
      (await readSystemFile(f.engine, f.rootId, "/etc/config.json")).toString(),
    ).toBe("verified");
    expect(calls).toBe(2);
    const good = tarFile(Buffer.from("verified")),
      corrupt = Buffer.from(good);
    corrupt[0] = 0;
    for (const data of [
      corrupt,
      good.subarray(0, good.length - 512),
      Buffer.concat([good.subarray(0, good.length - 1024), good]),
    ]) {
      f.engine.readStream = async () => Readable.from([data]);
      await expect(
        readSystemFile(f.engine, f.rootId, "/etc/config.json"),
      ).rejects.toThrow();
    }
  });
});
