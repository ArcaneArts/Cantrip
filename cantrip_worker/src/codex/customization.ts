import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  codexCustomizationCapabilitiesSchema,
  codexCustomizationInventorySchema,
  codexExternalImportPreviewItemSchema,
  codexExternalImportStatusSchema,
  codexExternalImportPreviewSchema,
  codexMcpOauthStartResultSchema,
  codexMcpOauthStatusSchema,
  codexMcpServerSchema,
  codexMcpResourceReadSchema,
  codexSkillConfigResultSchema,
  codexSkillRootsResultSchema,
  nativeSubagentCapabilityCompatible,
  NATIVE_SUBAGENT_PROTOCOL_VERSION,
  type CodexCustomizationCapabilities,
  type CodexCustomizationInventory,
  type CodexExternalImportPreview,
  type CodexExternalImportStatus,
  type CodexMcpOauthStartResult,
  type CodexMcpOauthStatus,
  type CodexMcpResourceRead,
  type CodexRuntimeReport,
  type CodexSkillConfigResult,
  type CodexSkillRootsResult,
  type CustomizationCapability,
} from "@cantrip/protocol";

import {
  CODEX_CUSTOMIZATION_METHODS,
  codexFeatureUsable,
  codexMethodsAvailable,
} from "./discovery.js";

const MCP_RESOURCE_CONTENT_LIMIT = 5_000_000;
const PLUGIN_PRODUCT_REASON =
  "Codex 0.150 exposes stable core plugin methods, but Cantrip has not yet implemented and validated plugin product operations for this protocol revision.";

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

