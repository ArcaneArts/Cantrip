import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  isManagedMcpName,
  mcpServerConfigurationSchema,
  mcpServerDiscoveryResultSchema,
  type McpServerConfiguration,
  type McpServerDiscoveryIssue,
  type McpServerDiscoveryResult,
  type McpServerDiscoveryScope,
  type McpServerDiscoverySource,
} from "@cantrip/protocol";
import { parse as parseToml } from "smol-toml";

import { protectDiscoveredMcpServer } from "../protected-secrets.js";
import type { WorkerEncryptionService } from "../worker-encryption.js";

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_CANDIDATES = 200;

type PlainCandidate = {
  source: McpServerDiscoverySource;
  sourceScope: McpServerDiscoveryScope;
  configuration: McpServerConfiguration;
};

type ParseResult =
  | { configuration: McpServerConfiguration }
  | { code: McpServerDiscoveryIssue["code"]; message: string };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringMap(value: unknown): Record<string, string> | null {
  const input = record(value);
  if (!input) return value === undefined ? {} : null;
  const entries = Object.entries(input);
  if (entries.some(([, item]) => typeof item !== "string")) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

function stringList(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return null;
  }
  return value as string[];
}

function invalid(message: string): ParseResult {
  return { code: "invalid-config", message };
}

function unsupported(message: string): ParseResult {
  return { code: "unsupported-transport", message };
}

function parseCodexServer(name: string, raw: unknown): ParseResult {
  const value = record(raw);
  if (!value) return invalid("An MCP entry is not a server object.");
  if (typeof value.command === "string") {
    const args = stringList(value.args);
    const environment = stringMap(value.env);
    if (!args || !environment) {
      return invalid(
        "An MCP entry has invalid stdio arguments or environment.",
      );
    }
    return {
      configuration: mcpServerConfigurationSchema.parse({
        name,
        enabled: true,
        transport: "stdio",
        command: value.command,
        args,
        environment,
      }),
    };
  }
  if (typeof value.url === "string") {
    const headers = stringMap(value.http_headers);
    const environmentHeaders = stringMap(value.env_http_headers);
    if (!headers || !environmentHeaders) {
      return invalid("An MCP entry has invalid HTTP headers.");
    }
    return {
      configuration: mcpServerConfigurationSchema.parse({
        name,
        enabled: true,
        transport: "http",
        url: value.url,
        bearerTokenEnvironmentVariable:
          typeof value.bearer_token_env_var === "string"
            ? value.bearer_token_env_var
            : null,
        headers,
        environmentHeaders,
      }),
    };
  }
  return unsupported(
    "An MCP entry does not use a supported stdio or HTTP transport.",
  );
}

const CLAUDE_ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/gu;

function expandClaudeValue(value: string): string {
  return value.replace(
    CLAUDE_ENV_REFERENCE,
    (_match, name: string, fallback: string | undefined) => {
      const resolved = process.env[name];
      if (resolved !== undefined && resolved !== "") return resolved;
      if (fallback !== undefined) return fallback;
      throw new Error("A required environment variable is unavailable.");
    },
  );
}

function expandedMap(value: unknown): Record<string, string> | null {
  const mapped = stringMap(value);
  if (!mapped) return null;
  return Object.fromEntries(
    Object.entries(mapped).map(([key, item]) => [key, expandClaudeValue(item)]),
  );
}

function parseClaudeServer(name: string, raw: unknown): ParseResult {
  const value = record(raw);
  if (!value) return invalid("An MCP entry is not a server object.");
  const type = typeof value.type === "string" ? value.type : null;
  try {
    if (
      (type === null || type === "stdio") &&
      typeof value.command === "string"
    ) {
      const args = stringList(value.args);
      const environment = expandedMap(value.env);
      if (!args || !environment) {
        return invalid(
          "An MCP entry has invalid stdio arguments or environment.",
        );
      }
      return {
        configuration: mcpServerConfigurationSchema.parse({
          name,
          enabled: true,
          transport: "stdio",
          command: expandClaudeValue(value.command),
          args: args.map(expandClaudeValue),
          environment,
        }),
      };
    }
    if (
      (type === "http" || type === "streamable-http" || type === null) &&
      typeof value.url === "string"
    ) {
      const headers = expandedMap(value.headers);
      if (!headers) return invalid("An MCP entry has invalid HTTP headers.");
      return {
        configuration: mcpServerConfigurationSchema.parse({
          name,
          enabled: true,
          transport: "http",
          url: expandClaudeValue(value.url),
          bearerTokenEnvironmentVariable: null,
          headers,
          environmentHeaders: {},
        }),
      };
    }
  } catch (error) {
    return invalid(
      error instanceof Error ? error.message : "An MCP entry is invalid.",
    );
  }
  return unsupported(
    "An MCP entry does not use a supported stdio or HTTP transport.",
  );
}

async function readBounded(filePath: string): Promise<string | null> {
  try {
    const details = await stat(filePath);
    if (!details.isFile() || details.size > MAX_CONFIG_BYTES) return null;
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return null;
    }
    throw error;
  }
}

