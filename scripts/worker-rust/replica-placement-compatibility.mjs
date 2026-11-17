// Actual Node/native placement managers over one owned filesystem. Each call
// starts from identical bytes; neither implementation touches user repositories.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  mkdtemp,
  mkdir,
  readdir,
  lstat,
  readFile,
  readlink,
  writeFile,
  symlink,
  rm,
  chmod,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  ProjectReplicaPlacementManager,
  ProjectReplicaPlacementError,
  probeManagedLinkPlacement,
} from "../../cantrip_worker/src/project-replica-placement.ts";
const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "Pass --binary replica-placement-fixture");
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "cantrip-replica-placement-")),
);
const directory = path.join(root, "worker"),
  canonical = path.join(root, "canonical 😀"),
  gitCommonDir = path.join(canonical, ".git"),
  linkPath = path.join(root, "external", "link 😀"),
  registryPath = path.join(directory, "project-replica-placements.json");
const workerId = "placement-worker",
  projectId = "project-one",
  fingerprint = "a".repeat(64),
  createdAt = "2020-01-01T00:00:00.000Z";
await mkdir(gitCommonDir, { recursive: true });
await mkdir(path.dirname(linkPath), { recursive: true });
const child = spawn(path.resolve(values.binary), [], {
  cwd: root,
  env: { ...process.env, PATH: "" },
  stdio: ["pipe", "pipe", "inherit"],
});
child.stdout.setEncoding("utf8");
const completion = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
let id = 0,
  comparisons = 0;
