import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  scriptCommandListSchema,
  type ScriptCommand,
  type ScriptCommandKind,
} from "@cantrip/protocol";

const MAX_MANIFEST_BYTES = 512 * 1_024;
const SAFE_COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,199}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const KIND_ORDER: Record<ScriptCommandKind, number> = {
  package: 0,
  dart: 1,
  just: 2,
  cargo: 3,
  gradle: 4,
  make: 5,
};

async function resolveProjectFile(
  cwd: string,
  relativePath: string,
): Promise<string | null> {
  try {
    const [root, target] = await Promise.all([
      realpath(cwd),
      realpath(path.join(cwd, relativePath)),
    ]);
    const relative = path.relative(root, target);
    if (
      relative === "" ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return null;
    }
    return target;
  } catch {
    return null;
  }
}

async function projectFileExists(
  cwd: string,
  relativePath: string,
): Promise<boolean> {
  const target = await resolveProjectFile(cwd, relativePath);
  if (!target) return false;
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

async function readProjectFile(
  cwd: string,
  relativePath: string,
): Promise<string | null> {
  const target = await resolveProjectFile(cwd, relativePath);
  if (!target) return null;
  try {
    const metadata = await stat(target);
    if (!metadata.isFile() || metadata.size > MAX_MANIFEST_BYTES) return null;
    return await readFile(target, "utf8");
  } catch {
    return null;
  }
}

function compactDescription(value: string | null | undefined): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/gu, " ").trim().slice(0, 4_096);
  return compact && !CONTROL_CHARACTERS.test(compact) ? compact : null;
}

function discoveredCommand(
  kind: ScriptCommandKind,
  name: string,
  command: string,
  source: string,
  description?: string | null,
): ScriptCommand | null {
  const normalizedName = name.trim();
  const normalizedCommand = command.trim();
  if (
    !SAFE_COMMAND_NAME.test(normalizedName) ||
    !normalizedCommand ||
    normalizedCommand.length > 4_096 ||
    CONTROL_CHARACTERS.test(normalizedCommand)
  ) {
    return null;
  }
  return {
    id: `${kind}:${source}:${normalizedName}`,
    kind,
    name: normalizedName,
    command: normalizedCommand,
    description: compactDescription(description),
    source,
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function packageRunner(
  cwd: string,
  declaredPackageManager: unknown,
): Promise<"bun" | "npm" | "pnpm" | "yarn"> {
  if (typeof declaredPackageManager === "string") {
    const declared = /^(bun|npm|pnpm|yarn)@/u.exec(declaredPackageManager)?.[1];
    if (declared) return declared as "bun" | "npm" | "pnpm" | "yarn";
  }
  const candidates = await Promise.all([
    projectFileExists(cwd, "pnpm-lock.yaml"),
    projectFileExists(cwd, "yarn.lock"),
    Promise.all([
      projectFileExists(cwd, "bun.lock"),
      projectFileExists(cwd, "bun.lockb"),
    ]).then((values) => values.some(Boolean)),
  ]);
  if (candidates[0]) return "pnpm";
  if (candidates[1]) return "yarn";
  if (candidates[2]) return "bun";
  return "npm";
}

async function discoverPackageScripts(cwd: string): Promise<ScriptCommand[]> {
  const contents = await readProjectFile(cwd, "package.json");
  if (!contents) return [];
  try {
    const manifest = recordValue(JSON.parse(contents));
    const scripts = recordValue(manifest?.scripts);
    if (!manifest || !scripts) return [];
    const runner = await packageRunner(cwd, manifest.packageManager);
    return Object.entries(scripts).flatMap(([name, value]) => {
      if (typeof value !== "string") return [];
      const command = discoveredCommand(
        "package",
        name,
        `${runner} run ${name}`,
        "package.json",
        value,
      );
      return command ? [command] : [];
    });
  } catch {
    return [];
  }
}

function stripYamlComment(value: string): string {
  let singleQuoted = false;
  let doubleQuoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "'" && !doubleQuoted) singleQuoted = !singleQuoted;
    if (
      character === '"' &&
      !singleQuoted &&
      (index === 0 || value[index - 1] !== "\\")
    ) {
      doubleQuoted = !doubleQuoted;
    }
    if (
      character === "#" &&
      !singleQuoted &&
      !doubleQuoted &&
      (index === 0 || /\s/u.test(value[index - 1] ?? ""))
    ) {
      return value.slice(0, index);
    }
  }
  return value;
}

