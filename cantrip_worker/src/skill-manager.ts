import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  skillSettingsDocumentSchema,
  skillSettingsInventorySchema,
  skillSettingsMutationResultSchema,
  type ModelProviderKind,
  type SkillSettingsDocument,
  type SkillSettingsInventory,
  type SkillSettingsItem,
  type SkillSettingsLocation,
  type SkillSettingsMutationResult,
} from "@cantrip/protocol";

import { codexAccountHome } from "./codex/account-home.js";

const MAX_DISCOVERY_DEPTH = 6;
const MAX_SKILLS_PER_ROOT = 1_000;
const MAX_DIRECTORIES_PER_ROOT = 2_000;
const MAX_FILES_PER_SKILL = 500;
const MAX_FILE_BYTES = 1_000_000;

interface SkillRoot {
  editable: boolean;
  location: SkillSettingsLocation;
  path: string;
  scope: SkillSettingsItem["scope"];
}

interface SkillContext {
  cwd: string | null;
  providerId: string;
  providerKind: ModelProviderKind;
}

function pathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function displayError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stripYamlString(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function parseSkillFrontmatter(content: string): {
  description: string | null;
  name: string | null;
} {
  const normalized = content.replace(/^\uFEFF/u, "").replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) {
    return { description: null, name: null };
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) return { description: null, name: null };
  const values = new Map<string, string>();
  for (const line of normalized.slice(4, end).split("\n")) {
    const match = /^([a-zA-Z][\w-]*):\s*(.*?)\s*$/u.exec(line);
    if (match) values.set(match[1]!.toLowerCase(), stripYamlString(match[2]!));
  }
  return {
    name: values.get("name") || null,
    description: values.get("description") || null,
  };
}

function validateSkillDocument(content: string): void {
  const { description, name } = parseSkillFrontmatter(content);
  if (!name || !description) {
    throw new Error(
      "SKILL.md must include non-empty name and description frontmatter.",
    );
  }
  if (name.length > 64) {
    throw new Error("The skill name must be 64 characters or fewer.");
  }
  if (description.length > 1_024) {
    throw new Error("The skill description must be 1,024 characters or fewer.");
  }
}

function encodeSkillId(location: SkillSettingsLocation, relativePath: string) {
  return `${location}:${Buffer.from(relativePath, "utf8").toString("base64url")}`;
}

function decodeSkillId(id: string): {
  location: SkillSettingsLocation;
  relativePath: string;
} {
  const separator = id.indexOf(":");
  if (separator < 1) throw new Error("The requested skill id is invalid.");
  const location = id.slice(0, separator);
  if (!["project", "account", "user", "system", "admin"].includes(location)) {
    throw new Error("The requested skill location is invalid.");
  }
  let relativePath: string;
  try {
    relativePath = Buffer.from(id.slice(separator + 1), "base64url").toString(
      "utf8",
    );
  } catch {
    throw new Error("The requested skill id is invalid.");
  }
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath
      .split(/[\\/]/u)
      .some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("The requested skill path is invalid.");
  }
  return {
    location: location as SkillSettingsLocation,
    relativePath,
  };
}