function methodsCapability(
  report: CodexRuntimeReport,
  methods: readonly string[],
  description: string,
  stability: CustomizationCapability["stability"] = "stable",
): CustomizationCapability {
  return capability(
    codexMethodsAvailable(report, methods),
    `The installed Codex runtime is missing one or more methods required for ${description}.`,
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
  const nativeSubagentsAvailable = nativeSubagentCapabilityCompatible(
    report.nativeSubagents,
  );
  const nativeSubagentsReason = nativeSubagentsAvailable
    ? "Native subagents are available."
    : report.nativeSubagents.available &&
        report.nativeSubagents.protocolVersion !== null
      ? `This worker supports native subagent protocol ${report.nativeSubagents.protocolVersion}, but Cantrip requires protocol ${NATIVE_SUBAGENT_PROTOCOL_VERSION}.`
      : (report.nativeSubagents.reason ??
        "The installed Codex runtime does not support native subagents.");
  const pluginsUnavailable = capability(
    false,
    PLUGIN_PRODUCT_REASON,
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
    nativeSubagents: {
      ...capability(nativeSubagentsAvailable, nativeSubagentsReason),
      protocolVersion: nativeSubagentsAvailable
        ? report.nativeSubagents.protocolVersion
        : null,
    },
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
      configure: methodsCapability(
        report,
        ["skills/list", "skills/config/write"],
        "validated skill configuration",
      ),
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
      apply: methodsCapability(
        report,
        ["externalAgentConfig/detect", "externalAgentConfig/import"],
        "reviewed external configuration imports",
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

export function skillPathForConfiguration(
  response: unknown,
  cwd: string,
  requestedPath: string,
): string {
  const requested = path.resolve(requestedPath);
  const skill = parseSkillInventory(response, cwd).items.find(
    (candidate) => path.resolve(candidate.path) === requested,
  );
  if (!skill) {
    throw new Error(
      "The requested skill path is not present in this project's native Codex inventory.",
    );
  }
  return skill.path;
}

function pathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

export async function resolveProjectSkillRoots(
  cwd: string,
  roots: string[],
): Promise<CodexSkillRootsResult> {
  const canonicalCwd = await realpath(cwd);
  const resolved: string[] = [];
  for (const root of roots) {
    const candidate = await realpath(path.resolve(cwd, root));
    if (!pathWithin(canonicalCwd, candidate)) {
      throw new Error(
        "Extra skill roots must resolve within the selected project checkout.",
      );
    }
    if (!(await stat(candidate)).isDirectory()) {
      throw new Error(`Extra skill root is not a directory: ${root}`);
    }
    if (!resolved.includes(candidate)) resolved.push(candidate);
  }
  return codexSkillRootsResultSchema.parse({ roots: resolved });
}

export function parseSkillConfigResult(
  response: unknown,
  skillPath: string,
): CodexSkillConfigResult {
  const effectiveEnabled = record(response)?.effectiveEnabled;
  if (typeof effectiveEnabled !== "boolean") {
    throw new Error("Codex returned an invalid skill configuration result.");
  }
  return codexSkillConfigResultSchema.parse({
    path: skillPath,
    effectiveEnabled,
  });
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
  skillRoots?: string[];
  hooksResponse: unknown;
  mcpServers: unknown[];
}): CodexCustomizationInventory {
  return codexCustomizationInventorySchema.parse({
    capabilities: customizationCapabilities(input.report),
    skills: parseSkillInventory(input.skillsResponse, input.cwd),
    skillRoots: input.skillRoots ?? [],
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

type ExternalPreviewItem = CodexExternalImportPreview["items"][number];

export interface ProjectExternalImportCandidate {
  id: string;
  item: UnknownRecord;
  preview: ExternalPreviewItem;
}

function detailNames(value: unknown, key: string): string[] {
  const values = record(value)?.[key];
  if (!Array.isArray(values)) return [];
  return values.flatMap((candidate) => {
    const name = string(record(candidate)?.name);
    return name ? [name] : [];
  });
}

export function projectExternalImportCandidates(
  response: unknown,
  cwd: string,
): ProjectExternalImportCandidate[] {
  const items = record(response)?.items;
  const resolvedCwd = path.resolve(cwd);
  return Array.isArray(items)
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
        const id = createHash("sha256")
          .update(stableKey)
          .digest("hex")
          .slice(0, 24);
        return [
          {
            id,
            item,
            preview: codexExternalImportPreviewItemSchema.parse({
              id,
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
            }),
          },
        ];
      })
    : [];
}

export function parseExternalImportPreview(
  response: unknown,
  cwd: string,
): CodexExternalImportPreview {
  return codexExternalImportPreviewSchema.parse({
    sourceScope: "project",
    items: projectExternalImportCandidates(response, cwd).map(
      ({ preview }) => preview,
    ),
  });
}

export function selectExternalImportItems(
  response: unknown,
  cwd: string,
  selectedIds: string[],
): UnknownRecord[] {
  if (new Set(selectedIds).size !== selectedIds.length) {
    throw new Error("External import selections must be unique.");
  }
  const candidates = new Map(
    projectExternalImportCandidates(response, cwd).map((candidate) => [
      candidate.id,
      candidate,
    ]),
  );
  const selected = selectedIds.map((id) => candidates.get(id));
  if (selected.some((candidate) => !candidate)) {
    throw new Error(
      "One or more external configuration candidates changed; preview again before importing.",
    );
  }
  const confirmed = selected as ProjectExternalImportCandidate[];
  if (
    confirmed.some(({ item, preview }) => {
      const plugins = record(item.details)?.plugins;
      return (
        preview.itemType === "PLUGINS" ||
        (Array.isArray(plugins) && plugins.length > 0)
      );
    })
  ) {
    throw new Error(
      "Plugin imports are disabled while the official App Server plugin contract is unsuitable for production clients.",
    );
  }
  return confirmed.map(({ item }) => item);
}

export function parseMcpOauthStart(
  response: unknown,
  server: string,
): CodexMcpOauthStartResult {
  const authorizationUrl = string(record(response)?.authorizationUrl);
  if (!authorizationUrl) {
    throw new Error("Codex did not return an MCP authorization URL.");
  }
  const parsedUrl = new URL(authorizationUrl);
  const localHttp =
    parsedUrl.protocol === "http:" &&
    ["127.0.0.1", "::1", "localhost"].includes(parsedUrl.hostname);
  if (parsedUrl.protocol !== "https:" && !localHttp) {
    throw new Error("Codex returned an unsupported MCP authorization URL.");
  }
  return codexMcpOauthStartResultSchema.parse({
    server,
    authorizationUrl,
    status: "pending",
  });
}

export function parseMcpOauthCompletion(params: unknown): CodexMcpOauthStatus {
  const value = record(params);
  const server = value ? string(value.name) : null;
  if (!server || typeof value?.success !== "boolean") {
    throw new Error("Codex returned an invalid MCP OAuth completion event.");
  }
  return codexMcpOauthStatusSchema.parse({
    server,
    status: value.success ? "succeeded" : "failed",
    error: value.success
      ? null
      : "MCP authorization failed. Review the authorization page and try again.",
  });
}

export function parseExternalImportStatus(
  value: unknown,
  status: "pending" | "completed",
): CodexExternalImportStatus {
  const response = record(value);
  const importId = response ? string(response.importId) : null;
  if (!response || !importId) {
    throw new Error("Codex returned an invalid external import identifier.");
  }
  const rawResults = response.itemTypeResults;
  const results = Array.isArray(rawResults)
    ? rawResults.flatMap((candidate) => {
        const result = record(candidate);
        const itemType = result ? string(result.itemType) : null;
        if (!result || !itemType || !externalItemTypes.has(itemType)) return [];
        const successes = Array.isArray(result.successes)
          ? result.successes.length
          : 0;
        const failures = Array.isArray(result.failures)
          ? result.failures.slice(0, 100).flatMap((failureValue) => {
              const failure = record(failureValue);
              if (!failure) return [];
              const errorType = string(failure.errorType)?.slice(0, 120);
              const subErrorType = string(failure.subErrorType)?.slice(0, 120);
              const classification = [errorType, subErrorType]
                .filter((part): part is string => Boolean(part))
                .join(" / ");
              return [
                {
                  failureStage:
                    string(failure.failureStage)?.slice(0, 200) ?? "unknown",
                  message: classification
                    ? `Codex import failed (${classification}).`
                    : "Codex reported an import failure.",
                },
              ];
            })
          : [];
        return [{ itemType, successCount: successes, failures }];
      })
    : [];
  return codexExternalImportStatusSchema.parse({
    importId,
    status,
    results: results.slice(0, 100),
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
