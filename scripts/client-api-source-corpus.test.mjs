import { normalizeSourcePath } from "./application-source-corpus.mjs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readClientApiSourceText } from "./client-api-source-corpus.mjs";

test("client boundary corpus exposes implementation violations in nested domains and shared requests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-api-corpus-"));
  try {
    const lib = path.join(root, "cantrip_app/src/lib");
    await mkdir(path.join(lib, "api/nested"), { recursive: true });
    await writeFile(
      path.join(lib, "api.ts"),
      'export { getProjects } from "./api/projects";',
    );
    await writeFile(
      path.join(lib, "api-client.ts"),
      "const allowCsrfRecovery = false;",
    );
    await writeFile(
      path.join(lib, "api/projects.ts"),
      "export function getProjects() {}",
    );
    await writeFile(
      path.join(lib, "api/nested/legacy.ts"),
      "export function createDirectTerminalAttachment() {}",
    );
    await writeFile(
      path.join(lib, "api/nested/example.test.ts"),
      "TEST_ONLY_MARKER",
    );
    const corpus = await readClientApiSourceText(root);
    assert.match(corpus, /export function createDirectTerminalAttachment/u);
    assert.match(corpus, /allowCsrfRecovery = false/u);
    assert.match(
      corpus,
      /Client API source: cantrip_app\/src\/lib\/api\/nested\/legacy.ts/u,
    );
    assert.doesNotMatch(corpus, /TEST_ONLY_MARKER/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing client implementations fail actual source reads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-api-missing-"));
  try {
    await assert.rejects(readClientApiSourceText(root), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows audit source names match canonical inventory names and policy exceptions", () => {
  assert.equal(
    normalizeSourcePath(String.raw`cantrip_server\src\db\repository.ts`),
    "cantrip_server/src/db/repository.ts",
  );
  assert.equal(
    normalizeSourcePath("cantrip_server/src/db/repository.ts"),
    "cantrip_server/src/db/repository.ts",
  );
  assert.equal(
    normalizeSourcePath(
      String.raw`cantrip_server\src\policies\templates.ts`,
    ).endsWith("/policies/templates.ts"),
    true,
  );
});
