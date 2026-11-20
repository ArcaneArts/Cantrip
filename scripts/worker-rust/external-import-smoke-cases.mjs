import assert from "node:assert/strict";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export async function verifyExternalImport({
  request,
  success,
  eventually,
  a,
  b,
  codexHome,
  runtimeHome,
}) {
  const homeSource = path.join(path.dirname(codexHome), ".claude");
  await mkdir(homeSource, { recursive: true });
  await writeFile(path.join(homeSource, "CLAUDE.md"), "Home-only fixture\n");
  const aSource = path.join(a.directory, "CLAUDE.md");
  const bSource = path.join(b.directory, "CLAUDE.md");
  const aTarget = path.join(a.directory, "AGENTS.md");
  const projectInstructions = "Project migration fixture instructions 🌱\n";
  await writeFile(aSource, projectInstructions);
  await writeFile(bSource, "Adjacent project instructions\n");

  const preview = (chat) =>
    request(
      chat,
      "customization.external.preview",
      "GET",
      "/external-preview",
    ).then(success);
  const apply = (chat, itemIds) =>
    request(
      chat,
      "customization.external.apply",
      "POST",
      "/external-import",
      { itemIds },
      202,
    );
  const status = (chat, importId) =>
    request(
      chat,
      "customization.external.status",
      "POST",
      "/external-import/status",
      { importId },
    ).then(success);
  const aPreview = await preview(a);
  assert.equal(aPreview.sourceScope, "project");
  assert.ok(aPreview.items.every(({ cwd }) => cwd === a.directory));
  const candidate = aPreview.items.find(
    ({ itemType }) => itemType === "AGENTS_MD",
  );
  assert.ok(candidate, JSON.stringify(aPreview));
  assert.deepEqual(await preview(a), aPreview);
  const other = (await preview(b)).items.find(
    ({ itemType }) => itemType === "AGENTS_MD",
  );
  assert.ok(other);
  assert.notEqual(other.id, candidate.id);

  const stale = {
    status: "failed",
    error: {
      message:
        "One or more external configuration candidates changed; preview again before importing.",
    },
  };
  assert.deepEqual(await apply(a, [other.id]), stale);
  await unlink(aSource);
  assert.deepEqual(await apply(a, [candidate.id]), stale);
  await assert.rejects(readFile(aTarget), { code: "ENOENT" });
  await writeFile(aSource, projectInstructions);
  const receipt = success(await apply(a, [candidate.id]));
  assert.ok(["pending", "completed"].includes(receipt.status));
  assert.ok(receipt.importId);
  const completed = await eventually(
    () => status(a, receipt.importId),
    (result) =>
      assert.equal(result.status, "completed", JSON.stringify(result)),
  );
  assert.deepEqual(completed.results, [
    {
      itemType: "AGENTS_MD",
      successCount: 1,
      failures: [],
    },
  ]);
  assert.match(
    await readFile(aTarget, "utf8"),
    /Project migration fixture instructions 🌱/u,
  );
  for (const unrelated of [
    path.join(b.directory, "AGENTS.md"),
    path.join(runtimeHome, "AGENTS.md"),
  ])
    await assert.rejects(readFile(unrelated), { code: "ENOENT" });
  assert.deepEqual(await status(b, receipt.importId), {
    importId: receipt.importId,
    status: "unknown",
    results: [],
  });
}