function yamlScalar(value: string): string | null {
  const scalar = stripYamlComment(value).trim();
  if (!scalar || ["|", ">", "null", "~"].includes(scalar)) return null;
  if (scalar.startsWith("'") && scalar.endsWith("'")) {
    return scalar.slice(1, -1).replace(/''/gu, "'");
  }
  if (scalar.startsWith('"') && scalar.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(scalar);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  if (scalar.startsWith("{") || scalar.startsWith("[")) return null;
  return scalar;
}

function indentation(line: string): number {
  return /^ */u.exec(line)?.[0].length ?? 0;
}

function parsePubspecScripts(contents: string): ScriptCommand[] {
  const lines = contents.split(/\r?\n/u);
  const sectionIndex = lines.findIndex((line) =>
    /^scripts\s*:\s*(?:#.*)?$/u.test(line),
  );
  if (sectionIndex < 0) return [];

  const values = new Map<
    string,
    { command: string | null; description: string | null }
  >();
  let entryIndent: number | null = null;
  let currentName: string | null = null;
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = indentation(line);
    if (indent === 0) break;
    if (entryIndent === null) entryIndent = indent;
    const body = line.slice(indent);
    if (indent === entryIndent) {
      const entry = /^([A-Za-z0-9][A-Za-z0-9:_.-]{0,199})\s*:\s*(.*)$/u.exec(
        body,
      );
      if (!entry) {
        currentName = null;
        continue;
      }
      currentName = entry[1] ?? null;
      if (!currentName) continue;
      values.set(currentName, {
        command: yamlScalar(entry[2] ?? ""),
        description: null,
      });
      continue;
    }
    if (!currentName || indent <= entryIndent) continue;
    const nested = /^(run|command|description)\s*:\s*(.*)$/u.exec(body);
    if (!nested) continue;
    const scalar = yamlScalar(nested[2] ?? "");
    const current = values.get(currentName);
    if (!current || !scalar) continue;
    if (nested[1] === "description") current.description = scalar;
    else current.command = scalar;
  }

  return [...values.entries()].flatMap(([name, value]) => {
    if (!value.command) return [];
    const command = discoveredCommand(
      "dart",
      name,
      value.command,
      "pubspec.yaml",
      value.description,
    );
    return command ? [command] : [];
  });
}

async function discoverPubspecScripts(cwd: string): Promise<ScriptCommand[]> {
  const contents = await readProjectFile(cwd, "pubspec.yaml");
  return contents ? parsePubspecScripts(contents) : [];
}

function justHasRequiredParameters(parameters: string): boolean {
  if (!parameters.trim()) return false;
  return parameters
    .trim()
    .split(/\s+/u)
    .some(
      (parameter) => !parameter.includes("=") && !parameter.startsWith("*"),
    );
}

function parseJustfile(contents: string, source: string): ScriptCommand[] {
  const commands: ScriptCommand[] = [];
  let comments: string[] = [];
  let privateRecipe = false;
  for (const line of contents.split(/\r?\n/u)) {
    const comment = /^#\s?(.*)$/u.exec(line);
    if (comment) {
      comments.push(comment[1]?.trim() ?? "");
      continue;
    }
    if (/^\s*$/u.test(line)) {
      comments = [];
      privateRecipe = false;
      continue;
    }
    if (/^\[[^\]]*private[^\]]*\]\s*$/u.test(line)) {
      privateRecipe = true;
      continue;
    }
    const recipe = /^([A-Za-z0-9][A-Za-z0-9_-]*)([^:]*)\s*:(?!=)/u.exec(line);
    if (!recipe) {
      if (!/^\s/u.test(line)) comments = [];
      continue;
    }
    const name = recipe[1] ?? "";
    const parameters = recipe[2] ?? "";
    if (
      !privateRecipe &&
      !name.startsWith("_") &&
      !justHasRequiredParameters(parameters)
    ) {
      const command = discoveredCommand(
        "just",
        name,
        `just ${name}`,
        source,
        comments.filter(Boolean).join(" ") || null,
      );
      if (command) commands.push(command);
    }
    comments = [];
    privateRecipe = false;
  }
  return commands;
}

async function discoverJustRecipes(cwd: string): Promise<ScriptCommand[]> {
  for (const source of ["justfile", "Justfile", ".justfile"]) {
    const contents = await readProjectFile(cwd, source);
    if (contents) return parseJustfile(contents, source);
  }
  return [];
}

function parseTomlSection(
  contents: string,
  sectionName: string,
): Array<{ name: string; value: string }> {
  const values: Array<{ name: string; value: string }> = [];
  let active = false;
  for (const line of contents.split(/\r?\n/u)) {
    const section = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u.exec(line);
    if (section) {
      active = section[1]?.trim() === sectionName;
      continue;
    }
    if (!active) continue;
    const entry = /^\s*([A-Za-z0-9][A-Za-z0-9_.-]*)\s*=\s*(.+?)\s*$/u.exec(
      line,
    );
    if (entry?.[1] && entry[2]) {
      values.push({ name: entry[1], value: entry[2] });
    }
  }
  return values;
}

