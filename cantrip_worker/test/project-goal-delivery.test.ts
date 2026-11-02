import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectGoalObservation, ThreadGoal } from "@cantrip/protocol";
import { ProjectGoalDelivery } from "../src/project-goal-delivery.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const service = {
  ownerId: () => "owner",
  serverIdentity: () => "server",
  componentKey: () => ({ key: new Uint8Array(32).fill(7), keyRevision: 1 }),
} as unknown as WorkerEncryptionService;
const goal = (
  threadId = "thread",
  status: ThreadGoal["status"] = "blocked",
): ThreadGoal => ({
  threadId,
  objective: "PRIVATE GOAL SENTINEL",
  status,
  tokenBudget: null,
  tokensUsed: 1,
  timeUsedSeconds: 1,
  createdAt: 1,
  updatedAt: 2,
});
async function fixture(
  send: (o: ProjectGoalObservation) => Promise<unknown>,
  directory?: string,
  generation = randomUUID(),
) {
  directory ??= await mkdtemp(path.join(tmpdir(), "cantrip-goal-outbox-"));
  const delivery = new ProjectGoalDelivery({
    directory,
    workerId: "worker",
    generation: () => generation,
    service,
    send,
    onError: () => {},
    retryDelayMs: 5,
  });
  cleanup.push(() => rm(directory!, { recursive: true, force: true }));
  cleanup.push(() => delivery.stop());
  return { delivery, directory, generation };
}
async function records(directory: string) {
  const base = path.join(directory, "goal-observations");
  const scope = (await readdir(base))[0];
  const dir = path.join(base, scope);
  return Promise.all(
    (await readdir(dir))
      .filter((f) => f.endsWith(".json"))
      .map(async (f) => ({
        file: path.join(dir, f),
        record: JSON.parse(await readFile(path.join(dir, f), "utf8")),
      })),
  );
}
it("persists only ciphertext, retries transient failures, deduplicates facts, and continues revisions after restart", async () => {
  const sent: ProjectGoalObservation[] = [];
  let fail = true;
  const f = await fixture(async (o) => {
    sent.push(o);
    if (fail) throw new Error("offline");
    return { accepted: true };
  });
  f.delivery.watch("thread", "chat");
  f.delivery.observe("thread", goal());
  await vi.waitFor(async () =>
    expect((await records(f.directory))[0].record.delivered).toBe(false),
  );
  const stored = (await records(f.directory))[0];
  expect(JSON.stringify(stored.record)).not.toContain("PRIVATE GOAL SENTINEL");
  if (process.platform !== "win32")
    expect((await stat(stored.file)).mode & 0o777).toBe(0o600);
  fail = false;
  await vi.waitFor(async () =>
    expect((await records(f.directory))[0].record.delivered).toBe(true),
  );
  f.delivery.observe("thread", goal());
  await f.delivery.stop();
  expect(new Set(sent.map((o) => o.revision))).toEqual(new Set([1]));
  const restarted = await fixture(
    async (o) => {
      sent.push(o);
      return { accepted: true };
    },
    f.directory,
    f.generation,
  );
  restarted.delivery.watch("thread", "chat");
  restarted.delivery.observe("thread", goal("thread", "active"));
  await vi.waitFor(() => expect(sent.at(-1)?.revision).toBe(2));
  expect(sent.at(-1)?.snapshot.goal?.status).toBe("active");
});
it("keeps unrelated sources flowing while a binding is pending and excludes Task Goals", async () => {
  const sent: ProjectGoalObservation[] = [];
  const f = await fixture(async (o) => {
    sent.push(o);
    return o.threadId === "pending"
      ? { accepted: false, reason: "unbound-thread" }
      : { accepted: true };
  });
  for (const id of ["pending", "ready", "task"]) f.delivery.watch(id, "chat");
  f.delivery.skip("task");
  f.delivery.watch("task", "chat");
  for (const id of ["pending", "ready", "task"])
    f.delivery.observe(id, goal(id));
  await vi.waitFor(() =>
    expect(sent.some((o) => o.threadId === "ready")).toBe(true),
  );
  expect(sent.some((o) => o.threadId === "task")).toBe(false);
  expect(
    (await records(f.directory)).find(
      (r) => r.record.observation.threadId === "ready",
    )?.record.delivered,
  ).toBe(true);
});
it("retires old process deliveries without reinterpreting them as current facts", async () => {
  const f = await fixture(async () => {
    throw new Error("offline");
  });
  f.delivery.watch("thread", "chat");
  f.delivery.observe("thread", goal());
  await vi.waitFor(async () =>
    expect((await records(f.directory))[0].record.delivered).toBe(false),
  );
  await f.delivery.stop();
  const sent: ProjectGoalObservation[] = [];
  const restarted = await fixture(async (o) => {
    sent.push(o);
    return { accepted: false, reason: "retired-worker" };
  }, f.directory);
  restarted.delivery.wake();
  await vi.waitFor(async () =>
    expect((await records(f.directory))[0].record.delivered).toBe(true),
  );
  expect(sent[0].generation).toBe(f.generation);
  expect(sent[0].generation).not.toBe(restarted.generation);
});

it("preserves rapid resume boundaries while the server is offline", async () => {
  const statuses: Array<string | null> = [];
  let offline = true;
  const f = await fixture(async (o) => {
    if (offline) throw new Error("offline");
    statuses.push(o.snapshot.goal?.status ?? null);
    return { accepted: true };
  });
  f.delivery.watch("thread", "chat");
  f.delivery.observe("thread", goal());
  await vi.waitFor(async () =>
    expect((await records(f.directory))[0].record.delivered).toBe(false),
  );
  f.delivery.observe("thread", goal("thread", "active"));
  f.delivery.observe("thread", goal("thread", "blocked"));
  await vi.waitFor(async () =>
    expect((await records(f.directory))[0].record.pending.length).toBe(3),
  );
  offline = false;
  await vi.waitFor(() =>
    expect(statuses).toEqual(["blocked", "active", "blocked"]),
  );
});
