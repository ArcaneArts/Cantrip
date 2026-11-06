import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  captureSystemCheckpoint,
  observeSystemCheckpoint,
  continueSystemCheckpoint,
  openSystemCheckpointImage,
  DockerDeliveryError,
} from "../host/index.mjs";

async function fixture({ running = true, resumeOriginal = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "cantrip-system-"));
  const input = {
    journalPath: join(directory, "private.json"),
    request: {
      operationId: randomUUID(),
      container: `system-${randomUUID()}`,
      expectedContainerId: "a".repeat(64),
      instanceId: randomUUID(),
      scopeKey: "c".repeat(64),
      resumeOriginal,
    },
  };
  const actual = {
    Id: input.request.expectedContainerId,
    Image: `sha256:${"d".repeat(64)}`,
    Config: {
      Labels: { "io.cantrip.os": "foundation" },
      Env: ["PRIVATE_DUMMY=retained"],
      Cmd: ["original-init"],
    },
    State: { Running: running, StartedAt: "original-start" },
    Mounts: [
      {
        Type: "volume",
        Name: "workspace-private",
        Destination: "/var/lib/cantrip-os-workspaces",
        RW: true,
      },
      {
        Type: "bind",
        Source: "/private/host/worktree",
        Destination: "/projects/source",
        RW: true,
      },
    ],
  };
  const images = new Map(),
    mutations = [],
    reads = [];
  let lose = null,
    unavailable = false;
  const engine = {
    inspect: async () => {
      if (unavailable) throw new Error("Actual Engine connection failed");
      return structuredClone(actual);
    },
    request: async (method, path, body) => {
      if (unavailable) throw new Error("Actual Engine connection failed");
      if (method === "GET") {
        if (path.startsWith("/images/json?")) {
          const filters = JSON.parse(
            new URL("http://engine" + path).searchParams.get("filters"),
          );
          return [...images.values()]
            .filter((image) =>
              filters.label.every((label) => {
                const at = label.indexOf("=");
                return (
                  image.Config.Labels[label.slice(0, at)] ===
                  label.slice(at + 1)
                );
              }),
            )
            .map(({ Id }) => ({ Id }));
        }
        const id = decodeURIComponent(path.split("/")[2]);
        if (!images.has(id)) throw new Error("Actual image missing");
        return structuredClone(images.get(id));
      }
      mutations.push({ method, path, body: structuredClone(body) });
      let result = null,
        action;
      if (path.includes("/stop?")) {
        action = "stop";
        actual.State.Running = false;
      } else if (path.startsWith("/commit?")) {
        action = "commit";
        assert.equal(
          actual.State.Running,
          false,
          "capture happens only after actual stop",
        );
        const id = `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
        images.set(id, {
          Id: id,
          Os: "linux",
          Architecture: "amd64",
          RootFS: { Layers: ["sha256:layer"] },
          Created: new Date().toISOString(),
          Size: 1234,
          Config: structuredClone(body),
        });
        result = { Id: id };
      } else if (path.endsWith("/start")) {
        action = "start";
        actual.State.Running = true;
        actual.State.StartedAt = randomUUID();
      } else throw new Error("Unexpected mutation: " + path);
      if (lose === action) {
        lose = null;
        throw new DockerDeliveryError(
          "Actual " + action + " reply lost after effect",
        );
      }
      return result;
    },
    readStream: async (path) => {
      reads.push(path);
      return Readable.from([Buffer.from("private-system-image")]);
    },
  };
  return {
    directory,
    input,
    actual,
    images,
    mutations,
    reads,
    engine,
    lose: (action) => {
      lose = action;
    },
    unavailable: () => {
      unavailable = true;
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test("capture stops all container writers before preserving root and resuming the exact original", async () => {
  const f = await fixture();
  try {
    const result = await captureSystemCheckpoint(f.engine, f.input);
    assert.equal(result.operation.state, "ready");
    assert.equal(result.operation.resumeEvidence, "acknowledged-and-observed");
    assert.equal(
      result.operation.snapshot.consistency,
      "stopped-container-filesystem",
    );
    assert.equal(result.operation.snapshot.containsPrivateIdentity, true);
    assert.equal(
      result.operation.snapshot.identityPolicy,
      "same-instance-only",
    );
    assert.equal(result.operation.snapshot.runtimeHandlesRestored, false);
    assert.deepEqual(
      result.operation.snapshot.mounts.map((m) => [m.destination, m.included]),
      [
        ["/var/lib/cantrip-os-workspaces", false],
        ["/projects/source", false],
      ],
    );
    assert.deepEqual(
      f.mutations.map((m) =>
        m.path.includes("/stop?")
          ? "stop"
          : m.path.startsWith("/commit?")
            ? "commit"
            : "start",
      ),
      ["stop", "commit", "start"],
    );
    assert.ok(
      f.mutations.every((m) =>
        m.path.includes(f.input.request.expectedContainerId),
      ),
    );
    assert.deepEqual(f.mutations[1].body.Env, f.actual.Config.Env);
    const again = await captureSystemCheckpoint(f.engine, f.input);
    assert.deepEqual(again.operation, result.operation);
    assert.equal(f.mutations.length, 3);
    if (process.platform !== "win32")
      assert.equal((await stat(f.input.journalPath)).mode & 0o777, 0o600);
    f.unavailable();
    const offline = await observeSystemCheckpoint(f.engine, f.input);
    assert.deepEqual(offline.operation, result.operation);
    assert.match(offline.observationError, /Actual Engine/);
  } finally {
    await f.cleanup();
  }
});

for (const options of [{ running: false }, { resumeOriginal: false }])
  test(
    "capture preserves explicit stopped power policy " +
      JSON.stringify(options),
    async () => {
      const f = await fixture(options);
      try {
        const { operation } = await captureSystemCheckpoint(f.engine, f.input);
        assert.equal(operation.state, "ready");
        assert.equal(operation.resumeEvidence, "not-requested");
        assert.equal(f.actual.State.Running, false);
        assert.ok(!f.mutations.some((m) => m.path.endsWith("/start")));
      } finally {
        await f.cleanup();
      }
    },
  );

for (const action of ["stop", "commit", "start"])
  test(
    "lost " +
      action +
      " reply is observed without replay; only unrequested steps need continuation",
    async () => {
      const f = await fixture();
      try {
        f.lose(action);
        let result = await captureSystemCheckpoint(f.engine, f.input);
        const count = f.mutations.length;
        assert.match(result.operation.lastError, /reply lost after effect/);
        if (action !== "start") assert.equal(result.operation.state, "unknown");
        else assert.equal(result.operation.state, "ready");
        result = await captureSystemCheckpoint(f.engine, f.input);
        assert.equal(f.mutations.length, count);
        result = await observeSystemCheckpoint(f.engine, f.input);
        assert.equal(f.mutations.length, count);
        result = await continueSystemCheckpoint(f.engine, f.input);
        assert.equal(result.operation.state, "ready");
        assert.equal(
          f.mutations.filter((m) => m.path.includes("/stop?")).length,
          1,
        );
        assert.equal(
          f.mutations.filter((m) => m.path.startsWith("/commit?")).length,
          1,
        );
        assert.equal(
          f.mutations.filter((m) => m.path.endsWith("/start")).length,
          1,
        );
        if (action === "commit")
          assert.equal(
            result.operation.snapshot.evidence,
            "observed-labeled-image",
          );
      } finally {
        await f.cleanup();
      }
    },
  );

test("a requested commit with no matching image stays unknown even under explicit continuation", async () => {
  const f = await fixture();
  try {
    f.lose("commit");
    await captureSystemCheckpoint(f.engine, f.input);
    // Emulate loss before an image was visible, with the same durable claim.
    const record = JSON.parse(await readFile(f.input.journalPath, "utf8"));
    record.phase = "commit-requested";
    record.snapshot = null;
    f.images.clear();
    await writeFile(f.input.journalPath, JSON.stringify(record));
    const count = f.mutations.length;
    const result = await continueSystemCheckpoint(f.engine, f.input);
    assert.equal(result.operation.state, "unknown");
    assert.equal(result.operation.phase, "commit-requested");
    assert.equal(f.mutations.length, count);
    await assert.rejects(
      openSystemCheckpointImage(f.engine, f.input),
      /No verified system image/,
    );
  } finally {
    await f.cleanup();
  }
});

test("foreign image labels and multiple matching candidates do not manufacture a recovered checkpoint", async () => {
  for (const kind of ["foreign", "duplicate"]) {
    const f = await fixture();
    try {
      f.lose("commit");
      await captureSystemCheckpoint(f.engine, f.input);
      const record = JSON.parse(await readFile(f.input.journalPath, "utf8"));
      record.phase = "commit-requested";
      record.snapshot = null;
      await writeFile(f.input.journalPath, JSON.stringify(record));
      const image = [...f.images.values()][0];
      if (kind === "foreign")
        image.Config.Labels["io.cantrip.os.system.request"] = "foreign";
      else {
        const duplicate = structuredClone(image);
        duplicate.Id = `sha256:${"e".repeat(64)}`;
        f.images.set(duplicate.Id, duplicate);
      }
      const count = f.mutations.length;
      const result = await continueSystemCheckpoint(f.engine, f.input);
      assert.equal(result.operation.state, "unknown");
      assert.equal(result.operation.snapshot, null);
      assert.equal(f.mutations.length, count);
      if (kind === "duplicate")
        assert.match(result.observationError, /More than one image/);
    } finally {
      await f.cleanup();
    }
  }
});

test("the immutable image export reads actual bytes without another lifecycle mutation", async () => {
  const f = await fixture();
  try {
    const result = await captureSystemCheckpoint(f.engine, f.input);
    const count = f.mutations.length;
    const stream = await openSystemCheckpointImage(f.engine, f.input);
    const blocks = [];
    for await (const block of stream) blocks.push(block);
    assert.equal(Buffer.concat(blocks).toString(), "private-system-image");
    assert.equal(f.mutations.length, count);
    assert.equal(
      f.reads[0],
      `/images/${encodeURIComponent(result.operation.snapshot.imageId)}/get`,
    );
    [...f.images.values()][0].Config.Labels["io.cantrip.os.system.request"] =
      "foreign";
    await assert.rejects(
      openSystemCheckpointImage(f.engine, f.input),
      /does not match/,
    );
    assert.equal(f.reads.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("different container references serialize on the same exact physical ID", async () => {
  const f = await fixture();
  let release, entered, first, second;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const reached = new Promise((resolve) => {
    entered = resolve;
  });
  const request = f.engine.request;
  let held = false;
  f.engine.request = async (method, path, body) => {
    const result = await request(method, path, body);
    if (!held && method === "POST" && path.includes("/stop?")) {
      held = true;
      entered();
      await gate;
    }
    return result;
  };
  try {
    first = captureSystemCheckpoint(f.engine, f.input);
    await reached;
    second = captureSystemCheckpoint(f.engine, {
      ...f.input,
      journalPath: join(f.directory, "second.json"),
      request: {
        ...f.input.request,
        operationId: randomUUID(),
        container: "another-reference",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(f.mutations.length, 1);
    release();
    const results = await Promise.all([first, second]);
    assert.ok(results.every((result) => result.operation.state === "ready"));
    assert.equal(
      f.mutations.filter((mutation) => mutation.path.startsWith("/commit?"))
        .length,
      2,
    );
  } finally {
    release();
    await Promise.allSettled([first, second].filter(Boolean));
    await f.cleanup();
  }
});

test("changed admission, damaged journals, and wrong physical identities preserve the original", async () => {
  const f = await fixture();
  try {
    const result = await captureSystemCheckpoint(f.engine, f.input);
    const count = f.mutations.length;
    await assert.rejects(
      captureSystemCheckpoint(f.engine, {
        ...f.input,
        request: { ...f.input.request, resumeOriginal: false },
      }),
      /another admission/,
    );
    await assert.rejects(
      captureSystemCheckpoint(f.engine, {
        ...f.input,
        request: { ...f.input.request, expectedContainerId: "e".repeat(64) },
      }),
      /another admission/,
    );
    const record = JSON.parse(await readFile(f.input.journalPath, "utf8"));
    record.snapshot.requestSha256 = "bad";
    await writeFile(f.input.journalPath, JSON.stringify(record));
    await assert.rejects(
      observeSystemCheckpoint(f.engine, f.input),
      /journal changed/,
    );
    assert.equal(f.mutations.length, count);
    assert.equal(result.operation.state, "ready");
  } finally {
    await f.cleanup();
  }
  const other = await fixture();
  try {
    other.actual.Id = "e".repeat(64);
    const result = await captureSystemCheckpoint(other.engine, other.input);
    assert.equal(result.operation.state, "failed");
    assert.equal(other.mutations.length, 0);
  } finally {
    await other.cleanup();
  }
});