async function discoverCargoCommands(cwd: string): Promise<ScriptCommand[]> {
  const cargoManifest = await readProjectFile(cwd, "Cargo.toml");
  if (!cargoManifest) return [];
  const commands = [
    ["build", "cargo build", "Build the current Cargo package or workspace."],
    ["check", "cargo check", "Check the project without producing binaries."],
    ["test", "cargo test", "Run the Cargo test suite."],
    ["clippy", "cargo clippy", "Run the Rust linter."],
    ["fmt", "cargo fmt", "Format Rust sources."],
  ].flatMap(([name, invocation, description]) => {
    const command = discoveredCommand(
      "cargo",
      name!,
      invocation!,
      "Cargo.toml",
      description!,
    );
    return command ? [command] : [];
  });
  if (
    cargoManifest.includes("[[bin]]") ||
    (await projectFileExists(cwd, path.join("src", "main.rs")))
  ) {
    const run = discoveredCommand(
      "cargo",
      "run",
      "cargo run",
      "Cargo.toml",
      "Run the current Cargo binary.",
    );
    if (run) commands.push(run);
  }

  for (const source of [
    path.join(".cargo", "config.toml"),
    path.join(".cargo", "config"),
  ]) {
    const config = await readProjectFile(cwd, source);
    if (!config) continue;
    for (const alias of parseTomlSection(config, "alias")) {
      const command = discoveredCommand(
        "cargo",
        alias.name,
        `cargo ${alias.name}`,
        source,
        `Cargo alias: ${alias.value}`,
      );
      if (command) commands.push(command);
    }
    break;
  }
  return commands;
}

function parseGradleTaskNames(contents: string): string[] {
  const names = new Set<string>();
  const patterns = [
    /(?:^|\n)\s*task\s+([A-Za-z0-9][A-Za-z0-9_.-]*)/gu,
    /tasks\.(?:register|create)(?:<[^>]+>)?\s*\(\s*["']([A-Za-z0-9][A-Za-z0-9_.-]*)["']/gu,
    /(?:^|\n)\s*val\s+([A-Za-z0-9][A-Za-z0-9_.-]*)\s+by\s+tasks\.(?:registering|creating)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of contents.matchAll(pattern)) {
      if (match[1]) names.add(match[1]);
    }
  }
  return [...names];
}

async function discoverGradleCommands(
  cwd: string,
  platform: NodeJS.Platform,
): Promise<ScriptCommand[]> {
  const manifests = await Promise.all(
    ["build.gradle", "build.gradle.kts"].map(async (source) => ({
      contents: await readProjectFile(cwd, source),
      source,
    })),
  );
  const manifest = manifests.find(({ contents }) => contents !== null);
  if (!manifest?.contents) return [];
  const wrapper = platform === "win32" ? "gradlew.bat" : "gradlew";
  if (!(await projectFileExists(cwd, wrapper))) return [];
  const launcher = platform === "win32" ? "gradlew.bat" : "./gradlew";
  const names = new Set([
    "build",
    "test",
    "check",
    "clean",
    "assemble",
    ...parseGradleTaskNames(manifest.contents),
  ]);
  return [...names].flatMap((name) => {
    const command = discoveredCommand(
      "gradle",
      name,
      `${launcher} ${name}`,
      manifest.source,
      "Gradle task",
    );
    return command ? [command] : [];
  });
}

function parseMakeTargets(contents: string, source: string): ScriptCommand[] {
  const commands: ScriptCommand[] = [];
  let description: string | null = null;
  for (const line of contents.split(/\r?\n/u)) {
    const comment = /^##\s?(.*)$/u.exec(line);
    if (comment) {
      description = comment[1]?.trim() || null;
      continue;
    }
    if (/^\s/u.test(line) || !line.includes(":")) continue;
    const separator = line.indexOf(":");
    if (line[separator + 1] === "=") continue;
    const targets = line
      .slice(0, separator)
      .trim()
      .split(/\s+/u)
      .filter(
        (target) => SAFE_COMMAND_NAME.test(target) && !target.startsWith("."),
      );
    for (const name of targets) {
      const command = discoveredCommand(
        "make",
        name,
        `make ${name}`,
        source,
        description,
      );
      if (command) commands.push(command);
    }
    description = null;
  }
  return commands;
}

async function discoverMakeTargets(cwd: string): Promise<ScriptCommand[]> {
  for (const source of ["GNUmakefile", "Makefile", "makefile"]) {
    const contents = await readProjectFile(cwd, source);
    if (contents) return parseMakeTargets(contents, source);
  }
  return [];
}

export async function discoverScriptCommands(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): Promise<ScriptCommand[]> {
  const groups = await Promise.all([
    discoverPackageScripts(cwd),
    discoverPubspecScripts(cwd),
    discoverJustRecipes(cwd),
    discoverCargoCommands(cwd),
    discoverGradleCommands(cwd, platform),
    discoverMakeTargets(cwd),
  ]);
  const unique = new Map<string, ScriptCommand>();
  for (const command of groups.flat()) {
    if (!unique.has(command.command)) unique.set(command.command, command);
  }
  return scriptCommandListSchema.parse(
    [...unique.values()]
      .sort(
        (left, right) =>
          KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
          left.name.localeCompare(right.name) ||
          left.command.localeCompare(right.command),
      )
      .slice(0, 500),
  );
}
