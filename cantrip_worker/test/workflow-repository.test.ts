import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  scanWorkflowRepository,
  writeWorkflowRepositoryDocument,
} from "../src/workflow-repository.js";

const roots: string[] = [];

async function root() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cantrip-workflow-repository-"),
  );
  roots.push(directory);
  return directory;
}

function document(name = "Repository audit") {
  return {
    format: "cantrip.workflow" as const,
    version: 1 as const,
    definition: {
      slug: "repository-audit",
      name,
      description: "Audit the repository.",
      revision: {
        graph: {
          version: 1 as const,
          nodes: [
            {
              key: "audit",
              type: "agent" as const,
              name: "Audit",
              configuration: { prompt: "Audit the repository." },
            },
          ],
          edges: [],
        },
      },
    },
    exportedAt: "2026-08-09T04:00:00.000Z",
    sourceWorkflowId: "workflow-1",
    sourceRevision: "revision-hash-1",
  };
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("workflow repository bridge", () => {
  it("writes and scans the versioned Cantrip repository convention", async () => {
    const cwd = await root();
    const first = await writeWorkflowRepositoryDocument(cwd, document());
    const second = await writeWorkflowRepositoryDocument(cwd, document());

    expect(first).toMatchObject({
      path: ".cantrip/workflows/repository-audit.json",
      changed: true,
    });
    expect(second).toMatchObject({ changed: false });
    const inventory = await scanWorkflowRepository(cwd);
    expect(inventory.items).toHaveLength(1);
    expect(inventory.items[0]).toMatchObject({
      source: "cantrip",
      status: "ready",
      definition: { slug: "repository-audit" },
    });
    expect(
      JSON.parse(
        await readFile(
          path.join(cwd, ".cantrip/workflows/repository-audit.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ format: "cantrip.workflow", version: 1 });
  });

  it("fails closed on collisions and directory symlink escapes", async () => {
    const cwd = await root();
    await writeWorkflowRepositoryDocument(cwd, document());
    await expect(
      writeWorkflowRepositoryDocument(cwd, document("Different audit")),
    ).rejects.toThrow("already exists with different content");
    await expect(
      writeWorkflowRepositoryDocument(cwd, document("Different audit"), true),
    ).resolves.toMatchObject({ changed: true });

    const escaped = await root();
    const target = await root();
    await symlink(target, path.join(escaped, ".cantrip"));
    await expect(
      writeWorkflowRepositoryDocument(escaped, document()),
    ).rejects.toThrow("must be a real directory");
  });

  it("translates recognized Claude shapes and never executes JavaScript", async () => {
    const cwd = await root();
    const directory = path.join(cwd, ".claude/workflows");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "review.json"),
      JSON.stringify({
        name: "Review change",
        steps: [
          { key: "inspect", prompt: "Inspect the change." },
          {
            key: "verify",
            prompt: "Verify the findings.",
            dependsOn: ["inspect"],
          },
        ],
      }),
    );
    await writeFile(
      path.join(directory, "summarize.md"),
      "---\nname: Summarize project\ndescription: Produce a summary.\n---\nSummarize the current project.",
    );
    await writeFile(
      path.join(directory, "dangerous.js"),
      "throw new Error('this source must never execute');",
    );

    const inventory = await scanWorkflowRepository(cwd);
    expect(inventory.items).toHaveLength(3);
    expect(
      inventory.items.find(({ path }) => path.endsWith("review.json")),
    ).toMatchObject({
      source: "claude-code",
      status: "ready",
      definition: {
        revision: { graph: { nodes: [{ key: "inspect" }, { key: "verify" }] } },
      },
    });
    expect(
      inventory.items.find(({ path }) => path.endsWith("summarize.md")),
    ).toMatchObject({
      status: "ready",
      definition: { slug: "summarize-project" },
    });
    expect(
      inventory.items.find(({ path }) => path.endsWith("dangerous.js")),
    ).toMatchObject({
      status: "unsupported",
      diagnostic: expect.stringContaining("not executed"),
      conversionSource: expect.stringContaining("must never execute"),
      definition: null,
    });
  });
});
