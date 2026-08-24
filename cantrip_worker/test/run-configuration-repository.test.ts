import { randomUUID } from "node:crypto";
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

import {
  RUN_CONFIGURATION_FILE_SCHEMA,
  RUN_CONFIGURATION_MAX_FILE_BYTES,
} from "@cantrip/protocol/run-configuration-definitions";
import { afterEach, describe, expect, it } from "vitest";

import {
  RunConfigurationRepository,
  type RunConfigurationRepositoryWatcher,
} from "../src/run-configuration-repository.js";

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "cantrip-run-configuration-repository-"),
  );
  roots.push(root);
  return root;
}

function shellDocument(id = randomUUID(), name = "Run API") {
  return {
    schema: RUN_CONFIGURATION_FILE_SCHEMA,
    version: 1 as const,
    id,
    name,
    provider: "shell" as const,
    workingDirectory: ".",
    target: { kind: "command" as const, command: "pnpm dev" },
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for a repository change.");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("RunConfigurationRepository", () => {
  it("creates, reads, revision-updates, and deletes canonical documents", async () => {
    const root = await createRoot();
    const repository = await RunConfigurationRepository.open(root);
    const document = shellDocument();

    await expect(repository.scan()).resolves.toMatchObject({
      entries: [],
      diagnostics: [],
    });
    const created = await repository.write({
      expectedRevision: null,
      document,
    });
    expect(created).toMatchObject({
      outcome: "created",
      entry: {
        id: document.id,
        status: "ready",
        document: {
          environment: { includeCodexEnvironment: true },
        },
      },
    });
    if (!("entry" in created)) throw new Error("Expected a created entry.");
    const revision = created.entry.revision!;
    expect(
      JSON.parse(
        await readFile(
          path.join(root, ".cantrip/run-configurations", document.id + ".json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      schema: RUN_CONFIGURATION_FILE_SCHEMA,
      id: document.id,
      environment: { includeCodexEnvironment: true },
    });

    await expect(
      repository.write({ expectedRevision: null, document }),
    ).resolves.toMatchObject({ outcome: "already-exists" });
    await expect(
      repository.write({
        expectedRevision: revision,
        document: { ...document, name: "Run API locally" },
      }),
    ).resolves.toMatchObject({
      outcome: "updated",
      entry: { document: { name: "Run API locally" } },
    });
    await expect(
      repository.write({
        expectedRevision: revision,
        document: { ...document, name: "Stale edit" },
      }),
    ).resolves.toMatchObject({ outcome: "revision-mismatch" });

    const current = await repository.read(document.id);
    if (!current.found || !current.entry.revision) {
      throw new Error("Expected the updated definition.");
    }
    await expect(
      repository.write({
        expectedRevision: current.entry.revision,
        document: current.entry.document!,
      }),
    ).resolves.toMatchObject({ outcome: "unchanged" });
    await expect(
      repository.delete({
        id: document.id,
        expectedRevision: revision,
      }),
    ).resolves.toMatchObject({ outcome: "revision-mismatch" });
    await expect(
      repository.delete({
        id: document.id,
        expectedRevision: current.entry.revision,
      }),
    ).resolves.toEqual({
      outcome: "deleted",
      id: document.id,
      revision: current.entry.revision,
    });
    await expect(repository.read(document.id)).resolves.toEqual({
      found: false,
      id: document.id,
    });
  });

  it("serializes competing updates so exactly one expected revision wins", async () => {
    const repository = await RunConfigurationRepository.open(
      await createRoot(),
    );
    const document = shellDocument();
    const created = await repository.write({
      expectedRevision: null,
      document,
    });
    if (!("entry" in created) || !created.entry.revision) {
      throw new Error("Expected a revision.");
    }
    const results = await Promise.all([
      repository.write({
        expectedRevision: created.entry.revision,
        document: { ...document, name: "First winner" },
      }),
      repository.write({
        expectedRevision: created.entry.revision,
        document: { ...document, name: "Second winner" },
      }),
    ]);
    expect(results.map(({ outcome }) => outcome).sort()).toEqual([
      "revision-mismatch",
      "updated",
    ]);
  });

  it("enforces project-unique names without confusing identity and display name", async () => {
    const root = await createRoot();
    const repository = await RunConfigurationRepository.open(root);
    const first = shellDocument(randomUUID(), "Run API");
    const second = shellDocument(randomUUID(), "run api");
    await repository.write({ expectedRevision: null, document: first });
    await expect(
      repository.write({ expectedRevision: null, document: second }),
    ).resolves.toMatchObject({
      outcome: "name-conflict",
      conflictingId: first.id,
    });

    const directory = path.join(root, ".cantrip/run-configurations");
    await writeFile(
      path.join(directory, second.id + ".json"),
      JSON.stringify(second),
    );
    const inventory = await repository.scan();
    expect(inventory.entries).toHaveLength(2);
    expect(inventory.entries.every(({ status }) => status === "invalid")).toBe(
      true,
    );
    expect(
      inventory.entries.every(({ diagnostics }) =>
        diagnostics.some(({ code }) => code === "name-duplicate"),
      ),
    ).toBe(true);
  });

  it("reports malformed, unsupported, mismatched, oversized, and hostile paths", async () => {
    const root = await createRoot();
    const directory = path.join(root, ".cantrip/run-configurations");
    await mkdir(directory, { recursive: true });
    const malformedId = randomUUID();
    const mismatchedId = randomUUID();
    const oversizedId = randomUUID();
    const unsupportedId = randomUUID();
    const nulId = randomUUID();
    await writeFile(path.join(directory, malformedId + ".json"), "{broken");
    await writeFile(
      path.join(directory, mismatchedId + ".json"),
      JSON.stringify(shellDocument(randomUUID(), "Mismatch")),
    );
    await writeFile(
      path.join(directory, unsupportedId + ".json"),
      JSON.stringify({
        schema: RUN_CONFIGURATION_FILE_SCHEMA,
        version: 1,
        id: unsupportedId,
        name: "Rust app",
        provider: "rust",
      }),
    );
    await writeFile(
      path.join(directory, oversizedId + ".json"),
      "x".repeat(RUN_CONFIGURATION_MAX_FILE_BYTES + 1),
    );
    await writeFile(path.join(directory, nulId + ".json"), "{}\0");
    await mkdir(path.join(directory, randomUUID() + ".json"));
    await writeFile(path.join(directory, "notes.txt"), "not a configuration");
    const outside = await createRoot();
    await writeFile(path.join(outside, "outside.json"), "{}");
    await symlink(
      path.join(outside, "outside.json"),
      path.join(directory, randomUUID() + ".json"),
    );

    const inventory = await (
      await RunConfigurationRepository.open(root)
    ).scan();
    expect(inventory.entries).toHaveLength(8);
    expect(
      inventory.entries.find(({ relativePath }) =>
        relativePath.endsWith(malformedId + ".json"),
      ),
    ).toMatchObject({
      status: "invalid",
      diagnostics: [{ code: "json-invalid" }],
    });
    expect(
      inventory.entries.find(({ relativePath }) =>
        relativePath.endsWith(mismatchedId + ".json"),
      ),
    ).toMatchObject({
      status: "invalid",
      diagnostics: [{ code: "identity-mismatch" }],
    });
    expect(
      inventory.entries.find(({ relativePath }) =>
        relativePath.endsWith(unsupportedId + ".json"),
      ),
    ).toMatchObject({
      status: "unsupported",
      diagnostics: [{ code: "provider-unavailable" }],
    });
    expect(
      inventory.entries.find(({ relativePath }) =>
        relativePath.endsWith(oversizedId + ".json"),
      ),
    ).toMatchObject({
      status: "invalid",
      diagnostics: [{ code: "file-invalid" }],
    });
    expect(
      inventory.entries.find(({ relativePath }) =>
        relativePath.endsWith(nulId + ".json"),
      ),
    ).toMatchObject({
      status: "invalid",
      diagnostics: [{ code: "nul-rejected" }],
    });
    expect(
      inventory.entries.filter(({ status }) => status === "unsupported"),
    ).toHaveLength(4);
  });

  it("bounds repository scans without following entries beyond the limit", async () => {
    const root = await createRoot();
    const directory = path.join(root, ".cantrip/run-configurations");
    await mkdir(directory, { recursive: true });
    await Promise.all(
      Array.from({ length: 130 }, (_, index) =>
        writeFile(
          path.join(
            directory,
            "00000000-0000-4000-8000-" +
              index.toString().padStart(12, "0") +
              ".json",
          ),
          "{}",
        ),
      ),
    );
    const inventory = await (
      await RunConfigurationRepository.open(root)
    ).scan();
    expect(inventory.entries).toHaveLength(128);
    expect(inventory.diagnostics).toEqual([
      expect.objectContaining({ code: "file-limit-exceeded" }),
    ]);
  });

  it("fails closed when .cantrip or the repository directory is a symlink", async () => {
    const root = await createRoot();
    const outside = await createRoot();
    await symlink(outside, path.join(root, ".cantrip"));
    const repository = await RunConfigurationRepository.open(root);
    await expect(repository.scan()).resolves.toMatchObject({
      entries: [],
      diagnostics: [{ code: "directory-invalid" }],
    });
    await expect(
      repository.write({
        expectedRevision: null,
        document: shellDocument(),
      }),
    ).rejects.toThrow("must be a real directory");
  });

  it("observes external creation, update, and deletion from an initially empty project", async () => {
    const root = await createRoot();
    const repository = await RunConfigurationRepository.open(root);
    const changes: Array<{ kind: string; id: string | null }> = [];
    let watcher: RunConfigurationRepositoryWatcher | null = null;
    try {
      watcher = await repository.watch((change) => {
        changes.push({ kind: change.kind, id: change.id });
      });
      const document = shellDocument();
      const created = await repository.write({
        expectedRevision: null,
        document,
      });
      await waitFor(() =>
        changes.some(
          ({ kind, id }) => kind === "created" && id === document.id,
        ),
      );
      if (!("entry" in created) || !created.entry.revision) {
        throw new Error("Expected a created revision.");
      }
      const updated = await repository.write({
        expectedRevision: created.entry.revision,
        document: { ...document, name: "Updated Run API" },
      });
      await waitFor(() =>
        changes.some(
          ({ kind, id }) => kind === "updated" && id === document.id,
        ),
      );
      if (!("entry" in updated) || !updated.entry.revision) {
        throw new Error("Expected an updated revision.");
      }
      await repository.delete({
        id: document.id,
        expectedRevision: updated.entry.revision,
      });
      await waitFor(() =>
        changes.some(
          ({ kind, id }) => kind === "deleted" && id === document.id,
        ),
      );
    } finally {
      watcher?.close();
    }
  });
});
