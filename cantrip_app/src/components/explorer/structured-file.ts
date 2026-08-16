import {
  parse as parseToml,
  stringify as stringifyToml,
  TomlDate,
  TomlError,
} from "smol-toml";
import { parseDocument } from "yaml";

import type { StructuredFileFormat } from "./explorer-file-language";

export type StructuredPath = Array<string | number>;
export type StructuredScalar = null | boolean | number | bigint | string | Date;
export type StructuredValue =
  StructuredScalar | StructuredValue[] | { [key: string]: StructuredValue };

const MAX_VISUAL_NODES = 100_000;
const MAX_VISUAL_DEPTH = 100;
const MAX_TOML_TEMPLATE_KEY_REPAIRS = 1_000;
const TOML_BARE_KEY_ERROR =
  "only letter, numbers, dashes and underscores are allowed in keys";
const TOML_TEMPLATE_KEY = /^\$\{[A-Za-z_][A-Za-z0-9_.-]*\}/u;

function tomlSourceOffset(
  content: string,
  line: number,
  column: number,
): number | null {
  let offset = 0;
  for (let currentLine = 1; currentLine < line; currentLine += 1) {
    const lineEnding = /\r\n|\n|\r/gu;
    lineEnding.lastIndex = offset;
    const match = lineEnding.exec(content);
    if (!match) return null;
    offset = match.index + match[0].length;
  }

  const result = offset + column - 1;
  return result >= offset && result <= content.length ? result : null;
}

function quoteTomlTemplateKeyAtError(
  content: string,
  error: unknown,
): string | null {
  if (
    !(error instanceof TomlError) ||
    !error.message.includes(TOML_BARE_KEY_ERROR)
  ) {
    return null;
  }

  const offset = tomlSourceOffset(content, error.line, error.column);
  if (offset === null) return null;
  const placeholder = TOML_TEMPLATE_KEY.exec(content.slice(offset))?.[0];
  if (!placeholder) return null;

  return `${content.slice(0, offset)}${JSON.stringify(placeholder)}${content.slice(offset + placeholder.length)}`;
}

function parseTomlWithTemplateKeys(content: string): unknown {
  let source = content;
  for (let repairs = 0; repairs < MAX_TOML_TEMPLATE_KEY_REPAIRS; repairs += 1) {
    try {
      return parseToml(source);
    } catch (error) {
      const repaired = quoteTomlTemplateKeyAtError(source, error);
      if (repaired === null) throw error;
      source = repaired;
    }
  }

  return parseToml(source);
}

export function isStructuredCollection(
  value: StructuredValue,
): value is StructuredValue[] | { [key: string]: StructuredValue } {
  return (
    value !== null && typeof value === "object" && !(value instanceof Date)
  );
}

export function structuredEntries(
  value: StructuredValue,
): Array<[string | number, StructuredValue]> {
  if (Array.isArray(value)) return value.map((entry, index) => [index, entry]);
  return isStructuredCollection(value) ? Object.entries(value) : [];
}

function validateStructuredValue(
  value: unknown,
  ancestors: Set<object>,
  state: { nodes: number },
  depth = 0,
): asserts value is StructuredValue {
  state.nodes += 1;
  if (state.nodes > MAX_VISUAL_NODES) {
    throw new Error(
      `Visual mode is limited to ${MAX_VISUAL_NODES.toLocaleString()} values.`,
    );
  }
  if (depth > MAX_VISUAL_DEPTH) {
    throw new Error(`Visual mode is limited to ${MAX_VISUAL_DEPTH} levels.`);
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean" ||
    value instanceof Date
  ) {
    return;
  }
  if (typeof value !== "object" || value === undefined) {
    throw new Error(`Visual mode cannot display ${typeof value} values.`);
  }
  if (ancestors.has(value)) {
    throw new Error("Visual mode cannot display cyclic values.");
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      validateStructuredValue(entry, ancestors, state, depth + 1);
    }
  } else {
    for (const entry of Object.values(value)) {
      validateStructuredValue(entry, ancestors, state, depth + 1);
    }
  }
  ancestors.delete(value);
}

export function parseStructuredFile(
  content: string,
  format: StructuredFileFormat,
): StructuredValue {
  let parsed: unknown;
  if (format === "json") {
    parsed = JSON.parse(content);
  } else if (format === "toml") {
    parsed = parseTomlWithTemplateKeys(content);
  } else {
    const document = parseDocument(content);
    if (document.errors.length > 0) throw document.errors[0];
    parsed = document.toJS({ maxAliasCount: 100 });
  }
  validateStructuredValue(parsed, new Set(), { nodes: 0 });
  return parsed;
}

