import type { TabularFileFormat } from "./explorer-file-language";

const MAX_CSV_CELLS = 250_000;

export interface CsvDocument {
  bom: string;
  headers: string[];
  newline: "\n" | "\r\n";
  rawHeader: string;
  rows: string[][];
  trailingNewline: boolean;
}

export interface PropertyEntry {
  end: number;
  key: string;
  start: number;
  value: string;
}

interface SourceLine {
  content: string;
  end: number;
  start: number;
}

interface ParsedPropertyEntry extends PropertyEntry {
  exportPrefix: string;
  prefix: string;
  quote: '"' | "'" | null;
  rawKey: string;
  rawValue: string;
  separator: string;
  suffix: string;
}

export interface PropertyDocument {
  entries: PropertyEntry[];
  format: Exclude<TabularFileFormat, "csv">;
}

function sourceNewline(content: string): "\n" | "\r\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function csvCell(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function serializeCsv(document: CsvDocument): string {
  const rows = document.rows
    .map((record) => record.map(csvCell).join(","))
    .join(document.newline);
  const body = rows
    ? `${document.rawHeader}${document.newline}${rows}`
    : document.rawHeader;
  return `${document.bom}${body}${document.trailingNewline ? document.newline : ""}`;
}

export function parseCsvFile(content: string): CsvDocument {
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const source = bom ? content.slice(1) : content;
  if (!source) {
    throw new Error("CSV Visual mode needs a header row.");
  }

  const records: string[][] = [];
  const rawRecords: string[] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let index = 0;
  let recordStart = 0;
  let cells = 0;
  let endedWithNewline = false;

  const pushField = () => {
    record.push(field);
    field = "";
    cells += 1;
    if (cells > MAX_CSV_CELLS) {
      throw new Error(
        `CSV Visual mode is limited to ${MAX_CSV_CELLS.toLocaleString()} cells.`,
      );
    }
  };
  const pushRecord = () => {
    pushField();
    records.push(record);
    record = [];
  };

  while (index < source.length) {
    const character = source[index]!;
    if (inQuotes) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += character;
      index += 1;
      continue;
    }

    if (character === '"') {
      if (field) {
        throw new Error("CSV contains a quote inside an unquoted field.");
      }
      inQuotes = true;
      index += 1;
      continue;
    }
    if (character === ",") {
      pushField();
      endedWithNewline = false;
      index += 1;
      continue;
    }
    if (character === "\n" || character === "\r") {
      rawRecords.push(source.slice(recordStart, index));
      pushRecord();
      endedWithNewline = true;
      index += character === "\r" && source[index + 1] === "\n" ? 2 : 1;
      recordStart = index;
      continue;
    }
    field += character;
    endedWithNewline = false;
    index += 1;
  }

  if (inQuotes) throw new Error("CSV contains an unterminated quoted field.");
  if (!endedWithNewline) {
    rawRecords.push(source.slice(recordStart));
    pushRecord();
  }
  const headers = records.shift();
  const rawHeader = rawRecords.shift();
  if (!headers || rawHeader === undefined) {
    throw new Error("CSV Visual mode needs a header row.");
  }

  const mismatchedRow = records.findIndex(
    (current) => current.length !== headers.length,
  );
  if (mismatchedRow >= 0) {
    throw new Error(
      `CSV row ${mismatchedRow + 2} has ${records[mismatchedRow]!.length} columns; the header has ${headers.length}. Switch to Edit to repair its structure.`,
    );
  }

  return {
    bom,
    headers,
    newline: sourceNewline(source),
    rawHeader,
    rows: records,
    trailingNewline: endedWithNewline,
  };
}

export function updateCsvCell(
  content: string,
  rowIndex: number,
  columnIndex: number,
  value: string,
): string {
  const document = parseCsvFile(content);
  const row = document.rows[rowIndex];
  if (!row || columnIndex < 0 || columnIndex >= document.headers.length) {
    throw new Error("The selected CSV cell no longer exists.");
  }
  const rows = document.rows.map((current, index) =>
    index === rowIndex
      ? current.map((cell, cellIndex) =>
          cellIndex === columnIndex ? value : cell,
        )
      : current,
  );
  return serializeCsv({ ...document, rows });
}

