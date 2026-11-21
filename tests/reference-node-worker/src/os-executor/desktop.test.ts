import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type {
  CantripOsDesktopWorkerCommand,
  CantripOsGuestDesktopTarget,
} from "@cantrip/protocol";
import type { DesktopDriver } from "./desktop-driver.js";
import { OsExecutorDeliveryError } from "./connection.js";
import { CantripOsDesktopManager } from "./desktop.js";

type Operation = Extract<
  CantripOsDesktopWorkerCommand,
  { type: "cantrip-os.desktop.operation" }
>;
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function directory() {
  const result = await mkdtemp(path.join(tmpdir(), "cantrip-desktop-"));
  directories.push(result);
  return result;
}
function command(): Operation {
  return {
    type: "cantrip-os.desktop.operation",
    mode: "execute",
    action: "restart",
    operationId: randomUUID(),
    targetGeneration: randomUUID(),
    scope: {
      serverId: "server",
      ownerId: "owner",
      workerId: "worker",
      instanceId: randomUUID(),
      guestInstanceId: randomUUID(),
      attachmentGeneration: randomUUID(),
      runtimeGeneration: randomUUID(),
      workspaceId: randomUUID(),
      guestWorkspaceId: "work",
      uid: 20000,
      gid: 20000,
      homeGuestPath: "/homes/work",
    },
    transport: { kind: "docker", container: "owned" },
    desktopTarget: {
      id: "work",
      user: "ctw-work",
      uid: 20000,
      gid: 20000,
      home: "/homes/work",
      display: 100,
      generation: 1,
      desktop_generation: "a".repeat(64),
      status: "running",
    },
  };
}
function guest(initial: CantripOsGuestDesktopTarget) {
  let current = structuredClone(initial),
    saved: any = null;
  const calls: string[] = [];
  const driver: DesktopDriver & {
    loseReply: boolean;
    unavailable: boolean;
    corruptReply: boolean;
  } = {
    loseReply: false,
    unavailable: false,
    corruptReply: false,
    async run(_command, args) {
      calls.push(args[0]!);
      if (driver.unavailable) throw new Error("Actual guest is unavailable");
      if (args[0] === "desktop-target") return structuredClone(current);
      const request = JSON.parse(args[1]!);
      if (args[0] === "desktop-observe") {
        if (saved && !isDeepStrictEqual(saved.request, request))
          throw new Error("The guest journal belongs to another admission.");
        return saved === null ? null : structuredClone(saved);
      }
      if (request.action === "stop") current.status = "stopped";
      else if (request.action === "restart" || current.status === "stopped") {
        current = {
          ...current,
          generation: current.generation + 1,
          desktop_generation: "b".repeat(64),
          status: "running",
        };
      }
      saved = {
        version: 1,
        request,
        state: "ready",
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        error: null,
        receipt: {
          completion: "acknowledged-and-observed",
          before: request.target,
          after: structuredClone(current),
        },
        current: structuredClone(current),
        current_error: null,
      };
      if (driver.loseReply)
        throw new OsExecutorDeliveryError("Actual reply lost after restart");
      return driver.corruptReply
        ? { ...saved, receipt: null }
        : structuredClone(saved);
    },
  };
  return {
    driver,
    calls,
    setCurrent: (value: CantripOsGuestDesktopTarget) => {
      current = value;
    },
    saved: () => saved,
  };
}
it("repeated execute observes the admitted desktop and keeps current state separate from history", async () => {
  const input = command(),
    state = guest(input.desktopTarget);
  const manager = new CantripOsDesktopManager(
    await directory(),
    "worker",
    state.driver,
  );
  const first = await manager.handle(input);
  expect(first?.state).toBe("ready");
  state.setCurrent({
    ...input.desktopTarget,
    generation: 3,
    desktop_generation: "c".repeat(64),
    status: "stopped",
  });
  const repeated = await manager.handle(input);
  expect(repeated?.receipt).toEqual(first?.receipt);
  expect(repeated?.observation?.status).toBe("stopped");
  expect(state.calls.filter((c) => c === "desktop-execute")).toHaveLength(1);
});
it("recovers a lost actual restart reply after a new Manager without another execute", async () => {
  const input = command(),
    state = guest(input.desktopTarget),
    dir = await directory();
  state.driver.loseReply = true;
  const original = new CantripOsDesktopManager(dir, "worker", state.driver);
  expect((await original.handle(input))?.state).toBe("unknown");
  const recovered = await new CantripOsDesktopManager(
    dir,
    "worker",
    state.driver,
  ).handle({ ...input, mode: "observe" });
  expect(recovered?.state).toBe("ready");
  expect(recovered?.receipt?.after.generation).toBe(2);
  expect(state.calls.filter((c) => c === "desktop-execute")).toHaveLength(1);
});
it("can read the exact guest receipt after local journal loss without recreating a local admission", async () => {
  const input = command(),
    state = guest(input.desktopTarget);
  await new CantripOsDesktopManager(
    await directory(),
    "worker",
    state.driver,
  ).handle(input);
  const empty = new CantripOsDesktopManager(
    await directory(),
    "worker",
    state.driver,
  );
  expect((await empty.handle({ ...input, mode: "observe" }))?.state).toBe(
    "ready",
  );
  expect(
    await empty.operations.inspect(input.scope, input.operationId),
  ).toBeNull();
  expect(state.calls.filter((c) => c === "desktop-execute")).toHaveLength(1);
});
it("missing journals remain missing and never enter execute", async () => {
  const input = command(),
    state = guest(input.desktopTarget);
  const manager = new CantripOsDesktopManager(
    await directory(),
    "worker",
    state.driver,
  );
  expect(await manager.handle({ ...input, mode: "observe" })).toBeNull();
  expect(state.calls).toEqual(["desktop-observe"]);
});
it.each(["action", "targetGeneration", "scope", "desktopTarget"] as const)(
  "rejects changed %s under an existing operation ID",
  async (field) => {
    const input = command(),
      state = guest(input.desktopTarget);
    const manager = new CantripOsDesktopManager(
      await directory(),
      "worker",
      state.driver,
    );
    await manager.handle(input);
    const changed = structuredClone(input);
    if (field === "action") changed.action = "stop";
    if (field === "targetGeneration") changed.targetGeneration = randomUUID();
    if (field === "scope") changed.scope.serverId = "another-server";
    if (field === "desktopTarget") changed.desktopTarget.generation++;
    // A different server gets a distinct private namespace. Its read cannot see
    // or mutate the original operation; the real guest rejects its scope key.
    if (field === "scope") {
      await expect(
        manager.handle({ ...changed, mode: "observe" }),
      ).rejects.toThrow("admission");
    } else
      await expect(manager.handle(changed)).rejects.toThrow(
        "another admission",
      );
    expect(state.calls.filter((c) => c === "desktop-execute")).toHaveLength(1);
  },
);
it("retains known completion while current guest access fails", async () => {
  const input = command(),
    state = guest(input.desktopTarget);
  const manager = new CantripOsDesktopManager(
    await directory(),
    "worker",
    state.driver,
  );
  const first = await manager.handle(input);
  state.driver.unavailable = true;
  const history = await manager.handle({ ...input, mode: "observe" });
  expect(history?.state).toBe("ready");
  expect(history?.receipt).toEqual(first?.receipt);
  expect(history?.observation).toBeNull();
  expect(history?.observationError).toContain("could not be observed");
});
it("unverified completion after a mutation stays unknown and is recovered only from the matching receipt", async () => {
  const input = command(),
    state = guest(input.desktopTarget);
  const manager = new CantripOsDesktopManager(
    await directory(),
    "worker",
    state.driver,
  );
  state.driver.corruptReply = true;
  expect((await manager.handle(input))?.state).toBe("unknown");
  expect((await manager.handle({ ...input, mode: "observe" }))?.state).toBe(
    "ready",
  );
  expect(state.calls.filter((c) => c === "desktop-execute")).toHaveLength(1);
});
it("does not select another Worker or account for status", async () => {
  const input = command(),
    state = guest(input.desktopTarget);
  const manager = new CantripOsDesktopManager(
    await directory(),
    "worker",
    state.driver,
  );
  await expect(
    manager.handle({
      ...input,
      scope: { ...input.scope, workerId: "another" },
    }),
  ).rejects.toThrow("another Worker");
  expect(state.calls).toEqual([]);
  state.setCurrent({ ...input.desktopTarget, uid: 30000 });
  await expect(
    manager.handle({
      type: "cantrip-os.desktop.status",
      scope: input.scope,
      transport: input.transport,
    }),
  ).rejects.toThrow("admitted workspace");
  expect(state.calls).toEqual(["desktop-target"]);
});