async function optionalRealpath(candidate: string): Promise<string | null> {
  try {
    return await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function displayNameForSkill(
  skillDirectory: string,
): Promise<string | null> {
  const metadataPath = path.join(skillDirectory, "agents", "openai.yaml");
  try {
    if ((await stat(metadataPath)).size > MAX_FILE_BYTES) return null;
    const metadata = await readFile(metadataPath, "utf8");
    const match = /^\s*display_name:\s*(.*?)\s*$/mu.exec(metadata);
    return match?.[1] ? stripYamlString(match[1]) || null : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

export class SkillManager {
  readonly #adminSkillsDirectory: string;
  readonly #dataDirectory: string;
  readonly #homeDirectory: string;

  constructor(
    dataDirectory: string,
    homeDirectory = os.homedir(),
    adminSkillsDirectory = "/etc/codex/skills",
  ) {
    this.#dataDirectory = path.resolve(dataDirectory);
    this.#homeDirectory = path.resolve(homeDirectory);
    this.#adminSkillsDirectory = path.resolve(adminSkillsDirectory);
  }

  async list(context: SkillContext): Promise<SkillSettingsInventory> {
    const roots = await this.#roots(context);
    const inventory: SkillSettingsInventory = {
      project: [],
      global: [],
      errors: [],
    };
    for (const root of roots) {
      try {
        const items = await this.#scanRoot(root);
        if (root.location === "project") inventory.project.push(...items);
        else inventory.global.push(...items);
      } catch (error) {
        inventory.errors.push({
          path: root.path,
          message: displayError(error),
        });
      }
    }
    const compare = (left: SkillSettingsItem, right: SkillSettingsItem) =>
      (left.displayName ?? left.name).localeCompare(
        right.displayName ?? right.name,
      );
    inventory.project.sort(compare);
    inventory.global.sort((left, right) => {
      const locationOrder = ["account", "user", "system", "admin"];
      return (
        locationOrder.indexOf(left.location) -
          locationOrder.indexOf(right.location) || compare(left, right)
      );
    });
    return skillSettingsInventorySchema.parse(inventory);
  }

  async read(
    context: SkillContext,
    skillId: string,
    file: string,
  ): Promise<SkillSettingsDocument> {
    const resolved = await this.#resolveSkill(context, skillId);
    const files = await this.#filesForSkill(resolved.directory);
    const selected = files.find((candidate) => candidate.path === file);
    if (!selected) throw new Error("The requested skill file was not found.");
    if (selected.sizeBytes > MAX_FILE_BYTES) {
      throw new Error("The requested skill file is too large to browse.");
    }
    const filePath = await this.#resolveFile(resolved.directory, file);
    const content = await readFile(filePath, "utf8");
    if (content.includes("\0")) {
      throw new Error("Binary skill files cannot be displayed in the editor.");
    }
    return skillSettingsDocumentSchema.parse({
      skill: resolved.item,
      file: selected,
      files,
      content,
    });
  }

  async write(
    context: SkillContext,
    skillId: string,
    file: string,
    content: string,
  ): Promise<SkillSettingsMutationResult> {
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      throw new Error("Skill files must be 1 MB or smaller.");
    }
    if (content.includes("\0")) {
      throw new Error(
        "Binary content cannot be written through the skill editor.",
      );
    }
    const resolved = await this.#resolveSkill(context, skillId, true);
    const filePath = await this.#resolveFile(resolved.directory, file);
    const fileInfo = await lstat(filePath);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
      throw new Error("Only existing regular skill files can be edited.");
    }
    if (file === "SKILL.md") validateSkillDocument(content);
    const temporaryPath = path.join(
      path.dirname(filePath),
      `.cantrip-${path.basename(filePath)}-${randomUUID()}.tmp`,
    );
    await writeFile(temporaryPath, content, {
      encoding: "utf8",
      flag: "wx",
      mode: fileInfo.mode,
    });
    try {
      await rename(temporaryPath, filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    return skillSettingsMutationResultSchema.parse({
      changed: true,
      recoveryPath: null,
    });
  }

  async delete(
    context: SkillContext,
    skillId: string,
  ): Promise<SkillSettingsMutationResult> {
    const resolved = await this.#resolveSkill(context, skillId, true);
    const recoveryDirectory = path.join(
      this.#dataDirectory,
      "skill-recovery",
      new Date().toISOString().slice(0, 10),
    );
    await mkdir(recoveryDirectory, { recursive: true });
    const recoveryPath = path.join(
      recoveryDirectory,
      `${path.basename(resolved.directory)}-${randomUUID()}`,
    );
    try {
      await rename(resolved.directory, recoveryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await cp(resolved.directory, recoveryPath, {
        recursive: true,
        errorOnExist: true,
      });
      await rm(resolved.directory, { recursive: true });
    }
    return skillSettingsMutationResultSchema.parse({
      changed: true,
      recoveryPath,
    });
  }

  async #roots(context: SkillContext): Promise<SkillRoot[]> {
    const accountHome =
      context.providerKind === "chatgpt" || context.providerKind === "grok"
        ? codexAccountHome(this.#dataDirectory, context.providerId)
        : path.join(this.#dataDirectory, "codex-home");
    const roots: SkillRoot[] = [];
    if (context.cwd) {
      roots.push({
        path: path.join(await realpath(context.cwd), ".agents", "skills"),
        location: "project",
        scope: "repo",
        editable: true,
      });
    }
    roots.push(
      {
        path: path.join(accountHome, "skills"),
        location: "account",
        scope: "user",
        editable: true,
      },
      {
        path: path.join(this.#homeDirectory, ".agents", "skills"),
        location: "user",
        scope: "user",
        editable: true,
      },
      {
        path: path.join(accountHome, "skills", ".system"),
        location: "system",
        scope: "system",
        editable: false,
      },
      {
        path: this.#adminSkillsDirectory,
        location: "admin",
        scope: "admin",
        editable: false,
      },
    );
    return roots;
  }

  async #scanRoot(root: SkillRoot): Promise<SkillSettingsItem[]> {
    const canonicalRoot = await optionalRealpath(root.path);
    if (!canonicalRoot) return [];
    const rootInfo = await stat(canonicalRoot);
    if (!rootInfo.isDirectory()) return [];
    const items: SkillSettingsItem[] = [];
    const directories = [{ directory: root.path, depth: 0 }];
    const visited = new Set<string>();
    while (
      directories.length &&
      items.length < MAX_SKILLS_PER_ROOT &&
      visited.size < MAX_DIRECTORIES_PER_ROOT
    ) {
      const current = directories.shift()!;
      const canonicalDirectory = await optionalRealpath(current.directory);
      if (!canonicalDirectory || visited.has(canonicalDirectory)) continue;
      visited.add(canonicalDirectory);
      const entries = await readdir(current.directory, { withFileTypes: true });
      const skillFile = entries.find(
        (entry) => entry.name === "SKILL.md" && entry.isFile(),
      );
      if (skillFile) {
        const relativePath = path.relative(root.path, current.directory);
        if (
          relativePath &&
          !(
            root.location === "account" &&
            relativePath.split(path.sep)[0] === ".system"
          )
        ) {
          const skillPath = path.join(current.directory, "SKILL.md");
          if ((await stat(skillPath)).size > MAX_FILE_BYTES) continue;
          const content = await readFile(skillPath, "utf8");
          const frontmatter = parseSkillFrontmatter(content);
          const linked = (await lstat(current.directory)).isSymbolicLink();
          const editable =
            root.editable &&
            !linked &&
            pathWithin(canonicalRoot, canonicalDirectory);
          items.push({
            id: encodeSkillId(
              root.location,
              relativePath.split(path.sep).join("/"),
            ),
            name: frontmatter.name ?? path.basename(current.directory),
            description: frontmatter.description ?? "No description provided.",
            displayName: await displayNameForSkill(current.directory),
            path: path.join(current.directory, "SKILL.md"),
            scope: root.scope,
            location: root.location,
            editable,
            deletable: editable,
          });
        }
        continue;
      }
      if (current.depth >= MAX_DISCOVERY_DEPTH) continue;
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (
          root.location === "account" &&
          current.depth === 0 &&
          entry.name === ".system"
        ) {
          continue;
        }
        directories.push({
          directory: path.join(current.directory, entry.name),
          depth: current.depth + 1,
        });
      }
    }
    return items;
  }

  async #resolveSkill(
    context: SkillContext,
    skillId: string,
    requireEditable = false,
  ): Promise<{ directory: string; item: SkillSettingsItem }> {
    const decoded = decodeSkillId(skillId);
    const roots = await this.#roots(context);
    const root = roots.find(
      (candidate) => candidate.location === decoded.location,
    );
    if (!root)
      throw new Error("The requested skill is unavailable in this context.");
    const inventory = await this.#scanRoot(root);
    const item = inventory.find((candidate) => candidate.id === skillId);
    if (!item) throw new Error("The requested skill was not found.");
    if (requireEditable && !item.editable) {
      throw new Error(
        "Bundled and administrator-managed skills are read-only.",
      );
    }
    return { directory: path.dirname(item.path), item };
  }

  async #filesForSkill(directory: string) {
    const canonicalDirectory = await realpath(directory);
    const files: Array<{ path: string; sizeBytes: number }> = [];
    const pending = [directory];
    while (pending.length && files.length < MAX_FILES_PER_SKILL) {
      const current = pending.shift()!;
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const candidate = path.join(current, entry.name);
        if (entry.isDirectory()) {
          pending.push(candidate);
          continue;
        }
        if (!entry.isFile()) continue;
        const canonicalFile = await realpath(candidate);
        if (!pathWithin(canonicalDirectory, canonicalFile)) continue;
        const info = await stat(canonicalFile);
        files.push({
          path: path.relative(directory, candidate).split(path.sep).join("/"),
          sizeBytes: info.size,
        });
        if (files.length >= MAX_FILES_PER_SKILL) break;
      }
    }
    return files.sort((left, right) => {
      if (left.path === "SKILL.md") return -1;
      if (right.path === "SKILL.md") return 1;
      return left.path.localeCompare(right.path);
    });
  }

  async #resolveFile(directory: string, file: string): Promise<string> {
    if (!file || path.isAbsolute(file)) {
      throw new Error("The requested skill file path is invalid.");
    }
    const canonicalDirectory = await realpath(directory);
    const candidate = path.resolve(directory, file);
    const canonicalFile = await realpath(candidate);
    if (!pathWithin(canonicalDirectory, canonicalFile)) {
      throw new Error("The requested file is outside the selected skill.");
    }
    return canonicalFile;
  }
}