function splitSourceLines(content: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf("\n", start);
    const fullEnd = newline < 0 ? content.length : newline;
    const end =
      fullEnd > start && content[fullEnd - 1] === "\r" ? fullEnd - 1 : fullEnd;
    lines.push({ content: content.slice(start, end), end, start });
    start = newline < 0 ? content.length : newline + 1;
  }
  return lines;
}

function hasContinuation(line: string): boolean {
  let slashes = 0;
  for (
    let index = line.length - 1;
    index >= 0 && line[index] === "\\";
    index -= 1
  ) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function unescapeProperty(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character !== "\\" || index === value.length - 1) {
      result += character;
      continue;
    }
    const escaped = value[++index]!;
    if (escaped === "t") result += "\t";
    else if (escaped === "n") result += "\n";
    else if (escaped === "r") result += "\r";
    else if (escaped === "f") result += "\f";
    else if (escaped === "u") {
      const hex = value.slice(index + 1, index + 5);
      if (/^[\dA-Fa-f]{4}$/u.test(hex)) {
        result += String.fromCharCode(Number.parseInt(hex, 16));
        index += 4;
      } else {
        result += "u";
      }
    } else result += escaped;
  }
  return result;
}

function escapePropertyKey(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\t", "\\t")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\f", "\\f")
    .replace(/[ :=#!]/gu, "\\$&");
}

function escapePropertyValue(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\t", "\\t")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\f", "\\f")
    .replace(/^ +/u, (spaces) => spaces.replaceAll(" ", "\\ "));
}

