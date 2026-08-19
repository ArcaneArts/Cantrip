import type {
  CodexCustomizationInventory,
  CodexExternalImportStatus,
  CodexExternalImportPreviewItem,
  CodexMcpOauthStartResult,
  CodexMcpOauthStatus,
  CodexMcpResourceRead,
  CodexSkillConfigResult,
  CodexSkillRootsResult,
  CustomizationCapability,
} from "@cantrip/protocol";
import { isManagedCodeGraphMcpName } from "@cantrip/protocol";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import {
  Bot,
  Check,
  CircleAlert,
  CircleMinus,
  ExternalLink,
  FileSearch,
  Loader2,
  PackageSearch,
  RefreshCw,
  Save,
  Settings2,
  ShieldCheck,
  Trash2,
  Webhook,
  Wrench,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  applyChatExternalImport,
  configureChatSkill,
  getChatCustomizations,
  getChatExternalImportPreview,
  getChatExternalImportStatus,
  getChatMcpOauthStatus,
  readChatMcpResource,
  reloadChatMcpServers,
  setChatSkillRoots,
  startChatMcpOauth,
} from "@/lib/api";
import { useAppLiveStatus } from "@/lib/app-live-react";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/error-message";

const RESOURCE_PREVIEW_LIMIT = 20_000;

export type CustomizationCapabilityRow = {
  group: string;
  label: string;
  capability: CustomizationCapability;
};

export function customizationCapabilityRows(
  inventory: CodexCustomizationInventory,
): CustomizationCapabilityRow[] {
  const capabilities = inventory.capabilities;
  return [
    {
      group: "Workflows",
      label: "Collaboration modes",
      capability: capabilities.collaborationModes,
    },
    {
      group: "Workflows",
      label: "Thread goals",
      capability: capabilities.threadGoals,
    },
    {
      group: "Agents",
      label: "Native subagents",
      capability: capabilities.nativeSubagents,
    },
    {
      group: "Agents",
      label: "Custom agents",
      capability: capabilities.customAgents,
    },
    {
      group: "Hooks",
      label: "Hook discovery",
      capability: capabilities.hooks,
    },
    {
      group: "Skills",
      label: "List skills",
      capability: capabilities.skills.list,
    },
    {
      group: "Skills",
      label: "Configure skills",
      capability: capabilities.skills.configure,
    },
    {
      group: "Skills",
      label: "Extra skill roots",
      capability: capabilities.skills.extraRoots,
    },
    {
      group: "MCP",
      label: "Server status",
      capability: capabilities.mcp.status,
    },
    {
      group: "MCP",
      label: "Read resources",
      capability: capabilities.mcp.resourceRead,
    },
    {
      group: "MCP",
      label: "OAuth",
      capability: capabilities.mcp.oauth,
    },
    {
      group: "MCP",
      label: "Reload servers",
      capability: capabilities.mcp.reload,
    },
    {
      group: "Plugins",
      label: "List plugins",
      capability: capabilities.plugins.list,
    },
    {
      group: "Plugins",
      label: "Read plugins",
      capability: capabilities.plugins.read,
    },
    {
      group: "Plugins",
      label: "Install plugins",
      capability: capabilities.plugins.install,
    },
    {
      group: "Plugins",
      label: "Uninstall plugins",
      capability: capabilities.plugins.uninstall,
    },
    {
      group: "Imports",
      label: "Preview external configuration",
      capability: capabilities.externalImports.detect,
    },
    {
      group: "Imports",
      label: "Apply external configuration",
      capability: capabilities.externalImports.apply,
    },
  ];
}

export function boundedResourceText(
  text: string,
  limit = RESOURCE_PREVIEW_LIMIT,
): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

export function parseSkillRootsDraft(draft: string): string[] {
  return [
    ...new Set(
      draft
        .split(/\r?\n/u)
        .map((root) => root.trim())
        .filter(Boolean),
    ),
  ];
}

export function selectableExternalImportIds(
  items: CodexExternalImportPreviewItem[],
): string[] {
  return items
    .filter(
      ({ itemType, details }) =>
        itemType !== "PLUGINS" && (details?.pluginNames.length ?? 0) === 0,
    )
    .map(({ id }) => id);
}

async function openAuthorizationUrl(url: string): Promise<void> {
  if ("__TAURI_INTERNALS__" in window) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened) {
    throw new Error("The browser blocked the authorization window.");
  }
}

function errorText(error: unknown): string {
  return errorMessage(error, "The request failed.");
}

function CapabilityBadge({
  capability,
}: {
  capability: CustomizationCapability;
}) {
  return (
    <Badge variant={capability.available ? "secondary" : "outline"}>
      {capability.available ? "Available" : "Unavailable"} ·{" "}
      {capability.stability}
    </Badge>
  );
}

