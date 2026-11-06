import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CantripOsController } from "./controller.js";

it("observes private workspace records after Worker loss only under their original authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cantrip-workspace-observe-"));
  const scope = {
    ownerId: "owner",
    workerId: "worker",
    serverId: "server",
    instanceId: randomUUID(),
    guestInstanceId: randomUUID(),
    attachmentGeneration: randomUUID(),
    runtimeGeneration: randomUUID(),
  };
  const operationId = randomUUID(),
    first = new CantripOsController(directory, scope.workerId);
  let creates = 0;
  try {
    const record = await first.operations.execute(
      scope,
      operationId,
      "cantrip-os.workspaces.create",
      {},
      async () => {
        creates++;
        return {
          kind: "workspace",
          workspace: {
            guestWorkspaceId: "work",
            uid: 20000,
            gid: 20000,
            homeGuestPath: "/homes/work",
          },
        };
      },
    );
    const recovered = new CantripOsController(directory, scope.workerId);
    const command = {
      type: "cantrip-os.operation.inspect" as const,
      scope,
      operationId,
    };
    expect(await recovered.handle(command)).toMatchObject({
      operationId,
      state: "ready",
      receipt: record.receipt,
    });
    for (const key of ["runtimeGeneration", "attachmentGeneration"] as const) {
      await expect(
        recovered.handle({
          ...command,
          scope: { ...scope, [key]: randomUUID() },
        }),
      ).rejects.toThrow("scope changed");
    }
    expect(
      await recovered.handle({ ...command, operationId: randomUUID() }),
    ).toBeNull();
    // Provision records carry additional source fields; core inspection must
    // retain its existing projection without ignoring any requested core field.
    const sourceId = randomUUID();
    await first.operations.execute(
      { ...scope, bindingId: randomUUID() } as typeof scope,
      sourceId,
      "cantrip-os.source.provision",
      {},
      async () => {
        throw new Error("Known failure");
      },
    );
    expect(
      await recovered.handle({ ...command, operationId: sourceId }),
    ).toMatchObject({ state: "failed" });
    expect(creates).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
