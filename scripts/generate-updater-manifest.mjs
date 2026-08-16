import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const platformSpecs = {
  "darwin-aarch64": {
    artifactPattern: /\.app\.tar\.gz$/u,
  },
  "windows-x86_64": {
    artifactPattern: /-setup\.exe$/iu,
  },
};

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(absolute)));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

function assertVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`Updater version is not valid SemVer: ${version}`);
  }
}

function assertPublishedAt(publishedAt) {
  const parsed = new Date(publishedAt);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== publishedAt) {
    throw new Error(
      `Updater publication date must be an ISO-8601 UTC timestamp: ${publishedAt}`,
    );
  }
}

function encodedAssetUrl(baseUrl, filename) {
  const normalized = new URL(baseUrl);
  if (normalized.protocol !== "https:") {
    throw new Error("Updater asset base URL must use HTTPS.");
  }
  normalized.pathname = `${normalized.pathname.replace(/\/$/u, "")}/${encodeURIComponent(filename)}`;
  return normalized.toString();
}

async function resolvePlatform(files, platform, baseUrl) {
  const spec = platformSpecs[platform];
  const artifacts = files.filter(
    (file) =>
      spec.artifactPattern.test(path.basename(file)) && !file.endsWith(".sig"),
  );
  if (artifacts.length !== 1) {
    throw new Error(
      `Expected exactly one ${platform} updater artifact, found ${artifacts.length}.`,
    );
  }

  const artifact = artifacts[0];
  const signaturePath = `${artifact}.sig`;
  if (!files.includes(signaturePath)) {
    throw new Error(
      `Updater signature is missing for ${path.basename(artifact)}.`,
    );
  }
  const signature = (await readFile(signaturePath, "utf8")).trim();
  if (!signature) {
    throw new Error(
      `Updater signature is empty for ${path.basename(artifact)}.`,
    );
  }

  return {
    signature,
    url: encodedAssetUrl(baseUrl, path.basename(artifact)),
  };
}

export async function generateUpdaterManifest({
  assetsDirectory,
  baseUrl,
  notes = "",
  publishedAt,
  version,
}) {
  assertVersion(version);
  assertPublishedAt(publishedAt);
  const files = await listFiles(assetsDirectory);
  const platforms = {};
  for (const platform of Object.keys(platformSpecs)) {
    platforms[platform] = await resolvePlatform(files, platform, baseUrl);
  }
  return {
    version,
    notes,
    pub_date: publishedAt,
    platforms,
  };
}

function parseArguments(arguments_) {
  const values = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unknown updater-manifest argument: ${argument}`);
    }
    const key = argument.slice(2);
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value.`);
    }
    values[key] = value;
    index += 1;
  }
  for (const required of [
    "assets",
    "base-url",
    "notes",
    "output",
    "published-at",
    "version",
  ]) {
    if (!values[required]) throw new Error(`--${required} is required.`);
  }
  return values;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const input = parseArguments(process.argv.slice(2));
  const manifest = await generateUpdaterManifest({
    assetsDirectory: path.resolve(input.assets),
    baseUrl: input["base-url"],
    notes: await readFile(path.resolve(input.notes), "utf8"),
    publishedAt: input["published-at"],
    version: input.version,
  });
  await writeFile(
    path.resolve(input.output),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}
