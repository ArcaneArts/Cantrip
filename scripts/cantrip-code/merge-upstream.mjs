import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createSourceManifest,
  downloadUpstream,
  parseArgs,
  readJson,
  upstreamConfigPath,
  upstreamFilesPath,
  upstreamRoot,
  writeJson,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.flag("confirm")) {
  throw new Error(
    "Refusing to replace tracked upstream source without explicit --confirm",
  );
}

const version = args.required("version");
const ref = args.required("ref");
const sha = args.required("sha");
const vscodeSha = args.required("vscode-sha");
if (!/^[0-9a-f]{40}$/.test(vscodeSha)) {
  throw new Error(`Invalid Code OSS commit SHA: ${vscodeSha}`);
}

const current = await readJson(upstreamConfigPath);
const temporary = await mkdtemp(path.join(os.tmpdir(), "cantrip-code-merge-"));
const source = path.join(temporary, "source");
try {
  await downloadUpstream({ sha, output: source });
  const packageJson = JSON.parse(
    await readFile(path.join(source, "package.json"), "utf8"),
  );
  if (packageJson.version !== version) {
    throw new Error(
      `Requested version ${version} does not match upstream package ${packageJson.version}`,
    );
  }
  const previous = `${upstreamRoot}.previous`;
  await rm(previous, { recursive: true, force: true });
  await rename(upstreamRoot, previous);
  try {
    await rename(source, upstreamRoot);
  } catch (error) {
    await rename(previous, upstreamRoot);
    throw error;
  }
  await rm(previous, { recursive: true, force: true });
  const stagedManifest = await createSourceManifest(upstreamRoot);
  await writeJson(upstreamConfigPath, {
    ...current,
    version,
    ref,
    openvscodeServerCommit: sha,
    vscodeCommit: vscodeSha,
  });
  await writeJson(upstreamFilesPath, stagedManifest);
  console.log(`Imported OpenVSCode Server ${ref} (${sha})`);
  console.log(
    "Review every resulting source and manifest change before committing.",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