function Section({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="flex gap-3 px-4 py-3 sm:px-6">
        <div className="mt-0.5 text-muted-foreground">{icon}</div>
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {description}
          </p>
        </div>
      </div>
      <div className="border-t px-4 py-4 sm:px-6">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="border-y px-3 py-5 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

function Diagnostics({
  warnings = [],
  errors = [],
}: {
  warnings?: string[];
  errors?: Array<{ path: string; message: string }>;
}) {
  if (warnings.length === 0 && errors.length === 0) return null;
  return (
    <div className="mb-3 divide-y border-y">
      {warnings.map((warning) => (
        <div
          key={warning}
          className="flex gap-2 border-l-2 border-amber-500 px-3 py-2 text-xs leading-5"
        >
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
          {warning}
        </div>
      ))}
      {errors.map((error) => (
        <div
          key={`${error.path}:${error.message}`}
          className="border-l-2 border-destructive px-3 py-2 text-xs leading-5 text-destructive"
        >
          <strong>{error.path || "Inventory"}:</strong> {error.message}
        </div>
      ))}
    </div>
  );
}

function CapabilityInventory({
  inventory,
}: {
  inventory: CodexCustomizationInventory;
}) {
  const rows = customizationCapabilityRows(inventory);
  return (
    <div className="border-y">
      <div className="hidden grid-cols-[7rem_minmax(0,1fr)_auto] gap-3 border-b px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:grid">
        <span>Group</span>
        <span>Capability</span>
        <span>Status</span>
      </div>
      <div className="divide-y">
        {rows.map((row) => (
          <div
            key={`${row.group}:${row.label}`}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1 px-3 py-2.5 sm:grid-cols-[7rem_minmax(0,1fr)_auto] sm:gap-3"
          >
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {row.group}
            </p>
            <div className="col-span-2 row-start-2 min-w-0 sm:col-span-1 sm:row-start-auto">
              <p className="text-sm font-medium">{row.label}</p>
              {row.capability.reason ? (
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {row.capability.reason}
                </p>
              ) : null}
            </div>
            <div className="col-start-2 row-start-1 justify-self-end sm:col-start-auto sm:row-start-auto">
              <CapabilityBadge capability={row.capability} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SkillInventory({
  inventory,
  configuration,
}: {
  inventory: CodexCustomizationInventory;
  configuration: UseMutationResult<
    CodexSkillConfigResult,
    Error,
    { path: string; enabled: boolean }
  >;
}) {
  return (
    <>
      <Diagnostics errors={inventory.skills.errors} />
      {inventory.skills.items.length === 0 ? (
        <Empty>No skills were reported for this agent runtime.</Empty>
      ) : (
        <div className="divide-y border-y">
          {inventory.skills.items.map((skill) => (
            <div
              key={skill.path}
              className="grid gap-3 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="text-sm">
                    {skill.displayName ?? skill.name}
                  </strong>
                  <Badge variant={skill.enabled ? "secondary" : "outline"}>
                    {skill.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                  <Badge variant="outline">{skill.scope}</Badge>
                </div>
                {skill.description ? (
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {skill.description}
                  </p>
                ) : null}
                <code className="mt-1 block break-all text-[11px] text-muted-foreground">
                  {skill.path}
                </code>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={
                  configuration.isPending ||
                  !inventory.capabilities.skills.configure.available
                }
                title={
                  inventory.capabilities.skills.configure.reason ??
                  `${skill.enabled ? "Disable" : "Enable"} this skill`
                }
                onClick={() =>
                  configuration.mutate({
                    path: skill.path,
                    enabled: !skill.enabled,
                  })
                }
              >
                {configuration.isPending &&
                configuration.variables?.path === skill.path ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : skill.enabled ? (
                  <CircleMinus className="size-3.5" />
                ) : (
                  <Check className="size-3.5" />
                )}
                {skill.enabled ? "Disable" : "Enable"}
              </Button>
            </div>
          ))}
        </div>
      )}
      {configuration.isError ? (
        <p className="mt-3 border-l-2 border-destructive px-3 py-2 text-xs text-destructive">
          {errorText(configuration.error)}
        </p>
      ) : null}
    </>
  );
}

function SkillRootsControl({
  capability,
  roots,
  mutation,
}: {
  capability: CustomizationCapability;
  roots: string[];
  mutation: UseMutationResult<
    CodexSkillRootsResult,
    Error,
    { roots: string[] }
  >;
}) {
  const [draft, setDraft] = useState(roots.join("\n"));
  const parsedRoots = parseSkillRootsDraft(draft);
  const tooManyRoots = parsedRoots.length > 32;
  return (
    <div className="mt-4 border-t pt-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Extra skill roots</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            One project-relative directory per line. Real paths must stay inside
            this checkout. The replacement applies to this isolated Codex
            process and is cleared when it stops.
          </p>
        </div>
        <Badge variant="outline">process scoped</Badge>
      </div>
      <textarea
        className="mt-3 min-h-24 w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        disabled={!capability.available || mutation.isPending}
        placeholder={".agents/skills\nshared/skills"}
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!capability.available || mutation.isPending || tooManyRoots}
          onClick={() => mutation.mutate({ roots: parsedRoots })}
        >
          {mutation.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Save className="size-3.5" />
          )}
          Replace roots
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={
            !capability.available || mutation.isPending || roots.length === 0
          }
          onClick={() => mutation.mutate({ roots: [] })}
        >
          <Trash2 className="size-3.5" /> Clear
        </Button>
        <span className="text-xs text-muted-foreground">
          {parsedRoots.length} / 32 directories
        </span>
      </div>
      {!capability.available && capability.reason ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {capability.reason}
        </p>
      ) : null}
      {tooManyRoots ? (
        <p className="mt-2 text-xs text-destructive">
          At most 32 roots are allowed.
        </p>
      ) : null}
      {mutation.isError ? (
        <p className="mt-2 text-xs text-destructive">
          {errorText(mutation.error)}
        </p>
      ) : null}
    </div>
  );
}

function HookInventory({
  inventory,
}: {
  inventory: CodexCustomizationInventory;
}) {
  return (
    <>
      <Diagnostics
        warnings={inventory.hooks.warnings}
        errors={inventory.hooks.errors}
      />
      {inventory.hooks.items.length === 0 ? (
        <Empty>No project or managed hooks were reported.</Empty>
      ) : (
        <div className="divide-y border-y">
          {inventory.hooks.items.map((hook) => (
            <div key={`${hook.key}:${hook.sourcePath}`} className="px-3 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-sm">{hook.key}</strong>
                <Badge variant={hook.enabled ? "secondary" : "outline"}>
                  {hook.enabled ? "Enabled" : "Disabled"}
                </Badge>
                <Badge variant="outline">{hook.trust}</Badge>
                <Badge variant="outline">{hook.handlerType}</Badge>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {hook.eventName}
                {hook.matcher ? ` · ${hook.matcher}` : ""}
                {hook.timeoutSeconds
                  ? ` · ${hook.timeoutSeconds}s timeout`
                  : ""}
              </p>
              {hook.command ? (
                <code className="mt-2 block overflow-x-auto rounded-md bg-muted px-2 py-1.5 text-[11px]">
                  {hook.command}
                </code>
              ) : null}
              <code className="mt-2 block break-all text-[11px] text-muted-foreground">
                {hook.source} · {hook.sourcePath}
              </code>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function ResourceResult({ result }: { result: CodexMcpResourceRead }) {
  if (result.contents.length === 0) {
    return <Empty>The MCP server returned no content.</Empty>;
  }
  return (
    <div className="divide-y border-y">
      {result.contents.map((content, index) => {
        if (content.type === "blob") {
          return (
            <div key={`${content.uri}:${index}`} className="px-3 py-3">
              <p className="text-sm font-medium">Binary resource</p>
              <p className="mt-1 break-all text-xs text-muted-foreground">
                {content.uri} · {content.mimeType ?? "unknown type"} ·{" "}
                {content.blob.length.toLocaleString()} encoded characters
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                Binary payloads are not rendered in the inspection panel.
              </p>
            </div>
          );
        }
        const preview = boundedResourceText(content.text);
        return (
          <div key={`${content.uri}:${index}`} className="px-3 py-3">
            <p className="break-all text-xs text-muted-foreground">
              {content.uri} · {content.mimeType ?? "text"}
            </p>
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs leading-5">
              {preview.text}
            </pre>
            {preview.truncated ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Preview limited to {RESOURCE_PREVIEW_LIMIT.toLocaleString()}{" "}
                characters.
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function McpInventory({
  inventory,
  oauth,
  oauthInProgress,
  resource,
  onReadResource,
}: {
  inventory: CodexCustomizationInventory;
  oauth: UseMutationResult<CodexMcpOauthStartResult, Error, { server: string }>;
  oauthInProgress: boolean;
  resource: UseMutationResult<
    CodexMcpResourceRead,
    Error,
    { server: string; uri: string }
  >;
  onReadResource: (server: string, uri: string) => void;
}) {
  return (
    <div className="grid gap-3">
      {inventory.mcpServers.length === 0 ? (
        <Empty>No MCP servers are connected to this agent runtime.</Empty>
      ) : (
        <div className="divide-y border-y">
          {inventory.mcpServers.map((server) => (
            <details key={server.name} open={inventory.mcpServers.length === 1}>
              <summary className="cursor-pointer list-none px-3 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="text-sm">
                    {server.serverInfo?.title ?? server.name}
                  </strong>
                  <Badge variant="outline">{server.authStatus}</Badge>
                  {isManagedCodeGraphMcpName(server.name) ? (
                    <>
                      <Badge variant="secondary">Managed by Cantrip</Badge>
                      <Badge variant="outline">Read only</Badge>
                    </>
                  ) : null}
                  <span className="text-xs text-muted-foreground">
                    {server.tools.length} tools · {server.resources.length}{" "}
                    resources · {server.resourceTemplates.length} templates
                  </span>
                </div>
                {server.serverInfo?.description ? (
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {server.serverInfo.description}
                  </p>
                ) : null}
              </summary>
              <div className="grid gap-4 border-t px-3 py-3">
                {server.authStatus === "notLoggedIn" ? (
                  <div className="border-l-2 border-sky-500 pl-3">
                    <p className="text-xs leading-5 text-muted-foreground">
                      This server requires OAuth. Cantrip opens the native
                      authorization page and watches Codex for completion.
                    </p>
                    <Button
                      className="mt-2"
                      size="sm"
                      variant="outline"
                      disabled={
                        oauth.isPending ||
                        oauthInProgress ||
                        !inventory.capabilities.mcp.oauth.available
                      }
                      title={
                        inventory.capabilities.mcp.oauth.reason ??
                        `Authorize ${server.name}`
                      }
                      onClick={() => oauth.mutate({ server: server.name })}
                    >
                      {oauth.isPending &&
                      oauth.variables?.server === server.name ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <ExternalLink className="size-3.5" />
                      )}
                      Authorize
                    </Button>
                  </div>
                ) : null}
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Tools
                  </h3>
                  {server.tools.length === 0 ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      None reported.
                    </p>
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                      {server.tools.map((tool) => (
                        <span
                          key={tool.name}
                          className="text-xs"
                          title={tool.description ?? undefined}
                        >
                          {tool.title ?? tool.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Resources
                  </h3>
                  {server.resources.length === 0 ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      None reported.
                    </p>
                  ) : (
                    <div className="mt-2 divide-y border-y">
                      {server.resources.map((item) => (
                        <div
                          key={item.uri}
                          className="flex flex-col gap-2 px-2 py-2 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-xs font-medium">
                              {item.title ?? item.name}
                            </p>
                            <p className="truncate text-[11px] text-muted-foreground">
                              {item.uri}
                            </p>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={
                              resource.isPending ||
                              !inventory.capabilities.mcp.resourceRead.available
                            }
                            title={
                              inventory.capabilities.mcp.resourceRead.reason ??
                              "Read this resource"
                            }
                            onClick={() =>
                              onReadResource(server.name, item.uri)
                            }
                          >
                            {resource.isPending &&
                            resource.variables?.server === server.name &&
                            resource.variables.uri === item.uri ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <FileSearch className="size-3.5" />
                            )}
                            Read
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Resource templates
                  </h3>
                  {server.resourceTemplates.length === 0 ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      None reported.
                    </p>
                  ) : (
                    <div className="mt-2 grid gap-1">
                      {server.resourceTemplates.map((template) => (
                        <code
                          key={template.uriTemplate}
                          className="break-all text-[11px] text-muted-foreground"
                        >
                          {template.title ?? template.name}:{" "}
                          {template.uriTemplate}
                        </code>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </details>
          ))}
        </div>
      )}
      {resource.isError ? (
        <p className="border-l-2 border-destructive px-3 py-2 text-xs text-destructive">
          {errorText(resource.error)}
        </p>
      ) : null}
      {resource.data ? <ResourceResult result={resource.data} /> : null}
    </div>
  );
}

function importDetailLines(item: CodexExternalImportPreviewItem): string[] {
  if (!item.details) return [];
  const entries: Array<[string, string[]]> = [
    ["Skills", item.details.skillNames],
    ["Plugins", item.details.pluginNames],
    ["MCP servers", item.details.mcpServerNames],
    ["Hooks", item.details.hookNames],
    ["Subagents", item.details.subagentNames],
    ["Commands", item.details.commandNames],
    ["Memory", item.details.memoryFiles],
  ];
  const lines = entries
    .filter(([, values]) => values.length > 0)
    .map(([label, values]) => `${label}: ${values.join(", ")}`);
  if (item.details.sessionCount > 0) {
    lines.push(`Sessions: ${item.details.sessionCount}`);
  }
  return lines;
}

function ExternalImportProgress({
  status,
}: {
  status: CodexExternalImportStatus;
}) {
  if (status.status === "pending") {
    return (
      <p className="flex items-center gap-2 border-l-2 px-3 py-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Codex is importing the
        reviewed configuration…
      </p>
    );
  }
  if (status.status === "unknown") {
    return (
      <p className="border-l-2 px-3 py-2 text-xs text-muted-foreground">
        This runtime no longer has completion state for import {status.importId}
        .
      </p>
    );
  }
  const successCount = status.results.reduce(
    (total, result) => total + result.successCount,
    0,
  );
  const failures = status.results.flatMap((result) =>
    result.failures.map((failure) => ({
      ...failure,
      itemType: result.itemType,
    })),
  );
  return (
    <div
      className={cn(
        "border-l-2 px-3 py-2 text-xs",
        failures.length > 0 ? "border-amber-500" : "border-emerald-500",
      )}
    >
      <p className="flex items-center gap-2 font-medium">
        {failures.length > 0 ? (
          <CircleAlert className="size-3.5 text-amber-600" />
        ) : (
          <Check className="size-3.5 text-emerald-600" />
        )}
        Import completed · {successCount} successful · {failures.length} failed
      </p>
      {failures.map((failure, index) => (
        <p
          key={`${failure.itemType}:${failure.failureStage}:${index}`}
          className="mt-2 text-muted-foreground"
        >
          {failure.itemType.replaceAll("_", " ")} · {failure.failureStage}:{" "}
          {failure.message}
        </p>
      ))}
    </div>
  );
}

function OauthProgress({
  server,
  status,
}: {
  server: string;
  status: CodexMcpOauthStatus;
}) {
  const message =
    status.status === "pending"
      ? "Waiting for authorization"
      : status.status === "succeeded"
        ? "Authorization succeeded; reloading MCP servers"
        : status.status === "failed"
          ? (status.error ?? "Authorization failed")
          : "Authorization state is no longer available";
  return (
    <p className="flex items-center gap-2 border-l-2 px-3 py-2 text-xs text-muted-foreground">
      {status.status === "pending" ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : status.status === "succeeded" ? (
        <Check className="size-3.5 text-emerald-600" />
      ) : (
        <CircleAlert className="size-3.5" />
      )}
      {server} · {message}
    </p>
  );
}

export function CustomizationPanel({
  chatId,
  chatTitle,
  open,
  onOpenChange,
}: {
  chatId: string;
  chatTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const liveStatus = useAppLiveStatus();
  const customizationResourcesLive = liveStatus === "live";
  const inventoryKey = ["chat-customizations", chatId, "inventory"] as const;
  const [oauthServer, setOauthServer] = useState<string | null>(null);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [importId, setImportId] = useState<string | null>(null);
  const [selectedImportIds, setSelectedImportIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [resourceTarget, setResourceTarget] = useState<{
    server: string;
    uri: string;
  } | null>(null);
  const autoReloadedOauth = useRef<string | null>(null);
  const refreshedImport = useRef<string | null>(null);
  const inventory = useQuery({
    queryKey: inventoryKey,
    queryFn: () => getChatCustomizations(chatId),
    enabled: open,
    refetchOnWindowFocus: false,
  });
  const refreshInventory = async () => {
    const data = await getChatCustomizations(chatId, true);
    queryClient.setQueryData(inventoryKey, data);
    return data;
  };
  const refresh = useMutation({
    mutationFn: refreshInventory,
  });
  const skillConfiguration = useMutation({
    mutationFn: (input: { path: string; enabled: boolean }) =>
      configureChatSkill(chatId, input),
    onSuccess: refreshInventory,
  });
  const skillRoots = useMutation({
    mutationFn: (input: { roots: string[] }) =>
      setChatSkillRoots(chatId, input),
    onSuccess: refreshInventory,
  });
  const externalPreview = useMutation({
    mutationFn: () => getChatExternalImportPreview(chatId),
    onMutate: () => {
      externalImport.reset();
      setImportId(null);
      setSelectedImportIds(new Set());
      refreshedImport.current = null;
    },
  });
  const externalImport = useMutation({
    mutationFn: (itemIds: string[]) =>
      applyChatExternalImport(chatId, { itemIds }),
    onSuccess: (status) => {
      setSelectedImportIds(new Set());
      queryClient.setQueryData<CodexExternalImportStatus>(
        ["chat-customizations", chatId, "external-import", status.importId],
        status,
      );
      setImportId(status.importId);
    },
  });
  const resource = useMutation({
    mutationFn: (input: { server: string; uri: string }) =>
      readChatMcpResource(chatId, input),
  });
  const mcpReload = useMutation({
    mutationFn: () => reloadChatMcpServers(chatId),
    onSuccess: refreshInventory,
  });
  const mcpOauth = useMutation({
    mutationFn: async (input: { server: string }) => {
      setOauthServer(null);
      setAuthorizationUrl(null);
      autoReloadedOauth.current = null;
      mcpReload.reset();
      const result = await startChatMcpOauth(chatId, input);
      queryClient.removeQueries({
        queryKey: ["chat-customizations", chatId, "mcp-oauth", result.server],
        exact: true,
      });
      queryClient.setQueryData<CodexMcpOauthStatus>(
        ["chat-customizations", chatId, "mcp-oauth", result.server],
        { server: result.server, status: "pending", error: null },
      );
      setOauthServer(result.server);
      setAuthorizationUrl(result.authorizationUrl);
      await openAuthorizationUrl(result.authorizationUrl);
      return result;
    },
  });
  const oauthStatus = useQuery({
    queryKey: ["chat-customizations", chatId, "mcp-oauth", oauthServer],
    queryFn: () => getChatMcpOauthStatus(chatId, oauthServer!),
    enabled: open && oauthServer !== null,
    refetchInterval: customizationResourcesLive
      ? false
      : (query) => (query.state.data?.status === "pending" ? 1_000 : false),
    refetchOnWindowFocus: false,
    staleTime: customizationResourcesLive ? Infinity : 0,
  });
  const externalImportStatus = useQuery({
    queryKey: ["chat-customizations", chatId, "external-import", importId],
    queryFn: () => getChatExternalImportStatus(chatId, importId!),
    enabled: open && importId !== null,
    refetchInterval: customizationResourcesLive
      ? false
      : (query) => (query.state.data?.status === "pending" ? 1_000 : false),
    refetchOnWindowFocus: false,
    staleTime: customizationResourcesLive ? Infinity : 0,
  });
  const oauthInProgress =
    mcpOauth.isPending ||
    oauthStatus.isFetching ||
    oauthStatus.data?.status === "pending";
  const externalImportInProgress =
    externalImport.isPending ||
    externalImportStatus.isFetching ||
    externalImportStatus.data?.status === "pending";

  useEffect(() => {
    const status = oauthStatus.data;
    if (
      !oauthServer ||
      status?.status !== "succeeded" ||
      autoReloadedOauth.current === oauthServer
    ) {
      return;
    }
    autoReloadedOauth.current = oauthServer;
    mcpReload.mutate();
  }, [mcpReload, oauthServer, oauthStatus.data]);

  useEffect(() => {
    const status = externalImportStatus.data;
    if (
      status?.status !== "completed" ||
      refreshedImport.current === status.importId
    ) {
      return;
    }
    refreshedImport.current = status.importId;
    refresh.mutate();
  }, [externalImportStatus.data, refresh]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      externalPreview.reset();
      externalImport.reset();
      skillConfiguration.reset();
      skillRoots.reset();
      mcpOauth.reset();
      mcpReload.reset();
      resource.reset();
      setOauthServer(null);
      setAuthorizationUrl(null);
      setImportId(null);
      setSelectedImportIds(new Set());
      setResourceTarget(null);
      autoReloadedOauth.current = null;
      refreshedImport.current = null;
    }
    onOpenChange(nextOpen);
  };

  const handleReadResource = (server: string, uri: string) => {
    const target = { server, uri };
    setResourceTarget(target);
    resource.mutate(target);
  };

  const toggleImportSelection = (id: string) => {
    setSelectedImportIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[calc(100svh-2rem)] max-w-5xl flex-col gap-0 overflow-hidden p-0 subpixel-antialiased">
        <DialogHeader className="shrink-0 border-b px-6 py-5">
          <div className="flex flex-wrap items-start justify-between gap-3 pr-6">
            <div>
              <DialogTitle>Codex customizations</DialogTitle>
              <DialogDescription className="mt-1">
                Native runtime capabilities and project-scoped configuration for{" "}
                {chatTitle}.
              </DialogDescription>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={!inventory.data || refresh.isPending}
              onClick={() => refresh.mutate()}
            >
              <RefreshCw
                className={cn("size-3.5", refresh.isPending && "animate-spin")}
              />
              Refresh runtime
            </Button>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
          <div className="flex gap-3 border-b px-4 py-4 text-sm leading-6 sm:px-6">
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-sky-600" />
            <div>
              <p className="font-medium">Isolated native controls</p>
              <p className="text-xs leading-5 text-muted-foreground">
                This agent uses a Cantrip-owned Codex home. Changes below go
                through capability-checked App Server methods: skill toggles are
                reversible, extra roots are process scoped, and external imports
                require an explicit reviewed selection. Plugin controls remain
                unavailable while Codex marks those APIs as developmental.
              </p>
            </div>
          </div>

          {inventory.isPending ? (
            <div className="grid min-h-56 place-items-center text-sm text-muted-foreground">
              <div className="flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" /> Inspecting the Codex
                runtime…
              </div>
            </div>
          ) : inventory.isError ? (
            <div className="border-b px-4 py-5 sm:px-6">
              <p className="font-medium text-destructive">
                Customization inventory unavailable
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {errorText(inventory.error)}
              </p>
              <Button
                className="mt-3"
                size="sm"
                variant="outline"
                onClick={() => inventory.refetch()}
              >
                Try again
              </Button>
            </div>
          ) : inventory.data ? (
            <div className="divide-y border-b">
              {refresh.isError ? (
                <p className="mx-4 my-3 border-l-2 border-destructive px-3 py-2 text-xs text-destructive sm:mx-6">
                  Refresh failed: {errorText(refresh.error)}
                </p>
              ) : null}

              <Section
                icon={<Settings2 className="size-4" />}
                title="Runtime capabilities"
                description="Availability is negotiated against the installed Codex App Server, not assumed from a CLI version."
              >
                <CapabilityInventory inventory={inventory.data} />
              </Section>

              <Section
                icon={<PackageSearch className="size-4" />}
                title={`Skills (${inventory.data.skills.items.length})`}
                description="Native skills visible to this isolated agent runtime, including disabled and scoped entries."
              >
                <SkillInventory
                  inventory={inventory.data}
                  configuration={skillConfiguration}
                />
                <SkillRootsControl
                  key={inventory.data.skillRoots.join("\n")}
                  capability={inventory.data.capabilities.skills.extraRoots}
                  roots={inventory.data.skillRoots}
                  mutation={skillRoots}
                />
              </Section>

              <Section
                icon={<Webhook className="size-4" />}
                title={`Hooks (${inventory.data.hooks.items.length})`}
                description="Trusted or managed hook commands may be shown; modified and untrusted command bodies remain redacted by the worker."
              >
                <HookInventory inventory={inventory.data} />
              </Section>

              <Section
                icon={<Wrench className="size-4" />}
                title={`MCP servers (${inventory.data.mcpServers.length})`}
                description="Inspect auth state, tools, resources, and resource templates reported by native MCP status."
              >
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      mcpReload.isPending ||
                      oauthInProgress ||
                      !inventory.data.capabilities.mcp.reload.available
                    }
                    title={
                      inventory.data.capabilities.mcp.reload.reason ??
                      "Reload MCP server configuration"
                    }
                    onClick={() => mcpReload.mutate()}
                  >
                    <RefreshCw
                      className={cn(
                        "size-3.5",
                        mcpReload.isPending && "animate-spin",
                      )}
                    />
                    Reload MCP servers
                  </Button>
                  {!inventory.data.capabilities.mcp.reload.available &&
                  inventory.data.capabilities.mcp.reload.reason ? (
                    <span className="text-xs text-muted-foreground">
                      {inventory.data.capabilities.mcp.reload.reason}
                    </span>
                  ) : null}
                </div>
                {mcpReload.isError ? (
                  <p className="mb-3 border-l-2 border-destructive px-3 py-2 text-xs text-destructive">
                    Reload failed: {errorText(mcpReload.error)}
                  </p>
                ) : null}
                {mcpReload.isSuccess ? (
                  <p className="mb-3 flex items-center gap-2 border-l-2 border-emerald-500 px-3 py-2 text-xs">
                    <Check className="size-3.5 text-emerald-600" /> MCP servers
                    reloaded.
                  </p>
                ) : null}
                {oauthServer && oauthStatus.data ? (
                  <div className="mb-3">
                    <OauthProgress
                      server={oauthServer}
                      status={oauthStatus.data}
                    />
                    {authorizationUrl &&
                    oauthStatus.data.status === "pending" ? (
                      <a
                        className="mt-2 inline-flex items-center gap-1 text-xs font-medium underline underline-offset-4"
                        href={authorizationUrl}
                        rel="noreferrer"
                        target="_blank"
                      >
                        Open authorization page again
                        <ExternalLink className="size-3" />
                      </a>
                    ) : null}
                  </div>
                ) : null}
                {oauthStatus.isError ? (
                  <p className="mb-3 border-l-2 border-destructive px-3 py-2 text-xs text-destructive">
                    Authorization status failed: {errorText(oauthStatus.error)}
                  </p>
                ) : null}
                {mcpOauth.isError ? (
                  <div className="mb-3 border-l-2 border-destructive px-3 py-2 text-xs">
                    <p className="text-destructive">
                      Authorization window failed: {errorText(mcpOauth.error)}
                    </p>
                    {authorizationUrl ? (
                      <a
                        className="mt-2 inline-flex items-center gap-1 font-medium underline underline-offset-4"
                        href={authorizationUrl}
                        rel="noreferrer"
                        target="_blank"
                      >
                        Open authorization page{" "}
                        <ExternalLink className="size-3" />
                      </a>
                    ) : null}
                  </div>
                ) : null}
                <McpInventory
                  inventory={inventory.data}
                  oauth={mcpOauth}
                  oauthInProgress={oauthInProgress}
                  resource={resource}
                  onReadResource={handleReadResource}
                />
                {resourceTarget && resource.isPending ? (
                  <p className="mt-3 break-all text-xs text-muted-foreground">
                    Reading {resourceTarget.server} · {resourceTarget.uri}
                  </p>
                ) : null}
              </Section>

              <Section
                icon={<Bot className="size-4" />}
                title="Agent model"
                description="Cantrip bridges native collaboration modes, goals, and subagent progress without inventing a second agent runtime."
              >
                <div className="divide-y border-y">
                  <div className="px-3 py-3 text-sm">
                    <p className="font-medium">Native subagents</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {inventory.data.capabilities.nativeSubagents.reason ??
                        "Available through Codex App Server thread and item events."}
                    </p>
                  </div>
                  <div className="px-3 py-3 text-sm">
                    <p className="font-medium">Custom agent definitions</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {inventory.data.capabilities.customAgents.reason ??
                        "No native custom-agent discovery method was reported."}
                    </p>
                  </div>
                </div>
              </Section>

              <Section
                icon={<FileSearch className="size-4" />}
                title="External configuration import"
                description="Detection is opt-in and restricted to the selected project. Only explicitly checked, freshly revalidated candidates are applied; home configuration and plugins remain excluded."
              >
                {!externalPreview.data &&
                !externalPreview.isPending &&
                !externalPreview.isError ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      !inventory.data.capabilities.externalImports.detect
                        .available
                    }
                    onClick={() => externalPreview.mutate()}
                  >
                    <FileSearch className="size-3.5" /> Preview project
                    configuration
                  </Button>
                ) : null}
                {!inventory.data.capabilities.externalImports.detect
                  .available &&
                inventory.data.capabilities.externalImports.detect.reason ? (
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    {inventory.data.capabilities.externalImports.detect.reason}
                  </p>
                ) : null}
                {externalPreview.isPending ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> Scanning the
                    selected project…
                  </p>
                ) : null}
                {externalPreview.isError ? (
                  <div className="border-l-2 border-destructive px-3 py-2 text-xs">
                    <p className="text-destructive">
                      {errorText(externalPreview.error)}
                    </p>
                    <Button
                      className="mt-2"
                      size="sm"
                      variant="outline"
                      onClick={() => externalPreview.mutate()}
                    >
                      Try again
                    </Button>
                  </div>
                ) : null}
                {externalPreview.data ? (
                  <div className="grid gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs text-muted-foreground">
                        Project-scoped preview ·{" "}
                        {externalPreview.data.items.length} candidate
                        {externalPreview.data.items.length === 1 ? "" : "s"}
                      </p>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={
                          externalPreview.isPending || externalImportInProgress
                        }
                        onClick={() => externalPreview.mutate()}
                      >
                        <RefreshCw className="size-3.5" /> Rescan
                      </Button>
                    </div>
                    {externalPreview.data.items.length === 0 ? (
                      <Empty>
                        No external configuration candidates were detected in
                        this project.
                      </Empty>
                    ) : (
                      <div className="divide-y border-y">
                        {externalPreview.data.items.map((item) => {
                          const selectable = selectableExternalImportIds([
                            item,
                          ]).includes(item.id);
                          const disabled =
                            !selectable ||
                            !inventory.data.capabilities.externalImports.apply
                              .available ||
                            externalImportInProgress;
                          return (
                            <label
                              key={item.id}
                              className={cn(
                                "flex gap-3 px-3 py-3",
                                disabled && "opacity-70",
                              )}
                            >
                              <input
                                className="mt-1 size-4 shrink-0 accent-primary"
                                type="checkbox"
                                checked={selectedImportIds.has(item.id)}
                                disabled={disabled}
                                onChange={() => toggleImportSelection(item.id)}
                              />
                              <span className="min-w-0">
                                <span className="flex flex-wrap items-center gap-2">
                                  <Badge variant="outline">
                                    {item.itemType.replaceAll("_", " ")}
                                  </Badge>
                                  <span className="text-sm">
                                    {item.description}
                                  </span>
                                </span>
                                {importDetailLines(item).map((line) => (
                                  <span
                                    key={line}
                                    className="mt-1 block break-words text-xs text-muted-foreground"
                                  >
                                    {line}
                                  </span>
                                ))}
                                {!selectable ? (
                                  <span className="mt-1 block text-xs text-muted-foreground">
                                    Plugin-bearing imports are disabled because
                                    native plugin operations are not production
                                    supported.
                                  </span>
                                ) : null}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                    {externalPreview.data.items.length > 0 ? (
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={
                            externalImportInProgress ||
                            !inventory.data.capabilities.externalImports.apply
                              .available
                          }
                          onClick={() =>
                            setSelectedImportIds(
                              new Set(
                                selectableExternalImportIds(
                                  externalPreview.data.items,
                                ),
                              ),
                            )
                          }
                        >
                          Select safe candidates
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={
                            externalImportInProgress ||
                            selectedImportIds.size === 0
                          }
                          onClick={() => setSelectedImportIds(new Set())}
                        >
                          Clear selection
                        </Button>
                        <Button
                          size="sm"
                          disabled={
                            externalImportInProgress ||
                            selectedImportIds.size === 0 ||
                            !inventory.data.capabilities.externalImports.apply
                              .available
                          }
                          onClick={() =>
                            externalImport.mutate([...selectedImportIds])
                          }
                        >
                          {externalImportInProgress ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Save className="size-3.5" />
                          )}
                          {externalImportInProgress
                            ? "Import in progress"
                            : `Apply selected (${selectedImportIds.size})`}
                        </Button>
                      </div>
                    ) : null}
                    {!inventory.data.capabilities.externalImports.apply
                      .available &&
                    inventory.data.capabilities.externalImports.apply.reason ? (
                      <p className="text-xs leading-5 text-muted-foreground">
                        {
                          inventory.data.capabilities.externalImports.apply
                            .reason
                        }
                      </p>
                    ) : null}
                    {externalImport.isError ? (
                      <p className="border-l-2 border-destructive px-3 py-2 text-xs text-destructive">
                        Import failed: {errorText(externalImport.error)}
                      </p>
                    ) : null}
                    {externalImportStatus.isError ? (
                      <p className="border-l-2 border-destructive px-3 py-2 text-xs text-destructive">
                        Import status failed:{" "}
                        {errorText(externalImportStatus.error)}
                      </p>
                    ) : null}
                    {externalImportStatus.data ? (
                      <ExternalImportProgress
                        status={externalImportStatus.data}
                      />
                    ) : null}
                  </div>
                ) : null}
              </Section>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
