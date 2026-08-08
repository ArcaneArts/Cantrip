import { createHash } from "node:crypto";
import path from "node:path";

import {
  codexCustomizationCapabilitiesSchema,
  codexCustomizationInventorySchema,
  codexExternalImportPreviewSchema,
  codexMcpServerSchema,
  codexMcpResourceReadSchema,
  type CodexCustomizationCapabilities,
  type CodexCustomizationInventory,
  type CodexExternalImportPreview,
  type CodexMcpResourceRead,
  type CodexRuntimeReport,
  type CustomizationCapability,
} from "@cantrip/protocol";

import {
  CODEX_CUSTOMIZATION_METHODS,
  codexFeatureUsable,
  codexMethodsAvailable,
} from "./discovery.js";

const MCP_RESOURCE_CONTENT_LIMIT = 5_000_000;
const PLUGIN_STABILITY_REASON =
  "The installed App Server exposes plugin methods, but the official API contract still marks them under development and unsuitable for production clients.";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value === "bigint") {
    return Number(value > BigInt(Number.MAX_SAFE_INTEGER) ? 0n : value);
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function capability(
  available: boolean,
  reason: string,
  stability: CustomizationCapability["stability"] = "stable",
): CustomizationCapability {
  return {
    available,
    reason: available ? null : reason,
    stability,
  };
}

function methodCapability(
  report: CodexRuntimeReport,
  method: string,
  stability: CustomizationCapability["stability"] = "stable",
): CustomizationCapability {
  return capability(
    codexMethodsAvailable(report, [method]),
    `The installed Codex runtime does not advertise ${method}.`,
    stability,
  );
}

function featureCapability(
  report: CodexRuntimeReport,
  feature: string,
  methods: readonly string[],
  stability: CustomizationCapability["stability"] = "stable",
): CustomizationCapability {
  const featureAvailable = codexFeatureUsable(report, feature);
  const methodsAvailable = codexMethodsAvailable(report, methods);
  return capability(
    featureAvailable && methodsAvailable,
    !featureAvailable
      ? `The installed Codex runtime does not enable the ${feature} feature.`
      : `The installed Codex runtime is missing one or more ${feature} App Server methods.`,
    stability,
  );
}

export function customizationCapabilities(
  report: CodexRuntimeReport,
): CodexCustomizationCapabilities {
  const pluginsUnavailable = capability(
    false,
    PLUGIN_STABILITY_REASON,
    "unsupported",
  );
  return codexCustomizationCapabilitiesSchema.parse({
    isolatedCodexHome: true,
    collaborationModes: methodCapability(
      report,
      "collaborationMode/list",
      "experimental",
    ),
    threadGoals: featureCapability(
      report,
      "goals",
      CODEX_CUSTOMIZATION_METHODS.goals,
    ),
    nativeSubagents: capability(
      codexFeatureUsable(report, "multi_agent"),
      "The installed Codex runtime does not enable native multi-agent support.",
    ),
    customAgents: capability(
      false,
      "This Codex App Server version has no project or personal custom-agent discovery method; native subagents remain available independently.",
      "unsupported",
    ),
    hooks: featureCapability(
      report,
      "hooks",
      CODEX_CUSTOMIZATION_METHODS.hooks,
    ),
    skills: {
      list: methodCapability(report, "skills/list"),
      configure: methodCapability(report, "skills/config/write"),
      extraRoots: methodCapability(report, "skills/extraRoots/set"),
    },
    mcp: {
      status: methodCapability(report, "mcpServerStatus/list"),
      resourceRead: methodCapability(report, "mcpServer/resource/read"),
      oauth: methodCapability(report, "mcpServer/oauth/login"),
      reload: methodCapability(report, "config/mcpServer/reload"),
    },
    plugins: {
      list: pluginsUnavailable,
      read: pluginsUnavailable,
      install: pluginsUnavailable,
      uninstall: pluginsUnavailable,
    },
    externalImports: {
      detect: methodCapability(
        report,
        "externalAgentConfig/detect",
        "experimental",
      ),
      apply: methodCapability(
        report,
        "externalAgentConfig/import",
        "experimental",
      ),
    },
  });
}

function responseGroup(response: unknown, cwd: string): UnknownRecord | null {
  const data = record(response)?.data;
  if (!Array.isArray(data)) return null;
  const requestedCwd = path.resolve(cwd);
  return (
    data.map(record).find((candidate) => {
      const candidateCwd = candidate ? string(candidate.cwd) : null;
      return candidateCwd && path.resolve(candidateCwd) === requestedCwd;
    }) ?? null
  );
}

export function parseSkillInventory(response: unknown, cwd: string) {
  const group = responseGroup(response, cwd);
  const items = Array.isArray(group?.skills)
    ? group.skills.flatMap((value) => {
        const skill = record(value);
        const name = skill ? string(skill.name)?.trim() : null;
        const skillPath = skill ? string(skill.path) : null;
        const scope = skill ? string(skill.scope) : null;
        if (
          !skill ||
          !name ||
          !skillPath ||
          !["user", "repo", "system", "admin"].includes(scope ?? "")
        ) {
          return [];
        }
        const skillInterface = record(skill.interface);
        return [
          {
            name,
            description: string(skill.description) ?? "",
            displayName: optionalString(skillInterface?.displayName),
            path: skillPath,
            scope,
            enabled: skill.enabled !== false,
          },
        ];
      })
    : [];
  const errors = Array.isArray(group?.errors)
    ? group.errors.flatMap((value) => {
        const error = record(value);
        const message = error ? string(error.message) : null;
        if (!error || !message) return [];
        return [{ path: string(error.path) ?? "", message }];
      })
    : [];
  return {
    items: items.sort((left, right) =>
      (left.displayName ?? left.name).localeCompare(
        right.displayName ?? right.name,
      ),
    ),
    errors,
  };
}

export function parseHookInventory(response: unknown, cwd: string) {
  const group = responseGroup(response, cwd);
  const items = Array.isArray(group?.hooks)
    ? group.hooks.flatMap((value) => {
        const hook = record(value);
        const key = hook ? string(hook.key) : null;
        const eventName = hook ? string(hook.eventName) : null;
        const handlerType = hook ? string(hook.handlerType) : null;
        const sourcePath = hook ? string(hook.sourcePath) : null;
        const source = hook ? string(hook.source) : null;
        const trust = hook ? string(hook.trustStatus) : null;
        if (!hook || !key || !eventName || !handlerType || !sourcePath)
          return [];
        const effectiveTrust = trust ?? "untrusted";
        return [
          {
            key,
            eventName,
            handlerType,
            matcher: optionalString(hook.matcher),
            command: ["managed", "trusted"].includes(effectiveTrust)
              ? optionalString(hook.command)
              : null,
            timeoutSeconds: nonNegativeInteger(hook.timeoutSec),
            statusMessage: optionalString(hook.statusMessage),
            sourcePath,
            source: source ?? "unknown",
            pluginId: optionalString(hook.pluginId),
            enabled: hook.enabled === true,
            managed: hook.isManaged === true,
            trust: effectiveTrust,
          },
        ];
      })
    : [];
  const warnings = Array.isArray(group?.warnings)
    ? group.warnings.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const errors = Array.isArray(group?.errors)
    ? group.errors.flatMap((value) => {
        const error = record(value);
        const message = error ? string(error.message) : null;
        if (!error || !message) return [];
        return [{ path: string(error.path) ?? "", message }];
      })
    : [];
  return { items, warnings, errors };
}

export function parseMcpServerPage(response: unknown) {
  const root = record(response);
  const data = Array.isArray(root?.data) ? root.data : [];
  const servers = data.flatMap((value) => {
    const server = record(value);
    const name = server ? string(server.name) : null;
    if (!server || !name) return [];
    const serverInfo = record(server.serverInfo);
    const tools = record(server.tools);
    return [
      codexMcpServerSchema.parse({
        name,
        serverInfo:
          serverInfo && string(serverInfo.name)
            ? {
                name: string(serverInfo.name),
                title: optionalString(serverInfo.title),
                version: string(serverInfo.version) ?? "",
                description: optionalString(serverInfo.description),
                websiteUrl: optionalString(serverInfo.websiteUrl),
              }
            : null,
        authStatus: string(server.authStatus) ?? "unsupported",
        tools: tools
          ? Object.values(tools).flatMap((value) => {
              const tool = record(value);
              const toolName = tool ? string(tool.name) : null;
              if (!tool || !toolName) return [];
              return [
                {
                  name: toolName,
                  title: optionalString(tool.title),
                  description: optionalString(tool.description),
                  inputSchema: tool.inputSchema ?? {},
                  outputSchema: tool.outputSchema ?? null,
                },
              ];
            })
          : [],
        resources: Array.isArray(server.resources)
          ? server.resources.flatMap((value) => {
              const resource = record(value);
              const uri = resource ? string(resource.uri) : null;
              const resourceName = resource ? string(resource.name) : null;
              if (!resource || !uri || !resourceName) return [];
              return [
                {
                  uri,
                  name: resourceName,
                  title: optionalString(resource.title),
                  description: optionalString(resource.description),
                  mimeType: optionalString(resource.mimeType),
                  size:
                    typeof resource.size === "number" &&
                    Number.isSafeInteger(resource.size) &&
                    resource.size >= 0
                      ? resource.size
                      : null,
                },
              ];
            })
          : [],
        resourceTemplates: Array.isArray(server.resourceTemplates)
          ? server.resourceTemplates.flatMap((value) => {
              const template = record(value);
              const uriTemplate = template
                ? string(template.uriTemplate)
                : null;
              const templateName = template ? string(template.name) : null;
              if (!template || !uriTemplate || !templateName) return [];
              return [
                {
                  uriTemplate,
                  name: templateName,
                  title: optionalString(template.title),
                  description: optionalString(template.description),
                  mimeType: optionalString(template.mimeType),
                },
              ];
            })
          : [],
      }),
    ];
  });
  return {
    servers,
    nextCursor: string(root?.nextCursor),
  };
}

export function customizationInventory(input: {
  report: CodexRuntimeReport;
  cwd: string;
  skillsResponse: unknown;
  hooksResponse: unknown;
  mcpServers: unknown[];
}): CodexCustomizationInventory {
  return codexCustomizationInventorySchema.parse({
    capabilities: customizationCapabilities(input.report),
    skills: parseSkillInventory(input.skillsResponse, input.cwd),
    hooks: parseHookInventory(input.hooksResponse, input.cwd),
    mcpServers: input.mcpServers,
  });
}

const externalItemTypes = new Set([
  "AGENTS_MD",
  "CONFIG",
  "SKILLS",
  "PLUGINS",
  "MCP_SERVER_CONFIG",
  "SUBAGENTS",
  "HOOKS",
  "COMMANDS",
  "MEMORY",
  "SESSIONS",
]);

function detailNames(value: unknown, key: string): string[] {
  const values = record(value)?.[key];
  if (!Array.isArray(values)) return [];
  return values.flatMap((candidate) => {
    const name = string(record(candidate)?.name);
    return name ? [name] : [];
  });
}

export function parseExternalImportPreview(
  response: unknown,
  cwd: string,
): CodexExternalImportPreview {
  const items = record(response)?.items;
  const resolvedCwd = path.resolve(cwd);
  const normalized = Array.isArray(items)
    ? items.flatMap((value, index) => {
        const item = record(value);
        const itemType = item ? string(item.itemType) : null;
        const itemCwd = item ? optionalString(item.cwd) : null;
        if (
          !item ||
          !itemType ||
          !externalItemTypes.has(itemType) ||
          !itemCwd ||
          path.resolve(itemCwd) !== resolvedCwd
        ) {
          return [];
        }
        const details = record(item.details);
        const plugins = Array.isArray(details?.plugins) ? details.plugins : [];
        const memory = Array.isArray(details?.memory) ? details.memory : [];
        const stableKey = JSON.stringify({
          itemType,
          cwd: resolvedCwd,
          description: string(item.description) ?? "",
          index,
        });
        return [
          {
            id: createHash("sha256")
              .update(stableKey)
              .digest("hex")
              .slice(0, 24),
            itemType,
            description: string(item.description) ?? "",
            cwd: resolvedCwd,
            details: details
              ? {
                  pluginNames: plugins.flatMap((candidate) => {
                    const plugin = record(candidate);
                    const marketplace = string(plugin?.marketplaceName);
                    const names = Array.isArray(plugin?.pluginNames)
                      ? plugin.pluginNames.filter(
                          (name): name is string => typeof name === "string",
                        )
                      : [];
                    return names.map((name) =>
                      marketplace ? `${marketplace}/${name}` : name,
                    );
                  }),
                  skillNames: detailNames(details, "skills"),
                  sessionCount: Array.isArray(details.sessions)
                    ? details.sessions.length
                    : 0,
                  mcpServerNames: detailNames(details, "mcpServers"),
                  hookNames: detailNames(details, "hooks"),
                  subagentNames: detailNames(details, "subagents"),
                  commandNames: detailNames(details, "commands"),
                  memoryFiles: memory.flatMap((entry) => {
                    const file = string(entry);
                    return file ? [path.basename(file)] : [];
                  }),
                }
              : null,
          },
        ];
      })
    : [];
  return codexExternalImportPreviewSchema.parse({
    sourceScope: "project",
    items: normalized,
  });
}

export function parseMcpResourceRead(response: unknown): CodexMcpResourceRead {
  const contents = record(response)?.contents;
  if (!Array.isArray(contents)) {
    return codexMcpResourceReadSchema.parse({ contents: [] });
  }
  let totalSize = 0;
  const normalized: CodexMcpResourceRead["contents"] = [];
  for (const value of contents) {
    const content = record(value);
    const uri = content ? string(content.uri) : null;
    if (!content || !uri) continue;
    const text = string(content.text);
    const blob = string(content.blob);
    const payload = text ?? blob;
    if (payload === null) continue;
    totalSize += payload.length;
    if (totalSize > MCP_RESOURCE_CONTENT_LIMIT) {
      throw new Error(
        "The MCP resource exceeds Cantrip's 5 MB transport limit.",
      );
    }
    normalized.push(
      text !== null
        ? {
            type: "text",
            uri,
            mimeType: optionalString(content.mimeType),
            text,
          }
        : {
            type: "blob",
            uri,
            mimeType: optionalString(content.mimeType),
            blob: blob!,
          },
    );
  }
  return codexMcpResourceReadSchema.parse({ contents: normalized });
}
