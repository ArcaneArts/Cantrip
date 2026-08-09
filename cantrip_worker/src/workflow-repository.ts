import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import path from "node:path";

import {
  workflowPortableDefinitionSchema,
  workflowRepositoryDocumentSchema,
  workflowRepositoryInventorySchema,
  workflowRepositoryWriteResultSchema,
  type WorkflowPortableDefinition,
  type WorkflowRepositoryDocument,
  type WorkflowRepositoryItem,
} from "@cantrip/protocol/workflows";

const MAX_FILES_PER_SOURCE = 100;
const MAX_FILE_BYTES = 1_000_000;
const MAX_CONVERSION_SOURCE = 100_000;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function portableSlug(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 100);
  return slug || "imported-workflow";
}

function titleFromFile(fileName: string): string {
  return path
    .basename(fileName, path.extname(fileName))
    .replace(/[-_]+/gu, " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function itemId(
  source: WorkflowRepositoryItem["source"],
  relativePath: string,
  contentHash: string,
): string {
  return sha256(`${source}\0${relativePath}\0${contentHash}`);
}

function diagnosticItem(
  source: WorkflowRepositoryItem["source"],
  relativePath: string,
  status: "invalid" | "unsupported",
  diagnostic: string,
  content: string | null,
): WorkflowRepositoryItem {
  const contentHash = sha256(content ?? `unreadable:${relativePath}`);
  return {
    id: itemId(source, relativePath, contentHash),
    path: relativePath,
    source,
    status,
    diagnostic,
    contentHash,
    definition: null,
    conversionSource:
      content === null ? null : content.slice(0, MAX_CONVERSION_SOURCE),
  };
}

function parseFrontmatter(content: string): {
  body: string;
  description: string | null;
  name: string | null;
} {
  if (!content.startsWith("---\n")) {
    return { body: content.trim(), description: null, name: null };
  }
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) {
    return { body: content.trim(), description: null, name: null };
  }
  const values = new Map<string, string>();
  for (const line of content.slice(4, end).split("\n")) {
    const match = /^([a-zA-Z][\w-]*):\s*(.*?)\s*$/u.exec(line);
    if (match) values.set(match[1]!.toLowerCase(), match[2]!);
  }
  return {
    body: content.slice(end + 5).trim(),
    name: values.get("name") ?? values.get("title") ?? null,
    description: values.get("description") ?? null,
  };
}

function markdownDefinition(
  fileName: string,
  content: string,
): WorkflowPortableDefinition {
  const frontmatter = parseFrontmatter(content);
  if (!frontmatter.body) {
    throw new Error(
      "Claude Markdown workflows require a non-empty prompt body.",
    );
  }
  const name = frontmatter.name || titleFromFile(fileName);
  return workflowPortableDefinitionSchema.parse({
    slug: portableSlug(name),
    name,
    description: frontmatter.description,
    revision: {
      graph: {
        version: 1,
        nodes: [
          {
            key: "run",
            type: "agent",
            name: "Run workflow",
            configuration: { prompt: frontmatter.body },
          },
        ],
        edges: [],
      },
    },
  });
}

interface ClaudeJsonStep {
  dependsOn?: string[];
  key?: string;
  mutationMode?: "read-only" | "write";
  name?: string;
  prompt: string;
}

