import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RunConfigurationDefinitionChangeNotification } from "@cantrip/protocol/run-configuration-operations";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RunConfigurationDefinitionService } from "../src/run-configuration-definition-service.js";

const projectId = "f288701f-e4a6-4d08-bd54-eddb41aadbe5";
const configurationId = "0f82c573-704d-4a06-984e-5ce0b8d688ca";
const roots: string[] = [];

async function projectRoot(): Promise<string> {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "cantrip-definition-service-")),
  );
  roots.push(root);
  return root;
}

function shellDocument(name = "Run API") {
  return {
    schema: "cantrip.run-configuration" as const,
    version: 1 as const,
    id: configurationId,
    name,
    provider: "shell" as const,
    target: { kind: "command" as const, command: "pnpm dev" },
    arguments: ["--listen", "127.0.0.1:4400"],
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("RunConfigurationDefinitionService", () => {
  it("executes correlated CRUD and capability commands against the shared repository", async () => {
    const root = await projectRoot();
    const service = new RunConfigurationDefinitionService({ emit: () => true });
    const context = { projectId, sourcePath: root };

    const initial = await service.execute({
      type: "project.run-configuration-definitions.list",
      operationId: randomUUID(),
      ...context,
    });
    expect(initial).toMatchObject({ operation: "list", projectId });
    if (initial.operation !== "list") throw new Error("Expected list result.");
    expect(initial.inventory.entries).toEqual([]);

    const capabilities = await service.execute({
      type: "project.run-configuration-definitions.capabilities",
      operationId: randomUUID(),
      ...context,
    });
    expect(capabilities).toMatchObject({
      operation: "capabilities",
      capabilities: [{ provider: "shell", available: true }],
    });

    const created = await service.execute({
      type: "project.run-configuration-definitions.write",
      operationId: randomUUID(),
      ...context,
      request: { expectedRevision: null, document: shellDocument() },
    });
    if (created.operation !== "write" || !("entry" in created.result)) {
      throw new Error("Expected a successful write.");
    }
    expect(created.result.outcome).toBe("created");
    const revision = created.result.entry.revision!;

    const read = await service.execute({
      type: "project.run-configuration-definitions.get",
      operationId: randomUUID(),
      ...context,
      configurationId,
    });
    expect(read).toMatchObject({
      operation: "get",
      result: {
        found: true,
        entry: { document: { arguments: ["--listen", "127.0.0.1:4400"] } },
      },
    });

    const deleted = await service.execute({
      type: "project.run-configuration-definitions.delete",
      operationId: randomUUID(),
      ...context,
      request: { id: configurationId, expectedRevision: revision },
    });
    expect(deleted).toMatchObject({
      operation: "delete",
      result: { outcome: "deleted", id: configurationId },
    });
    service.close();
  });

  it("observes external definition changes and stops accepting work after close", async () => {
    const root = await projectRoot();
    const notifications: RunConfigurationDefinitionChangeNotification[] = [];
    const service = new RunConfigurationDefinitionService({
      emit: (notification) => notifications.push(notification),
    });
    await service.execute({
      type: "project.run-configuration-definitions.list",
      operationId: randomUUID(),
      projectId,
      sourcePath: root,
    });

    const directory = path.join(root, ".cantrip", "run-configurations");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `${configurationId}.json`),
      JSON.stringify(shellDocument(), null, 2) + "\n",
      "utf8",
    );
    await vi.waitFor(
      () =>
        expect(notifications).toContainEqual(
          expect.objectContaining({
            type: "project.run-configuration-definitions.changed",
            projectId,
            sourcePath: root,
            change: expect.objectContaining({
              kind: "created",
              id: configurationId,
            }),
          }),
        ),
      { timeout: 3_000 },
    );

    service.close();
    await expect(
      service.execute({
        type: "project.run-configuration-definitions.list",
        operationId: randomUUID(),
        projectId,
        sourcePath: root,
      }),
    ).rejects.toThrow("closed");
  });
});
