import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OsOperationStore } from "./operations.js";

const scope = () => ({
  ownerId: "owner",
  workerId: "worker",
  serverId: "server",
  instanceId: randomUUID(),
  guestInstanceId: randomUUID(),
  attachmentGeneration: randomUUID(),
  runtimeGeneration: randomUUID(),
});

describe("OS operation provenance", () => {
  it("retains private checkpoints across a fresh store and reconciles without admitting another mutation", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cantrip-os-checkpoints-"),
    );
    const actual = scope(),
      operationId = randomUUID();
    let effects = 0;
    const initial = { phase: "admitted", privatePath: "/private/workspace" };
    try {
      await new OsOperationStore(directory).execute(
        actual,
        operationId,
        "backup.capture",
        {},
        async (record, save) => {
          expect(record.checkpoint).toEqual(initial);
          expect(
            (await new OsOperationStore(directory).inspect(actual, operationId))
              ?.checkpoint,
          ).toEqual(initial);
          effects++;
          record.checkpoint = {
            phase: "captured",
            privatePath: "/private/workspace",
          };
          await save();
          throw Object.assign(new Error("Worker ended"), {
            delivery: "unknown",
          });
        },
        initial,
      );
      const store = new OsOperationStore(directory);
      expect((await store.inspect(actual, operationId))?.checkpoint).toEqual({
        phase: "captured",
        privatePath: "/private/workspace",
      });
      await store.reconcile(actual, operationId, async (record) => {
        record.state = "ready";
        record.receipt = { observed: true };
      });
      const repeated = await store.execute(
        actual,
        operationId,
        "backup.capture",
        {},
        async () => {
          effects++;
        },
      );
      expect(repeated).toMatchObject({
        state: "ready",
        receipt: { observed: true },
      });
      expect(effects).toBe(1);
      await expect(
        store.reconcile(
          { ...actual, attachmentGeneration: randomUUID() },
          operationId,
          async () => {
            throw new Error(
              "Changed authority must not observe a completed result",
            );
          },
        ),
      ).rejects.toThrow("scope changed");
      const files = await readdir(directory, { recursive: true });
      const file = files.find((entry) =>
        entry.endsWith(operationId + ".json"),
      )!;
      expect((await stat(path.join(directory, file))).mode & 0o777).toBe(0o600);
      expect(files.some((entry) => entry.endsWith(".partial"))).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("persists an observed completion without admitting another mutation", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cantrip-os-observed-"),
    );
    const actual = scope(),
      operationId = randomUUID();
    let mutations = 0;
    const store = new OsOperationStore(directory);
    try {
      const unknown = await store.execute(
        actual,
        operationId,
        "definition.write",
        {},
        async () => {
          mutations++;
          throw Object.assign(new Error("delivery lost"), {
            delivery: "unknown",
          });
        },
      );
      expect(unknown.state).toBe("unknown");
      await store.recordObservedCompletion(unknown, { created: true });
      const observed = await new OsOperationStore(directory).execute(
        actual,
        operationId,
        "definition.write",
        {},
        async () => {
          mutations++;
        },
      );
      expect(observed).toMatchObject({
        state: "ready",
        receipt: { created: true },
      });
      expect(mutations).toBe(1);
      await expect(
        store.recordObservedCompletion(
          { ...unknown, admissionFingerprint: "changed" },
          {},
        ),
      ).rejects.toThrow(/identity changed/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("observes completed, interrupted and changed admissions without replaying their mutations", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cantrip-os-operations-"),
    );
    const actual = scope(),
      operationId = randomUUID();
    const store = new OsOperationStore(directory);
    let calls = 0;
    try {
      const ready = await store.execute(
        actual,
        operationId,
        "source.provision",
        {},
        async () => {
          calls++;
          return { completed: true };
        },
      );
      expect(ready.state).toBe("ready");
      const repeated = await store.execute(
        actual,
        operationId,
        "source.provision",
        {},
        async () => {
          calls++;
          throw new Error("replayed");
        },
      );
      expect(repeated.receipt).toEqual({ completed: true });
      expect(calls).toBe(1);
      await expect(
        store.execute(
          { ...actual, runtimeGeneration: randomUUID() },
          operationId,
          "source.provision",
          {},
          async () => {
            calls++;
          },
        ),
      ).rejects.toThrow(/different admission/);
      await expect(
        store.execute(
          actual,
          operationId,
          "source.provision",
          { changed: true },
          async () => {
            calls++;
          },
        ),
      ).rejects.toThrow(/different admission/);
      expect(
        await store.inspect({ ...actual, ownerId: "other" }, operationId),
      ).toBeNull();
      const activeId = randomUUID();
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const running = store.execute(
        actual,
        activeId,
        "source.provision",
        {},
        async () => {
          entered();
          await held;
          return { completed: true };
        },
      );
      await started;
      expect((await store.inspect(actual, activeId))?.state).toBe("running");
      await expect(
        store.reconcile(
          { ...actual, runtimeGeneration: randomUUID() },
          activeId,
          async () => {
            throw new Error(
              "Changed authority must not observe a running result",
            );
          },
        ),
      ).rejects.toThrow("scope changed");
      expect(
        (await new OsOperationStore(directory).inspect(actual, activeId))
          ?.state,
      ).toBe("unknown");
      release();
      await running;
      expect(calls).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