function jsonStep(value: unknown, index: number): ClaudeJsonStep {
  if (typeof value === "string" && value.trim()) {
    return { name: `Step ${index + 1}`, prompt: value.trim() };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Claude workflow step ${index + 1} is not recognized.`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.prompt !== "string" || !record.prompt.trim()) {
    throw new Error(`Claude workflow step ${index + 1} requires a prompt.`);
  }
  if (
    record.dependsOn !== undefined &&
    (!Array.isArray(record.dependsOn) ||
      record.dependsOn.some((item) => typeof item !== "string" || !item.trim()))
  ) {
    throw new Error(
      `Claude workflow step ${index + 1} has invalid dependsOn entries.`,
    );
  }
  if (
    record.mutationMode !== undefined &&
    record.mutationMode !== "read-only" &&
    record.mutationMode !== "write"
  ) {
    throw new Error(
      `Claude workflow step ${index + 1} has an invalid mutationMode.`,
    );
  }
  return {
    prompt: record.prompt.trim(),
    name:
      typeof record.name === "string" && record.name.trim()
        ? record.name.trim()
        : `Step ${index + 1}`,
    key:
      typeof record.key === "string" && record.key.trim()
        ? record.key.trim()
        : undefined,
    dependsOn: record.dependsOn as string[] | undefined,
    mutationMode: record.mutationMode as ClaudeJsonStep["mutationMode"],
  };
}

function jsonDefinition(
  fileName: string,
  content: string,
): WorkflowPortableDefinition {
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Claude JSON workflows require an object root.");
  }
  const root = parsed as Record<string, unknown>;
  const nested =
    root.workflow &&
    typeof root.workflow === "object" &&
    !Array.isArray(root.workflow)
      ? (root.workflow as Record<string, unknown>)
      : root;
  if (!Array.isArray(nested.steps) || nested.steps.length === 0) {
    throw new Error("Claude JSON workflows require a non-empty steps array.");
  }
  const steps = nested.steps.map(jsonStep);
  const used = new Set<string>();
  const keys = steps.map((step, index) => {
    const base = portableSlug(step.key || step.name || `step-${index + 1}`);
    let key = base;
    let suffix = 2;
    while (used.has(key)) key = `${base}-${suffix++}`;
    used.add(key);
    return key;
  });
  const aliases = new Map<string, string>();
  steps.forEach((step, index) => {
    aliases.set(keys[index]!, keys[index]!);
    if (step.key) aliases.set(step.key, keys[index]!);
    if (step.name) aliases.set(step.name, keys[index]!);
  });
  const edges = steps.flatMap((step, index) => {
    const dependencies =
      step.dependsOn ?? (index === 0 ? [] : [keys[index - 1]!]);
    return dependencies.map((dependency) => {
      const from = aliases.get(dependency);
      if (!from) {
        throw new Error(
          `Claude workflow step ${index + 1} depends on unknown step ${dependency}.`,
        );
      }
      return { from, to: keys[index]! };
    });
  });
  const name =
    typeof nested.name === "string" && nested.name.trim()
      ? nested.name.trim()
      : titleFromFile(fileName);
  return workflowPortableDefinitionSchema.parse({
    slug: portableSlug(name),
    name,
    description:
      typeof nested.description === "string" && nested.description.trim()
        ? nested.description.trim()
        : null,
    revision: {
      graph: {
        version: 1,
        nodes: steps.map((step, index) => ({
          key: keys[index],
          type: "agent",
          name: step.name,
          configuration: { prompt: step.prompt },
          mutationMode: step.mutationMode ?? "read-only",
          permissionRequirements: {
            filesystem:
              step.mutationMode === "write" ? "workspace-write" : "read-only",
          },
        })),
        edges,
      },
    },
  });
}

async function scanDirectory(
  root: string,
  relativeDirectory: string,
  source: WorkflowRepositoryItem["source"],
): Promise<{ diagnostics: string[]; items: WorkflowRepositoryItem[] }> {
  const absoluteDirectory = path.join(root, ...relativeDirectory.split("/"));
  let directoryStat;
  try {
    directoryStat = await lstat(absoluteDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { diagnostics: [], items: [] };
    }
    return {
      diagnostics: [`Could not inspect ${relativeDirectory}: ${String(error)}`],
      items: [],
    };
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    return {
      diagnostics: [
        `${relativeDirectory} must be a real directory, not a symlink or file.`,
      ],
      items: [],
    };
  }
  const canonicalDirectory = await realpath(absoluteDirectory);
  const relative = path.relative(root, canonicalDirectory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return {
      diagnostics: [
        `${relativeDirectory} resolves outside the project checkout.`,
      ],
      items: [],
    };
  }
  const entries = (await readdir(canonicalDirectory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_FILES_PER_SOURCE);
  const items: WorkflowRepositoryItem[] = [];
  for (const entry of entries) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (!entry.isFile()) {
      items.push(
        diagnosticItem(
          source,
          relativePath,
          "unsupported",
          "Only regular files are inspected; directories and symlinks are never followed.",
          null,
        ),
      );
      continue;
    }
    const absolutePath = path.join(canonicalDirectory, entry.name);
    const fileStat = await lstat(absolutePath);
    if (!fileStat.isFile() || fileStat.size > MAX_FILE_BYTES) {
      items.push(
        diagnosticItem(
          source,
          relativePath,
          "invalid",
          `Workflow files must be regular files no larger than ${MAX_FILE_BYTES} bytes.`,
          null,
        ),
      );
      continue;
    }
    const content = await readFile(absolutePath, "utf8");
    const contentHash = sha256(content);
    try {
      let definition: WorkflowPortableDefinition;
      if (source === "cantrip") {
        if (path.extname(entry.name).toLowerCase() !== ".json") {
          throw new Error(
            "Cantrip repository workflows must use the .json extension.",
          );
        }
        definition = workflowRepositoryDocumentSchema.parse(
          JSON.parse(content),
        ).definition;
      } else {
        const extension = path.extname(entry.name).toLowerCase();
        if ([".js", ".cjs", ".mjs", ".ts"].includes(extension)) {
          items.push(
            diagnosticItem(
              source,
              relativePath,
              "unsupported",
              "Arbitrary JavaScript workflows are not executed. Review the source and use Codex-assisted conversion.",
              content,
            ),
          );
          continue;
        }
        if (extension === ".md") {
          definition = markdownDefinition(entry.name, content);
        } else if (extension === ".json") {
          definition = jsonDefinition(entry.name, content);
        } else {
          items.push(
            diagnosticItem(
              source,
              relativePath,
              "unsupported",
              "Supported Claude workflow shapes are Markdown prompts and JSON step graphs. Use Codex-assisted conversion for this file.",
              content,
            ),
          );
          continue;
        }
      }
      items.push({
        id: itemId(source, relativePath, contentHash),
        path: relativePath,
        source,
        status: "ready",
        diagnostic: null,
        contentHash,
        definition,
        conversionSource: null,
      });
    } catch (error) {
      items.push(
        diagnosticItem(
          source,
          relativePath,
          "invalid",
          error instanceof Error ? error.message : String(error),
          source === "claude-code" ? content : null,
        ),
      );
    }
  }
  return { diagnostics: [], items };
}

export async function scanWorkflowRepository(cwd: string) {
  const root = await realpath(cwd);
  const [cantrip, claude] = await Promise.all([
    scanDirectory(root, ".cantrip/workflows", "cantrip"),
    scanDirectory(root, ".claude/workflows", "claude-code"),
  ]);
  return workflowRepositoryInventorySchema.parse({
    convention: ".cantrip/workflows/<slug>.json",
    items: [...cantrip.items, ...claude.items],
    diagnostics: [...cantrip.diagnostics, ...claude.diagnostics],
  });
}

async function ensureRealDirectory(
  parent: string,
  name: string,
): Promise<string> {
  const target = path.join(parent, name);
  try {
    await mkdir(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const targetStat = await lstat(target);
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
    throw new Error(`${target} must be a real directory.`);
  }
  const canonical = await realpath(target);
  const relative = path.relative(parent, canonical);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${target} resolves outside its parent directory.`);
  }
  return canonical;
}