const methods = new Set();
const sources = new Map();
function source(worker) {
  if (!sources.has(worker))
    sources.set(worker, new ProjectReplicaPlacementManager(directory, worker));
  return sources.get(worker);
}
function outcome(error) {
  const result = { ok: false, error: error.message };
  if (error instanceof ProjectReplicaPlacementError) {
    result.code = error.code;
    result.retryable = error.retryable;
  }
  return result;
}
async function node(method, input, worker) {
  try {
    let result;
    if (method === "probe") result = await probeManagedLinkPlacement(directory);
    else if (method === "batch")
      result = await Promise.all(
        input.map(async (item) => {
          try {
            return {
              ok: true,
              value: (await source(worker)[item.method](item.input)) ?? null,
            };
          } catch (error) {
            return outcome(error);
          }
        }),
      );
    else
      result =
        method === "forgetPlacement"
          ? await source(worker).forgetPlacement(
              input.projectId,
              input.canonicalPath,
            )
          : await source(worker)[method](input);
    return { ok: true, value: result ?? null };
  } catch (error) {
    return outcome(error);
  }
}
async function native(method, input, worker) {
  child.stdin.write(
    JSON.stringify({
      id: ++id,
      directory,
      workerId: worker,
      method,
      input,
      ...(method === "batch" ? { operations: input } : {}),
    }) + "\n",
  );
  const line = await lines.next();
  assert.equal(line.done, false);
  const reply = JSON.parse(line.value);
  assert.equal(reply.id, id);
  return reply.result;
}
async function snapshot() {
  const entries = [];
  async function walk(relative) {
    const target = path.join(root, relative),
      metadata = await lstat(target);
    const mode = metadata.mode & 0o777;
    if (metadata.isSymbolicLink())
      entries.push({ relative, kind: "link", target: await readlink(target) });
    else if (metadata.isDirectory()) {
      entries.push({ relative, kind: "directory", mode });
      for (const name of (await readdir(target)).sort())
        await walk(path.join(relative, name));
    } else
      entries.push({
        relative,
        kind: "file",
        mode,
        bytes: (await readFile(target)).toString("base64"),
      });
  }
  for (const name of (await readdir(root)).sort()) await walk(name);
  return entries;
}
async function restore(entries) {
  for (const name of await readdir(root))
    await rm(path.join(root, name), { recursive: true, force: true });
  for (const entry of entries) {
    const target = path.join(root, entry.relative);
    if (entry.kind === "directory") {
      await mkdir(target, { mode: entry.mode });
      await chmod(target, entry.mode);
    } else if (entry.kind === "link") {
      await symlink(
        entry.target,
        target,
        process.platform === "win32" ? "junction" : "dir",
      );
    } else {
      await writeFile(target, Buffer.from(entry.bytes, "base64"), {
        mode: entry.mode,
      });
      await chmod(target, entry.mode);
    }
  }
}
function normalized(entries) {
  return entries.map((entry) => {
    if (
      entry.kind !== "file" ||
      path.basename(entry.relative) !== "project-replica-placements.json"
    )
      return entry;
    let text = Buffer.from(entry.bytes, "base64").toString("utf8");
    text = text.replace(
      /"(?:createdAt|releasedAt)":"([^"\n]+)"/gu,
      (match, time) => {
        if (Math.abs(Date.now() - Date.parse(time)) >= 30000) return match;
        assert.match(time, /^\d{4}-\d{2}-\d{2}T.*\.\d{3}Z$/);
        return match.replace(time, "<current-time>");
      },
    );
    return { ...entry, bytes: Buffer.from(text).toString("base64") };
  });
}
async function compare(
  method,
  input = {},
  { worker = workerId, ok = true } = {},
) {
  const before = await snapshot(),
    expected = await node(method, input, worker),
    expectedState = await snapshot();
  await restore(before);
  const actual = await native(method, input, worker),
    actualState = await snapshot();
  const label = method + " #" + comparisons;
  assert.deepEqual(actual, expected, label);
  assert.deepEqual(
    normalized(actualState),
    normalized(expectedState),
    "filesystem bytes/modes/links " + label,
  );
  assert.equal(actual.ok, ok, label);
  comparisons++;
  methods.add(method);
  return actual.value;
}
const baseRecord = {
  canonicalPath: canonical,
  createdAt,
  linkPath: null,
  mode: "direct",
  ownership: "cantrip",
  projectId,
  repositoryFingerprint: fingerprint,
  requestedPath: canonical,
};
const proof = { ...baseRecord, gitCommonDir };
const prepare = (mode, extra = {}) => ({
  jobId: "job-one",
  managedTarget: path.join(root, "managed", "owner", "repository"),
  placement: { mode, ...(mode === "managed" ? {} : { path: linkPath }) },
  projectId,
  ...extra,
});
async function registry(records) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    registryPath,
    JSON.stringify({ version: 1, records }) + "\n",
    { mode: 0o600 },
  );
}
async function clearRegistry() {
  await rm(registryPath, { recursive: true, force: true });
}
try {
  assert.equal(await compare("probe"), true);
  await compare("prepare", prepare("managed"));
  await compare("prepare", prepare("direct"));
  await compare("prepare", prepare("managed-link"));
  for (const value of [
    "",
    "relative",
    root + "/",
    root + "\\",
    root + "/.",
    root + "/..",
    root + "/nul\0",
    root + "/" + "a".repeat(8193),
  ])
    await compare(
      "prepare",
      prepare("direct", { placement: { mode: "direct", path: value } }),
      { ok: false },
    );
  await compare(
    "prepare",
    prepare("direct", {
      placement: { mode: "direct", path: root + "/raw\ud800" },
    }),
  );
  await mkdir(path.join(root, "existing"));
  await compare(
    "prepare",
    prepare("direct", {
      placement: { mode: "direct", path: path.join(root, "existing") },
    }),
  );
  await writeFile(path.join(root, "file"), "preserve");
  await compare(
    "prepare",
    prepare("direct", {
      placement: { mode: "direct", path: path.join(root, "file") },
    }),
    { ok: false },
  );
  await symlink(canonical, path.join(root, "alias"));
  await compare(
    "prepare",
    prepare("direct", {
      placement: { mode: "direct", path: path.join(root, "alias") },
    }),
  );
  await symlink(path.join(root, "missing"), path.join(root, "broken"));
  await compare(
    "prepare",
    prepare("direct", {
      placement: { mode: "direct", path: path.join(root, "broken") },
    }),
    { ok: false },
  );
  await compare(
    "prepare",
    prepare("managed-link", {
      placement: {
        mode: "managed-link",
        path: path.join(root, "managed", "owner", "repository", "inside"),
      },
    }),
    { ok: false },
  );
  await compare("record", baseRecord);
  await compare("verifyPlacementOwnership", proof, { ok: false });
  await compare("writeCreatedMarker", proof);
  assert.equal(await compare("classifyExisting", proof), "cantrip");
  await compare("verifyPlacementOwnership", proof);
  await compare("record", { ...baseRecord, projectId: "other" }, { ok: false });
  await compare(
    "classifyExisting",
    { ...proof, projectId: "other" },
    { ok: false },
  );
  await compare(
    "classifyExisting",
    { ...proof, repositoryFingerprint: "b".repeat(64) },
    { ok: false },
  );
  await compare("classifyExisting", proof, {
    worker: "other-worker",
    ok: false,
  });
  await compare("verifyPlacementOwnership", proof, {
    worker: "other-worker",
    ok: false,
  });
  await compare("releasePlacement", proof);
  assert.equal(await compare("isPlacementReleased", proof), true);
  await compare("releasePlacement", proof);
  assert.equal(await compare("classifyExisting", proof), "user");
  await compare("forgetPlacement", proof);
  await compare("forgetPlacement", proof);
  const staging = path.join(root, "stage"),
    claim = { jobId: "job-one", projectId, stagingPath: staging };
  await compare("claimStaging", claim);
  await mkdir(staging);
  await writeFile(path.join(staging, "owned"), "disposable");
  await compare("claimStaging", claim);
  await mkdir(staging);
  await writeFile(path.join(staging, "owned"), "disposable");
  await compare("cleanupStaging", { ...claim, jobId: "foreign" });
  assert.equal(
    await readFile(path.join(staging, "owned"), "utf8"),
    "disposable",
  );
  await compare("cleanupStaging", claim);
  await compare("cleanupStaging", claim);
  await mkdir(staging);
  await compare("claimStaging", claim, { ok: false });
  await rm(staging, { recursive: true });
  await compare(
    "materializeManagedLink",
    {
      canonicalPath: canonical,
      linkPath,
      projectId,
      repositoryFingerprint: fingerprint,
      requestedPath: linkPath,
      requireExistingClaim: true,
    },
    { ok: false },
  );
  const link = {
    canonicalPath: canonical,
    linkPath,
    projectId,
    repositoryFingerprint: fingerprint,
    requestedPath: linkPath,
  };
  assert.equal((await compare("materializeManagedLink", link)).changed, true);
  assert.equal((await compare("materializeManagedLink", link)).changed, false);
  const linkProof = { ...proof, mode: "managed-link", linkPath };
  await compare("verifyPlacementOwnership", linkProof);
  await rm(linkPath);
  assert.equal(
    (
      await compare("materializeManagedLink", {
        ...link,
        requireExistingClaim: true,
      })
    ).changed,
    true,
  );
  await compare(
    "materializeManagedLink",
    { ...link, projectId: "foreign" },
    { ok: false },
  );
  await rm(linkPath);
  await writeFile(linkPath, "user replacement");
  await compare("materializeManagedLink", link, { ok: false });
  assert.equal(
    (await compare("removeManagedLinkIfMatching", link)).removed,
    false,
  );
  await rm(linkPath);
  await symlink(path.join(root, "existing"), linkPath);
  await compare("materializeManagedLink", link, { ok: false });
  assert.equal(
    (await compare("removeManagedLinkIfMatching", link)).removed,
    false,
  );
  await rm(linkPath);
  await symlink(canonical, linkPath);
  assert.equal(
    (await compare("removeManagedLinkIfMatching", link)).removed,
    true,
  );
  assert.equal(
    (await compare("removeManagedLinkIfMatching", link)).removed,
    false,
  );
  const removedCanonical = path.join(root, "deleted-checkout");
  await symlink(removedCanonical, linkPath);
  assert.equal(
    (
      await compare("removeManagedLinkIfMatching", {
        linkPath,
        canonicalPath: removedCanonical,
      })
    ).removed,
    true,
  );
  await compare("releasePlacement", linkProof);
  assert.equal(await compare("isPlacementReleased", linkProof), true);
  await compare("materializeManagedLink", link, { ok: false });
  await compare("prepare", prepare("managed", { managedTarget: canonical }), {
    ok: false,
  });
  await clearRegistry();
  await writeFile(
    path.join(gitCommonDir, "cantrip-project-owner.json"),
    "invalid",
  );
  await compare("classifyExisting", proof, { ok: false });
  // Source commits release before attempting marker removal. A damaged marker
  // must leave that released record durable, even though the call rejects.
  await registry([{ ...baseRecord, workerId }]);
  await compare("releasePlacement", proof, { ok: false });
  assert.equal(await compare("isPlacementReleased", proof), true);
  assert.equal(
    await readFile(
      path.join(gitCommonDir, "cantrip-project-owner.json"),
      "utf8",
    ),
    "invalid",
  );
  await rm(path.join(gitCommonDir, "cantrip-project-owner.json"));
  await compare("releasePlacement", proof);
  await registry([{ ...baseRecord, workerId: "other-worker" }]);
  await compare("releasePlacement", proof, { ok: false });
  for (const value of [
    { version: 2, records: [] },
    { version: 1, records: [{}] },
    null,
  ]) {
    await writeFile(registryPath, JSON.stringify(value));
    await compare("prepare", prepare("direct"), { ok: false });
  }
  await writeFile(registryPath, "{");
  await compare("prepare", prepare("direct"), { ok: false });
  await clearRegistry();
  await symlink(path.join(root, "file"), registryPath);
  await compare("prepare", prepare("direct"), { ok: false });
  await clearRegistry();
  const batch = Array.from({ length: 8 }, (_, i) => ({
    method: "record",
    input: {
      ...baseRecord,
      canonicalPath: path.join(root, "batch-" + i),
      requestedPath: path.join(root, "batch-" + i),
      projectId: "batch-" + i,
      ownership: "user",
    },
  }));
  assert.ok((await compare("batch", batch)).every((value) => value.ok));
  assert.equal(
    JSON.parse(await readFile(registryPath, "utf8")).records.length,
    8,
  );
  const afterFailure = await compare("batch", [
    { method: "record", input: { ...batch[0].input, projectId: "collision" } },
    {
      method: "record",
      input: {
        ...batch[0].input,
        projectId: "after-rejection",
        canonicalPath: path.join(root, "after-rejection"),
      },
    },
  ]);
  assert.equal(afterFailure[0].ok, false);
  assert.equal(afterFailure[1].ok, true);
  console.log(
    JSON.stringify({
      suite: "native-replica-placement",
      comparisons,
      methods: [...methods],
      actualFilesystem: true,
      exactStateBytesModesAndLinks: true,
      privateMarkersAndRegistry: true,
      stagingOwnership: true,
      managedLinkRepairAndRetention: true,
      matchingBrokenLinkRemoval: true,
      releasedRecordSurvivesMarkerFailure: true,
      serializedWrites: true,
      serializationRecoversAfterRejection: true,
      nodeAbsentFromNativePath: true,
      productionProvisioningStillPending: true,
    }),
  );
} finally {
  child.stdin.end();
  assert.equal(await completion, 0);
  await rm(root, { recursive: true, force: true });
}
