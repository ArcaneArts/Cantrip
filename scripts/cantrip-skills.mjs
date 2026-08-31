import { createHash } from "node:crypto";
import { cp, lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const skillTemplatesDirectory = path.join(
  repositoryRoot,
  "skill_templates",
);

const MAX_FILES_PER_SKILL = 500;
const MAX_FILE_BYTES = 1_000_000;
const MAX_TOTAL_BYTES_PER_SKILL = 5_000_000;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function parseFrontmatterScalar(content, key) {
  const normalized = content.replace(/^\uFEFF/u, "").replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return null;
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) return null;
  const match = new RegExp(`^${key}:\\s*(.*?)\\s*$`, "mu").exec(
    normalized.slice(4, end),
  );
  if (!match?.[1]) return null;
  const value = match[1].trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}

async function collectPackageFiles(directory, relativeDirectory = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(relativeDirectory, entry.name);
    const absolute = path.join(directory, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      throw new Error(`Packaged skills cannot contain symlinks: ${relative}`);
    }
    if (info.isDirectory()) {
      files.push(...(await collectPackageFiles(absolute, relative)));
      continue;
    }
    if (!info.isFile()) {
      throw new Error(`Unsupported packaged skill file type: ${relative}`);
    }
    if (info.size > MAX_FILE_BYTES) {
      throw new Error(
        `Packaged skill file exceeds ${MAX_FILE_BYTES} bytes: ${relative}`,
      );
    }
    files.push({
      absolute,
      path: relative,
      size: info.size,
      contents: await readFile(absolute),
    });
  }
  return files;
}

export async function readSkillTemplates(directory = skillTemplatesDirectory) {
  const root = await lstat(directory).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error(`Packaged skill directory is missing: ${directory}`);
    }
    throw error;
  });
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error("skill_templates must be a regular directory.");
  }
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length === 0) {
    throw new Error("skill_templates must contain at least one skill package.");
  }
  const packages = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(
        `skill_templates may contain only skill directories: ${entry.name}`,
      );
    }
    if (!SKILL_NAME_PATTERN.test(entry.name) || entry.name.length > 64) {
      throw new Error(`Invalid packaged skill directory name: ${entry.name}`);
    }
    const packageDirectory = path.join(directory, entry.name);
    const files = await collectPackageFiles(packageDirectory);
    if (files.length > MAX_FILES_PER_SKILL) {
      throw new Error(
        `Packaged skill ${entry.name} exceeds ${MAX_FILES_PER_SKILL} files.`,
      );
    }
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_TOTAL_BYTES_PER_SKILL) {
      throw new Error(
        `Packaged skill ${entry.name} exceeds ${MAX_TOTAL_BYTES_PER_SKILL} total bytes.`,
      );
    }
    const skillFile = files.find((file) => file.path === "SKILL.md");
    if (!skillFile) {
      throw new Error(`Packaged skill ${entry.name} is missing SKILL.md.`);
    }
    const skillContent = skillFile.contents.toString("utf8");
    const name = parseFrontmatterScalar(skillContent, "name");
    const description = parseFrontmatterScalar(skillContent, "description");
    if (name !== entry.name) {
      throw new Error(
        `Packaged skill ${entry.name} must declare frontmatter name: ${entry.name}.`,
      );
    }
    if (!description || description.length > 1_024) {
      throw new Error(
        `Packaged skill ${entry.name} requires a description of at most 1,024 characters.`,
      );
    }
    packages.push({
      name: entry.name,
      directory: packageDirectory,
      files,
      totalBytes,
    });
  }
  return packages;
}

export function skillTemplatesSha256(packages) {
  const hash = createHash("sha256");
  for (const skill of packages) {
    hash.update(`${skill.name}\0`);
    for (const file of skill.files) {
      hash.update(`${file.path}\0${file.size}\0`);
      hash.update(file.contents);
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

export async function installSkillTemplates(packages, samplesDirectory) {
  for (const skill of packages) {
    const destination = path.join(samplesDirectory, skill.name);
    try {
      await lstat(destination);
      throw new Error(
        `Packaged skill ${skill.name} collides with an upstream bundled skill.`,
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await cp(skill.directory, destination, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
}
