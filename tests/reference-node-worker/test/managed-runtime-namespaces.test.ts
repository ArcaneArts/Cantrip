import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  ManagedRuntimeNamespaces,
  managedRuntimeTarget,
} from "../src/codex/managed-runtime-namespaces.js";
import { nativeRuntimeHandoffFixture } from "./fixtures/native-runtime-handoff.js";

const scope = { serverId: "server", ownerId: "owner", workerId: "worker" };
const provider = {
  id: "target-provider",
  kind: "chatgpt",
  accountId: "target-account",
};
let directory: string;
let namespaces: ManagedRuntimeNamespaces;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "cantrip-native-namespaces-"));
  namespaces = new ManagedRuntimeNamespaces(directory);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const select = (
  handoff = nativeRuntimeHandoffFixture(),
  previousOperationId: string | null = null,
) => namespaces.select({ scope, handoff, provider, previousOperationId });

describe("durable managed runtime namespaces", () => {
  it("retains the exact selected home after reopening and never restores an old selection", async () => {
    const first = nativeRuntimeHandoffFixture();
    const a = await select(first);
    expect(await select(first)).toEqual(a);
    namespaces = new ManagedRuntimeNamespaces(directory);
    expect(
      namespaces.resolve(scope, {
        threadId: first.source.threadId,
        chatId: first.chatId,
        provider,
      }),
    ).toEqual(a);
    const second = nativeRuntimeHandoffFixture();
    const b = await select(second, first.operationId);
    expect(b.home).not.toBe(a.home);
    await expect(select(first)).rejects.toThrow("source was replaced");
    expect(namespaces.current(scope, first.source.threadId)).toEqual(b);
    const files = await readdir(
      path.join(path.dirname(path.dirname(a.home)), "selections"),
    );
    expect(files).toHaveLength(2);
    const filename = path.join(
      path.dirname(path.dirname(a.home)),
      "selections",
      files[0]!,
    );
    const record = JSON.parse(await readFile(filename, "utf8"));
    expect(Object.keys(record).sort()).toEqual([
      "chatId",
      "operationId",
      "previousOperationId",
      "provider",
      "scope",
      "threadId",
      "version",
    ]);
    if (process.platform !== "win32")
      expect((await stat(filename)).mode & 0o777).toBe(0o600);
  });
  it("isolates owner/server/worker/thread and rejects another chat or account", async () => {
    await select();
    for (const key of ["ownerId", "serverId", "workerId"] as const)
      expect(
        namespaces.resolve(
          { ...scope, [key]: "other" },
          { threadId: "native-thread", provider },
        ),
      ).toBeNull();
    expect(
      namespaces.resolve(scope, { threadId: "other-thread", provider }),
    ).toBeNull();
    expect(namespaces.resolve(scope, { provider })).toBeNull();
    expect(() =>
      namespaces.resolve(scope, {
        threadId: "native-thread",
        chatId: "other",
        provider,
      }),
    ).toThrow("route changed");
    expect(() =>
      namespaces.resolve(scope, {
        threadId: "native-thread",
        provider: { ...provider, accountId: "old-account" },
      }),
    ).toThrow("route changed");
  });
  it("serializes duplicate publishers and requires a committed owned destination", async () => {
    const job = nativeRuntimeHandoffFixture();
    await expect(select({ ...job, phase: "prepared" })).rejects.toThrow(
      "committed destination",
    );
    await expect(
      namespaces.select({
        scope,
        handoff: job,
        provider: { ...provider, id: "other" },
        previousOperationId: null,
      }),
    ).rejects.toThrow("committed destination");
    const reopened = new ManagedRuntimeNamespaces(directory);
    const [a, b] = await Promise.all([
      select(job),
      reopened.select({
        scope,
        handoff: job,
        provider,
        previousOperationId: null,
      }),
    ]);
    expect(a).toEqual(b);
    await expect(
      select(nativeRuntimeHandoffFixture(), randomUUID()),
    ).rejects.toThrow("source was replaced");
  });
  it("reports an actual publication failure and retries after only that obstruction is repaired", async () => {
    const job = nativeRuntimeHandoffFixture();
    const root = path.dirname(
      path.dirname(
        namespaces.destination(scope, job.source.threadId, job.operationId),
      ),
    );
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "selections"), "fixture obstruction");
    await expect(select(job)).rejects.toThrow();
    await rm(path.join(root, "selections"));
    const selected = await select(job);
    const filename = path.join(root, "selections", `${job.operationId}.json`);
    const original = await readFile(filename, "utf8");
    await writeFile(filename, "broken fixture json");
    expect(() => namespaces.current(scope, job.source.threadId)).toThrow();
    expect(namespaces.current(scope, "unrelated-thread")).toBeNull();
    await writeFile(filename, original);
    expect(namespaces.current(scope, job.source.threadId)).toEqual(selected);
  });
  it("carries direct and managed-console identity without treating other command fields as a target", () => {
    expect(
      managedRuntimeTarget({
        threadId: "t",
        chatId: "c",
        prompt: "irrelevant",
      }),
    ).toEqual({ threadId: "t", chatId: "c" });
    expect(
      managedRuntimeTarget({ threadId: "t", session: { chatId: "c" } }),
    ).toEqual({ threadId: "t", chatId: "c" });
    expect(managedRuntimeTarget({ operationId: "op", model: {} })).toEqual({});
  });
});
