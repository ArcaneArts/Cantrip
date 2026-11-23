import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { DockerDeliveryError, type LocalDocker } from "@cantrip/os-host";
import { decryptCantripOsSystemFrame } from "@cantrip/crypto";
import { CantripOsSystemCheckpointManager } from "./system-checkpoints.js";
import { sealPrivateSystem } from "./private-system-file.js";
import { privateSystemFixture } from "./private-system-fixture.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cantrip-system-manager-"));
  directories.push(directory);
  const f = privateSystemFixture();
  const admission = {
    context: f.context,
    container: `system-${f.context.operationId}`,
    resumeOriginal: true,
  };
  const actual = {
    Id: f.context.containerId,
    Image: `sha256:${"d".repeat(64)}`,
    Config: {
      Labels: { "io.cantrip.os": "foundation" },
      Env: ["PRIVATE_FIXTURE=retained"],
      Cmd: ["init"],
    },
    State: { Running: true },
    Mounts: [
      {
        Type: "bind",
        Source: "/private/host/雪",
        Destination: "/project",
        RW: true,
      },
    ],
  };
  const images = new Map<string, Record<string, unknown>>(),
    effects: string[] = [];
  let loseCommit = false,
    unavailable = false,
    exports = 0;
  const data = Buffer.from("PRIVATE_ROOT_SYSTEM_IMAGE_雪");
  const engine = {
    inspect: async () => {
      if (unavailable) throw new Error("/private/engine-unavailable");
      return structuredClone(actual);
    },
    request: async (
      method: string,
      path: string,
      body: Record<string, unknown>,
    ) => {
      if (unavailable) throw new Error("/private/engine-unavailable");
      if (method === "GET") {
        if (path.startsWith("/images/json?"))
          return [...images.keys()].map((Id) => ({ Id }));
        const value = images.get(decodeURIComponent(path.split("/")[2]!));
        if (!value) throw new Error("Missing image");
        return structuredClone(value);
      }
      effects.push(path);
      if (path.includes("/stop?")) actual.State.Running = false;
      else if (path.endsWith("/start")) actual.State.Running = true;
      else if (path.startsWith("/commit?")) {
        expect(actual.State.Running).toBe(false);
        const Id = `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
        images.set(Id, {
          Id,
          Os: "linux",
          Architecture: "amd64",
          RootFS: { Layers: [] },
          Created: new Date().toISOString(),
          Size: data.length,
          Config: body,
        });
        if (loseCommit) {
          loseCommit = false;
          throw new DockerDeliveryError("/private/lost-commit-reply");
        }
        return { Id };
      } else throw new Error("Unexpected mutation");
      return null;
    },
    readStream: async () => {
      if (unavailable) throw new Error("/private/engine-unavailable");
      exports++;
      return Readable.from([data]);
    },
  } as unknown as LocalDocker;
  const manager = (seal = sealPrivateSystem) =>
    new CantripOsSystemCheckpointManager(
      directory,
      f.context.workerId,
      f.keys,
      { docker: async () => engine, seal },
    );
  const archive = async () => {
    const scopes = await readdir(
      join(directory, "cantrip-os-system-checkpoints"),
    );
    const folder = join(directory, "cantrip-os-system-checkpoints", scopes[0]!);
    return join(
      folder,
      (await readdir(folder)).find((p) => p.endsWith(".ctos-system"))!,
    );
  };
  return {
    ...f,
    directory,
    admission,
    actual,
    engine,
    effects,
    data,
    manager,
    archive,
    loseCommit: () => {
      loseCommit = true;
    },
    unavailable: () => {
      unavailable = true;
    },
    exports: () => exports,
  };
}
describe("durable Worker system checkpoint transfer", () => {
  it("durably prepares without capturing and continues the same admission once", async () => {
    const f = await fixture();
    const prepared = await f.manager().run(f.admission, "prepare");
    expect(prepared).toMatchObject({ state: "running", phase: "prepared" });
    expect(await f.manager().run(f.admission, "prepare")).toEqual(prepared);
    expect(f.effects).toEqual([]);
    expect(f.exports()).toBe(0);
    expect((await f.manager().run(f.admission, "continue"))?.state).toBe(
      "ready",
    );
    expect(f.effects).toHaveLength(3);
    expect(f.exports()).toBe(1);
  });
  it("does not dispatch an unstarted saved admission during observation", async () => {
    const f = await fixture();
    const unavailable = new CantripOsSystemCheckpointManager(
      f.directory,
      f.context.workerId,
      f.keys,
      {
        docker: async () => {
          throw new Error("Actual Engine connection failed before capture");
        },
        seal: sealPrivateSystem,
      },
    );
    expect((await unavailable.run(f.admission, "execute"))?.state).toBe(
      "unknown",
    );
    expect((await f.manager().run(f.admission, "execute"))?.state).toBe(
      "unknown",
    );
    expect(f.effects).toEqual([]);
    expect((await f.manager().run(f.admission, "continue"))?.state).toBe(
      "ready",
    );
    expect(f.effects).toHaveLength(3);
    expect(f.exports()).toBe(1);
  });
  it("retains completed history after artifact loss without silently exporting again", async () => {
    const f = await fixture();
    const ready = await f.manager().run(f.admission, "execute");
    await rm(await f.archive());
    expect(await f.manager().run(f.admission, "continue")).toEqual(ready);
    expect(f.exports()).toBe(1);
    expect(f.effects).toHaveLength(3);
    await expect(
      f.manager().open(f.admission, join(f.directory, "missing.tar")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("captures once, retains its exact encrypted archive and immutable terminal result across Manager/key changes", async () => {
    const f = await fixture();
    const ready = await f.manager().run(f.admission, "execute");
    expect(ready?.state).toBe("ready");
    expect(f.effects).toHaveLength(3);
    expect(f.exports()).toBe(1);
    const bytes = await readFile(await f.archive());
    f.rotate();
    f.unavailable();
    expect(await f.manager().run(f.admission, "execute")).toEqual(ready);
    expect(await f.manager().run(f.admission, "observe")).toEqual(ready);
    expect((await readFile(await f.archive())).equals(bytes)).toBe(true);
    expect(f.effects).toHaveLength(3);
    expect(f.exports()).toBe(1);
    const destination = join(f.directory, "verified.tar");
    await f.manager().open(f.admission, destination);
    expect((await readFile(destination)).equals(f.data)).toBe(true);
    const proof = ready!.protectedResult!;
    const plaintext = await decryptCantripOsSystemFrame({
      context: f.context,
      ...proof,
      componentKey: new Uint8Array(f.revisions.get(proof.keyRevision)!),
    });
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toMatchObject({
      manifest: {
        snapshot: {
          identityPolicy: "same-instance-only",
          mounts: [{ included: false }],
        },
      },
    });
    f.lock();
    expect(await f.manager().run(f.admission, "observe")).toEqual(ready);
  });
  it("recovers a published archive after its receipt is lost without accessing Docker or regenerating ciphertext", async () => {
    const f = await fixture();
    const lost = await f
      .manager(async (input) => {
        await sealPrivateSystem(input);
        throw new Error("/private/publication-reply-lost");
      })
      .run(f.admission, "execute");
    expect(lost?.state).toBe("unknown");
    expect(JSON.stringify(lost)).not.toContain("/private/");
    const bytes = await readFile(await f.archive());
    f.unavailable();
    f.rotate();
    const ready = await f.manager().run(f.admission, "observe");
    expect(ready?.state).toBe("ready");
    expect(ready?.protectedResult?.keyRevision).toBe(2);
    expect((await readFile(await f.archive())).equals(bytes)).toBe(true);
    expect(f.exports()).toBe(1);
    expect(f.effects).toHaveLength(3);
    expect(await f.manager().run(f.admission, "observe")).toEqual(ready);
  });
  it("observes a lost commit, continues only unrequested resume/export, and never repeats capture", async () => {
    const f = await fixture();
    f.loseCommit();
    expect((await f.manager().run(f.admission, "execute"))?.state).toBe(
      "unknown",
    );
    expect(f.effects).toHaveLength(2);
    expect(f.exports()).toBe(0);
    expect((await f.manager().run(f.admission, "observe"))?.state).toBe(
      "unknown",
    );
    expect(f.effects).toHaveLength(2);
    expect(f.exports()).toBe(0);
    expect((await f.manager().run(f.admission, "continue"))?.state).toBe(
      "ready",
    );
    expect(f.effects).toHaveLength(3);
    expect(f.exports()).toBe(1);
  });
  it("requires explicit continuation after an unpublished stream failure and preserves a corrupt published artifact", async () => {
    const f = await fixture();
    expect(
      (
        await f
          .manager(async () => {
            throw new Error("actual download interrupted");
          })
          .run(f.admission, "execute")
      )?.state,
    ).toBe("unknown");
    expect((await f.manager().run(f.admission, "observe"))?.state).toBe(
      "unknown",
    );
    expect(f.exports()).toBe(1);
    expect((await f.manager().run(f.admission, "continue"))?.state).toBe(
      "ready",
    );
    expect(f.exports()).toBe(2);
    const g = await fixture();
    await g
      .manager(async (input) => {
        await sealPrivateSystem(input);
        throw new Error("lost receipt");
      })
      .run(g.admission, "execute");
    const file = await g.archive();
    await writeFile(file, "corrupt retained archive\n");
    expect((await g.manager().run(g.admission, "continue"))?.state).toBe(
      "unknown",
    );
    expect(await readFile(file, "utf8")).toBe("corrupt retained archive\n");
    expect(g.exports()).toBe(1);
  });
  it("fences changed admissions and requires a real grant before any Engine effect", async () => {
    const f = await fixture();
    expect(await f.manager().run(f.admission, "observe")).toBeNull();
    await f.manager().run(f.admission, "execute");
    await expect(
      f.manager().run({ ...f.admission, resumeOriginal: false }, "execute"),
    ).rejects.toThrow("immutable admission");
    await expect(
      f.manager().run(
        {
          ...f.admission,
          context: { ...f.context, targetGeneration: f.context.operationId },
        },
        "observe",
      ),
    ).rejects.toThrow("immutable admission");
    f.changeOwner();
    await expect(f.manager().run(f.admission, "observe")).rejects.toThrow(
      "owner",
    );
    const g = await fixture();
    g.lock();
    await expect(g.manager().run(g.admission, "execute")).rejects.toThrow(
      "grant",
    );
    expect(g.effects).toEqual([]);
    expect(g.exports()).toBe(0);
  });
});