export function formatStructuredScalar(value: StructuredScalar): string {
  if (value === null) return "null";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function structuredScalarType(value: StructuredScalar): string {
  if (value === null) return "null";
  if (value instanceof Date) return "date";
  return typeof value === "bigint" ? "integer" : typeof value;
}

export function coerceStructuredScalar(
  input: string,
  current: StructuredScalar,
): StructuredScalar {
  if (current instanceof TomlDate) {
    const next = new TomlDate(input.trim());
    if (!next.isValid()) throw new Error("Enter a valid TOML date or time.");
    return next;
  }
  if (current instanceof Date) {
    const next = new Date(input.trim());
    if (Number.isNaN(next.valueOf())) throw new Error("Enter a valid date.");
    return next;
  }
  if (typeof current === "number") {
    const next = Number(input.trim());
    if (!input.trim() || !Number.isFinite(next)) {
      throw new Error("Enter a finite number.");
    }
    return next;
  }
  if (typeof current === "bigint") {
    try {
      return BigInt(input.trim());
    } catch {
      throw new Error("Enter an integer.");
    }
  }
  if (typeof current === "boolean") {
    return input.trim().toLowerCase() === "true";
  }
  if (current === null) {
    const normalized = input.trim();
    if (!normalized || normalized.toLowerCase() === "null") return null;
    if (normalized.toLowerCase() === "true") return true;
    if (normalized.toLowerCase() === "false") return false;
    const numeric = Number(normalized);
    return Number.isFinite(numeric) ? numeric : input;
  }
  return input;
}

export function updateStructuredValue(
  root: StructuredValue,
  path: StructuredPath,
  value: StructuredScalar,
): StructuredValue {
  if (path.length === 0) return value;
  const [segment, ...remaining] = path;
  if (Array.isArray(root) && typeof segment === "number") {
    if (segment < 0 || segment >= root.length) {
      throw new Error("The selected array value no longer exists.");
    }
    const next = [...root];
    next[segment] = updateStructuredValue(next[segment]!, remaining, value);
    return next;
  }
  if (
    isStructuredCollection(root) &&
    !Array.isArray(root) &&
    typeof segment === "string" &&
    Object.hasOwn(root, segment)
  ) {
    return {
      ...root,
      [segment]: updateStructuredValue(root[segment]!, remaining, value),
    };
  }
  throw new Error("The selected value no longer exists.");
}

function jsonIndent(content: string): string | number | undefined {
  const indentation = content.match(/\n([\t ]+)\S/u)?.[1];
  if (indentation?.includes("\t")) return "\t";
  if (indentation) return indentation.length;
  return content.includes("\n") ? 2 : undefined;
}

function preserveLineEndings(serialized: string, original: string): string {
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = original.endsWith("\n");
  const body = serialized
    .replace(/\r?\n/gu, newline)
    .replace(/(?:\r?\n)+$/u, "");
  return trailingNewline ? `${body}${newline}` : body;
}

export function updateStructuredFileContent(
  content: string,
  format: StructuredFileFormat,
  path: StructuredPath,
  value: StructuredScalar,
): string {
  if (format === "yaml") {
    const document = parseDocument(content);
    if (document.errors.length > 0) throw document.errors[0];
    document.setIn(path, value);
    return preserveLineEndings(document.toString({ lineWidth: 0 }), content);
  }

  const updated = updateStructuredValue(
    parseStructuredFile(content, format),
    path,
    value,
  );
  const serialized =
    format === "json"
      ? JSON.stringify(updated, null, jsonIndent(content))
      : stringifyToml(updated);
  return preserveLineEndings(serialized, content);
}

export function structuredValueMatches(
  value: StructuredValue,
  key: string | number,
  path: StructuredPath,
  query: string,
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  if (structuredEntryOwnMatches(value, key, path, normalized)) return true;
  return structuredEntries(value).some(([childKey, child]) =>
    structuredValueMatches(child, childKey, [...path, childKey], normalized),
  );
}

export function structuredEntryOwnMatches(
  value: StructuredValue,
  key: string | number,
  path: StructuredPath,
  query: string,
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const pathLabel = path.map(String).join(".");
  const ownText = isStructuredCollection(value)
    ? `${String(key)} ${pathLabel}`
    : `${String(key)} ${pathLabel} ${formatStructuredScalar(value)} ${structuredScalarType(value)}`;
  return ownText.toLowerCase().includes(normalized);
}

export function countStructuredScalarValues(value: StructuredValue): number {
  if (!isStructuredCollection(value)) return 1;
  return structuredEntries(value).reduce(
    (count, [, child]) => count + countStructuredScalarValues(child),
    0,
  );
}

export function countStructuredSearchMatches(
  value: StructuredValue,
  query: string,
): number {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return countStructuredScalarValues(value);

  const countEntry = (
    entry: StructuredValue,
    key: string | number,
    path: StructuredPath,
    ancestorMatches: boolean,
  ): number => {
    const ownMatches = structuredEntryOwnMatches(entry, key, path, normalized);
    if (!isStructuredCollection(entry)) {
      return ancestorMatches || ownMatches ? 1 : 0;
    }
    return structuredEntries(entry).reduce(
      (count, [childKey, child]) =>
        count +
        countEntry(
          child,
          childKey,
          [...path, childKey],
          ancestorMatches || ownMatches,
        ),
      0,
    );
  };

  return structuredEntries(value).reduce(
    (count, [key, entry]) => count + countEntry(entry, key, [key], false),
    isStructuredCollection(value)
      ? 0
      : structuredEntryOwnMatches(value, "Value", [], normalized)
        ? 1
        : 0,
  );
}