export async function writeWorkflowRepositoryDocument(
  cwd: string,
  documentInput: WorkflowRepositoryDocument,
  overwrite = false,
) {
  const document = workflowRepositoryDocumentSchema.parse(documentInput);
  const root = await realpath(cwd);
  const cantripDirectory = await ensureRealDirectory(root, ".cantrip");
  const workflowDirectory = await ensureRealDirectory(
    cantripDirectory,
    "workflows",
  );
  const fileName = `${document.definition.slug}.json`;
  const target = path.join(workflowDirectory, fileName);
  const encoded = `${JSON.stringify(document, null, 2)}\n`;
  const contentHash = sha256(encoded);
  try {
    const existingStat = await lstat(target);
    if (existingStat.isSymbolicLink() || !existingStat.isFile()) {
      throw new Error(
        `Refusing to replace non-regular workflow path ${fileName}.`,
      );
    }
    const existing = await readFile(target, "utf8");
    if (sha256(existing) === contentHash) {
      return workflowRepositoryWriteResultSchema.parse({
        path: `.cantrip/workflows/${fileName}`,
        contentHash,
        changed: false,
      });
    }
    if (!overwrite) {
      throw new Error(
        `Workflow repository file .cantrip/workflows/${fileName} already exists with different content.`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    (overwrite
      ? constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0)
      : constants.O_EXCL);
  const handle = await open(target, flags, 0o600);
  try {
    await handle.writeFile(encoded, "utf8");
  } finally {
    await handle.close();
  }
  return workflowRepositoryWriteResultSchema.parse({
    path: `.cantrip/workflows/${fileName}`,
    contentHash,
    changed: true,
  });
}
