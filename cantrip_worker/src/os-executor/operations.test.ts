import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
