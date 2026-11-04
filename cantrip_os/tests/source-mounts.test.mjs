import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DockerDeliveryError,
  dependencyVolumes,
  finalizeRecreation,
  mountedConfiguration,
  recreateWithSources,
  sourceMountsLabel,
} from "../host/index.mjs";

const instanceId = "00000000-0000-4000-8000-000000000001";
const binding = (id = randomUUID()) => ({
  id,
  cacheKey: "source:worktree:workspace",
  workerPath: "/selected/worktree",
  guestPath: `/workspace/${id}`,
  dependencyOverlays: [{ path: "node_modules" }],
});
const original = () => ({
  Id: "original-container",
  Image: "old-image",
  Name: "/test-os",
  Config: {
    Labels: { "io.cantrip.os": "foundation" },
    Env: ["DEFAULT=old", "CUSTOM=retained", "EMPTY"],
    Image: "old-image",
  },
  HostConfig: {
    Binds: ["personal:/home/cantrip"],
    Memory: 4 * 1024 ** 3,
    PortBindings: { "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: "6080" }] },
  },
  Mounts: [
    {
      Type: "volume",
      Name: "anonymous-retained",
      Destination: "/image-data",
      RW: true,
    },
  ],
  NetworkSettings: { Networks: { bridge: {} } },
});

test("source mount configuration preserves named/anonymous data and uses stable Linux-only caches", () => {
  const mount = binding(),
    record = original();
  const result = mountedConfiguration(record, instanceId, [mount]);
  assert.equal(result.HostConfig.Memory, record.HostConfig.Memory);
  assert.deepEqual(
    result.HostConfig.PortBindings,
    record.HostConfig.PortBindings,
  );
  assert.deepEqual(result.HostConfig.Binds, record.HostConfig.Binds);
  assert.ok(
    result.HostConfig.Mounts.some(
      (m) => m.Source === "anonymous-retained" && m.Target === "/image-data",
    ),
  );
  assert.equal(
    result.HostConfig.Mounts.filter((m) => m.Type === "bind").length,
    1,
  );
  assert.ok(
    result.HostConfig.Mounts.filter((m) => m.Type === "volume").every(
      (m) => m.VolumeOptions.NoCopy,
    ),
  );
  assert.equal(
    dependencyVolumes(instanceId, [mount])[0].name,
    dependencyVolumes(instanceId, [binding()])[0].name,
  );
  const changed = { ...mount, dependencyOverlays: [] };
  const next = mountedConfiguration(
    { ...record, Config: result, HostConfig: result.HostConfig },
    instanceId,
    [changed],
  );
  assert.ok(
    !next.HostConfig.Mounts.some((m) => m.Target.endsWith("/node_modules")),
  );
  assert.equal(record.Config.Labels[sourceMountsLabel], undefined);
});

test("an uncertain snapshot is journaled and never replayed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cantrip-os-mount-unknown-"));
  const journalPath = join(directory, "operation.json"),
    calls = [];
  const engine = {
    inspect: async () => original(),
    request: async (...args) => {
      calls.push(args);
      throw new DockerDeliveryError("lost snapshot receipt");
    },
  };
  const input = {
    container: `test-${randomUUID()}`,
    expectedContainerId: "original-container",
    instanceId,
    bindings: [binding()],
    operationId: randomUUID(),
    journalPath,
  };
  try {
    await assert.rejects(recreateWithSources(engine, input), {
      delivery: "unknown",
    });
    assert.equal(
      JSON.parse(await readFile(journalPath, "utf8")).phase,
      "snapshot-system-requested",
    );
    await assert.rejects(recreateWithSources(engine, input), {
      code: "EEXIST",
    });
    assert.equal(calls.length, 1);
    assert.ok(calls[0][1].startsWith("/commit?"));
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("image replacement adopts new defaults and preserves live overrides, mounts and recovery state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cantrip-os-mount-image-"));
  const journalPath = join(directory, "operation.json"),
    calls = [];
  const mount = binding(),
    record = original();
  record.Config.Labels[sourceMountsLabel] = JSON.stringify({
    version: 1,
    instanceId,
    bindings: [mount],
  });
  let created;
  const engine = {
    inspect: async () => record,
    request: async (method, path, body) => {
      calls.push([method, path]);
      if (path === "/images/old-image/json")
        return {
          Config: {
            Env: ["DEFAULT=old"],
            Labels: { "io.cantrip.os": "foundation" },
          },
        };
      if (path === "/images/new-image/json")
        return {
          Config: {
            Env: ["DEFAULT=new", "ADDED=yes"],
            Labels: { "io.cantrip.os": "foundation", "new-default": "yes" },
          },
        };
      if (path.startsWith("/containers/create?")) {
        created = body;
        return { Id: "candidate-container" };
      }
      return null;
    },
  };
  try {
    await recreateWithSources(engine, {
      container: `test-${randomUUID()}`,
      expectedContainerId: record.Id,
      instanceId,
      bindings: [mount],
      operationId: randomUUID(),
      journalPath,
      image: "new-image",
    });
    assert.deepEqual(created.Env, [
      "DEFAULT=new",
      "ADDED=yes",
      "CUSTOM=retained",
      "EMPTY",
    ]);
    assert.equal(created.Image, "new-image");
    assert.equal(created.Labels["new-default"], "yes");
    assert.equal(
      created.Labels[sourceMountsLabel],
      record.Config.Labels[sourceMountsLabel],
    );
    assert.ok(!calls.some(([, path]) => path.startsWith("/commit?")));
    assert.equal(
      JSON.parse(await readFile(journalPath, "utf8")).phase,
      "start-completed",
    );
    await assert.rejects(
      finalizeRecreation(
        { ...engine, inspect: async () => ({ Id: "unexpected-replacement" }) },
        journalPath,
      ),
      /changed/,
    );
    assert.ok(!calls.some(([method]) => method === "DELETE"));
    await finalizeRecreation(
      { ...engine, inspect: async () => ({ Id: "candidate-container" }) },
      journalPath,
    );
    assert.ok(
      calls.some(
        ([method, path]) =>
          method === "DELETE" &&
          path === "/containers/original-container?v=false",
      ),
    );
    assert.equal(
      JSON.parse(await readFile(journalPath, "utf8")).phase,
      "complete",
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});