function parseProperties(content: string): ParsedPropertyEntry[] {
  const lines = splitSourceLines(content);
  const entries: ParsedPropertyEntry[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const first = lines[lineIndex]!;
    if (!first.content.trim() || /^[ \t\f]*[#!]/u.test(first.content)) continue;

    let logical = first.content;
    let last = first;
    while (hasContinuation(logical) && lineIndex + 1 < lines.length) {
      logical = `${logical.slice(0, -1)}${lines[++lineIndex]!.content.trimStart()}`;
      last = lines[lineIndex]!;
    }

    const keyStart = logical.search(/[^ \t\f]/u);
    if (keyStart < 0) continue;
    let keyEnd = keyStart;
    let escaped = false;
    while (keyEnd < logical.length) {
      const character = logical[keyEnd]!;
      if (
        !escaped &&
        (character === "=" || character === ":" || /[ \t\f]/u.test(character))
      )
        break;
      if (character === "\\" && !escaped) escaped = true;
      else escaped = false;
      keyEnd += 1;
    }
    let valueStart = keyEnd;
    while (/[ \t\f]/u.test(logical[valueStart] ?? "")) valueStart += 1;
    if (logical[valueStart] === "=" || logical[valueStart] === ":")
      valueStart += 1;
    while (/[ \t\f]/u.test(logical[valueStart] ?? "")) valueStart += 1;

    const rawKey = logical.slice(keyStart, keyEnd);
    const rawValue = logical.slice(valueStart);
    entries.push({
      end: last.end,
      exportPrefix: "",
      key: unescapeProperty(rawKey),
      prefix: logical.slice(0, keyStart),
      quote: null,
      rawKey,
      rawValue,
      separator: logical.slice(keyEnd, valueStart) || "=",
      start: first.start,
      suffix: "",
      value: unescapeProperty(rawValue),
    });
  }
  return entries;
}

function decodeEnvValue(raw: string, quote: '"' | "'" | null): string {
  if (quote === "'") return raw;
  if (quote === '"') {
    return raw.replace(/\\([\\"nrt])/gu, (_match, character: string) => {
      if (character === "n") return "\n";
      if (character === "r") return "\r";
      if (character === "t") return "\t";
      return character;
    });
  }
  return raw;
}

function parseEnv(content: string): ParsedPropertyEntry[] {
  const entries: ParsedPropertyEntry[] = [];
  for (const line of splitSourceLines(content)) {
    if (!line.content.trim() || /^\s*#/u.test(line.content)) continue;
    const match =
      /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/u.exec(
        line.content,
      );
    if (!match) continue;
    const [
      ,
      prefix = "",
      exportPrefix = "",
      rawKey = "",
      separator = "=",
      remainder = "",
    ] = match;
    let quote: '"' | "'" | null = null;
    let rawValue = remainder;
    let suffix = "";
    if (remainder.startsWith('"') || remainder.startsWith("'")) {
      quote = remainder[0] as '"' | "'";
      let closing = -1;
      for (let index = 1; index < remainder.length; index += 1) {
        if (
          remainder[index] === quote &&
          (quote === "'" || remainder[index - 1] !== "\\")
        ) {
          closing = index;
          break;
        }
      }
      if (closing >= 0) {
        rawValue = remainder.slice(1, closing);
        suffix = remainder.slice(closing + 1);
      }
    } else {
      const comment = /\s+#/u.exec(remainder);
      if (comment?.index !== undefined) {
        rawValue = remainder.slice(0, comment.index).trimEnd();
        suffix = remainder.slice(comment.index);
      }
    }
    entries.push({
      end: line.end,
      exportPrefix,
      key: rawKey,
      prefix,
      quote,
      rawKey,
      rawValue,
      separator,
      start: line.start,
      suffix,
      value: decodeEnvValue(rawValue, quote),
    });
  }
  return entries;
}

function parsedPropertyEntries(
  content: string,
  format: Exclude<TabularFileFormat, "csv">,
): ParsedPropertyEntry[] {
  return format === "env" ? parseEnv(content) : parseProperties(content);
}

export function parsePropertyFile(
  content: string,
  format: Exclude<TabularFileFormat, "csv">,
): PropertyDocument {
  return { entries: parsedPropertyEntries(content, format), format };
}

function validPropertyKey(
  key: string,
  format: Exclude<TabularFileFormat, "csv">,
): boolean {
  return format === "env"
    ? /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)
    : Boolean(key.trim());
}

function envValue(value: string, preferredQuote: '"' | "'" | null): string {
  let quote = preferredQuote;
  if (quote === "'" && value.includes("'")) quote = '"';
  if (!quote && /[\s#"']/u.test(value)) quote = '"';
  if (quote === "'") return `'${value}'`;
  if (quote === '"') {
    return `"${value
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("\n", "\\n")
      .replaceAll("\r", "\\r")
      .replaceAll("\t", "\\t")}"`;
  }
  return value;
}

export function updatePropertyEntry(
  content: string,
  format: Exclude<TabularFileFormat, "csv">,
  entryIndex: number,
  field: "key" | "value",
  value: string,
): string {
  const entries = parsedPropertyEntries(content, format);
  const entry = entries[entryIndex];
  if (!entry) throw new Error("The selected property no longer exists.");
  if (field === "key" && !validPropertyKey(value, format)) {
    throw new Error(
      format === "env"
        ? "Environment variable names must start with a letter or underscore and contain only letters, numbers, and underscores."
        : "Property names cannot be empty.",
    );
  }

  let rendered: string;
  if (format === "env") {
    const key = field === "key" ? value : entry.rawKey;
    const nextValue =
      field === "value"
        ? envValue(value, entry.quote)
        : `${entry.quote ?? ""}${entry.rawValue}${entry.quote ?? ""}`;
    rendered = `${entry.prefix}${entry.exportPrefix}${key}${entry.separator}${nextValue}${entry.suffix}`;
  } else {
    const key = field === "key" ? escapePropertyKey(value) : entry.rawKey;
    const nextValue =
      field === "value" ? escapePropertyValue(value) : entry.rawValue;
    rendered = `${entry.prefix}${key}${entry.separator}${nextValue}`;
  }
  return `${content.slice(0, entry.start)}${rendered}${content.slice(entry.end)}`;
}

export function appendPropertyEntry(
  content: string,
  format: Exclude<TabularFileFormat, "csv">,
  key: string,
  value: string,
): string {
  if (!validPropertyKey(key, format)) {
    throw new Error(
      format === "env"
        ? "Enter a valid environment variable name."
        : "Enter a property name.",
    );
  }
  const entries = parsedPropertyEntries(content, format);
  if (entries.some((entry) => entry.key === key)) {
    throw new Error(`“${key}” already exists.`);
  }
  const line =
    format === "env"
      ? `${key}=${envValue(value, null)}`
      : `${escapePropertyKey(key)}=${escapePropertyValue(value)}`;
  if (!content) return line;
  const newline = sourceNewline(content);
  return content.endsWith("\n")
    ? `${content}${line}${newline}`
    : `${content}${newline}${line}`;
}