function collectServers(input: {
  rawServers: unknown;
  source: McpServerDiscoverySource;
  sourceScope: McpServerDiscoveryScope;
  parse(name: string, raw: unknown): ParseResult;
  candidates: PlainCandidate[];
  issues: McpServerDiscoveryIssue[];
}): void {
  const servers = record(input.rawServers);
  if (!servers) return;
  for (const [name, raw] of Object.entries(servers)) {
    if (input.candidates.length >= MAX_CANDIDATES) return;
    if (isManagedMcpName(name)) continue;
    let parsed: ParseResult;
    try {
      parsed = input.parse(name, raw);
    } catch {
      parsed = invalid("An MCP entry is not a valid importable configuration.");
    }
    if ("configuration" in parsed) {
      input.candidates.push({
        source: input.source,
        sourceScope: input.sourceScope,
        configuration: parsed.configuration,
      });
    } else {
      input.issues.push({
        source: input.source,
        sourceScope: input.sourceScope,
        code: parsed.code,
        message: parsed.message,
      });
    }
  }
}

async function collectCodexFile(input: {
  filePath: string;
  sourceScope: McpServerDiscoveryScope;
  candidates: PlainCandidate[];
  issues: McpServerDiscoveryIssue[];
}): Promise<void> {
  let content: string | null;
  try {
    content = await readBounded(input.filePath);
  } catch {
    input.issues.push({
      source: "codex",
      sourceScope: input.sourceScope,
      code: "invalid-config",
      message: "A Codex MCP config file could not be read.",
    });
    return;
  }
  if (content === null) return;
  try {
    const parsed = record(parseToml(content));
    collectServers({
      rawServers: parsed?.mcp_servers,
      source: "codex",
      sourceScope: input.sourceScope,
      parse: parseCodexServer,
      candidates: input.candidates,
      issues: input.issues,
    });
  } catch {
    input.issues.push({
      source: "codex",
      sourceScope: input.sourceScope,
      code: "invalid-config",
      message: "A Codex MCP config file could not be parsed.",
    });
  }
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  return record(JSON.parse(content));
}

async function collectClaudeFile(input: {
  filePath: string;
  sourceScope: McpServerDiscoveryScope;
  candidates: PlainCandidate[];
  issues: McpServerDiscoveryIssue[];
}): Promise<Record<string, unknown> | null> {
  let content: string | null;
  try {
    content = await readBounded(input.filePath);
  } catch {
    input.issues.push({
      source: "claude",
      sourceScope: input.sourceScope,
      code: "invalid-config",
      message: "A Claude Code MCP config file could not be read.",
    });
    return null;
  }
  if (content === null) return null;
  try {
    const parsed = parseJsonObject(content);
    collectServers({
      rawServers: parsed?.mcpServers,
      source: "claude",
      sourceScope: input.sourceScope,
      parse: parseClaudeServer,
      candidates: input.candidates,
      issues: input.issues,
    });
    return parsed;
  } catch {
    input.issues.push({
      source: "claude",
      sourceScope: input.sourceScope,
      code: "invalid-config",
      message: "A Claude Code MCP config file could not be parsed.",
    });
    return null;
  }
}

export async function discoverMcpConfigurations(input: {
  workerId: string;
  projectRoot: string | null;
  service: WorkerEncryptionService;
  homeDirectory?: string;
}): Promise<McpServerDiscoveryResult> {
  const candidates: PlainCandidate[] = [];
  const issues: McpServerDiscoveryIssue[] = [];
  const home = input.homeDirectory ?? os.homedir();
  await collectCodexFile({
    filePath: path.join(home, ".codex", "config.toml"),
    sourceScope: "user",
    candidates,
    issues,
  });
  const claudeUser = await collectClaudeFile({
    filePath: path.join(home, ".claude.json"),
    sourceScope: "user",
    candidates,
    issues,
  });

  if (input.projectRoot) {
    const projectRoot = path.resolve(input.projectRoot);
    await collectCodexFile({
      filePath: path.join(projectRoot, ".codex", "config.toml"),
      sourceScope: "project",
      candidates,
      issues,
    });
    await collectClaudeFile({
      filePath: path.join(projectRoot, ".mcp.json"),
      sourceScope: "project",
      candidates,
      issues,
    });
    const projects = record(claudeUser?.projects);
    const matchingProject = projects
      ? Object.entries(projects).find(([configuredPath]) => {
          try {
            return path.resolve(configuredPath) === projectRoot;
          } catch {
            return false;
          }
        })?.[1]
      : null;
    collectServers({
      rawServers: record(matchingProject)?.mcpServers,
      source: "claude",
      sourceScope: "project",
      parse: parseClaudeServer,
      candidates,
      issues,
    });
  }

  const protectedCandidates = await Promise.all(
    candidates.map(async (candidate) => ({
      source: candidate.source,
      sourceScope: candidate.sourceScope,
      configuration: await protectDiscoveredMcpServer({
        configuration: candidate.configuration,
        workerId: input.workerId,
        service: input.service,
      }),
    })),
  );
  return mcpServerDiscoveryResultSchema.parse({
    workerId: input.workerId,
    observedAt: new Date().toISOString(),
    candidates: protectedCandidates,
    issues,
  });
}
