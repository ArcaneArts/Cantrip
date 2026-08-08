import type {
  CodexCustomizationInventory,
  CodexExternalImportPreviewItem,
  CodexMcpResourceRead,
  CustomizationCapability,
} from "@cantrip/protocol";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import {
  Bot,
  CircleAlert,
  FileSearch,
  Loader2,
  PackageSearch,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Webhook,
  Wrench,
} from "lucide-react";
import { useState, type ReactNode } from "react";

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
  getChatCustomizations,
  getChatExternalImportPreview,
  readChatMcpResource,
} from "@/lib/api";
import { cn } from "@/lib/utils";

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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed.";
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
    <section className="rounded-xl border bg-card">
      <div className="flex gap-3 border-b px-4 py-3">
        <div className="mt-0.5 text-muted-foreground">{icon}</div>
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {description}
          </p>
        </div>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed px-3 py-5 text-center text-sm text-muted-foreground">
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
    <div className="mb-3 grid gap-2">
      {warnings.map((warning) => (
        <div
          key={warning}
          className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs leading-5"
        >
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
          {warning}
        </div>
      ))}
      {errors.map((error) => (
        <div
          key={`${error.path}:${error.message}`}
          className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs leading-5"
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
    <div className="grid gap-2 sm:grid-cols-2">
      {rows.map((row) => (
        <div
          key={`${row.group}:${row.label}`}
          className="rounded-lg border p-3"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {row.group}
              </p>
              <p className="mt-0.5 text-sm font-medium">{row.label}</p>
            </div>
            <CapabilityBadge capability={row.capability} />
          </div>
          {row.capability.reason ? (
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {row.capability.reason}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function SkillInventory({
  inventory,
}: {
  inventory: CodexCustomizationInventory;
}) {
  return (
    <>
      <Diagnostics errors={inventory.skills.errors} />
      {inventory.skills.items.length === 0 ? (
        <Empty>No skills were reported for this chat runtime.</Empty>
      ) : (
        <div className="grid gap-2 md:grid-cols-2">
          {inventory.skills.items.map((skill) => (
            <div key={skill.path} className="rounded-lg border p-3">
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
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {skill.description}
                </p>
              ) : null}
              <code className="mt-2 block break-all text-[11px] text-muted-foreground">
                {skill.path}
              </code>
            </div>
          ))}
        </div>
      )}
    </>
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
        <div className="grid gap-2">
          {inventory.hooks.items.map((hook) => (
            <div
              key={`${hook.key}:${hook.sourcePath}`}
              className="rounded-lg border p-3"
            >
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
    <div className="grid gap-2">
      {result.contents.map((content, index) => {
        if (content.type === "blob") {
          return (
            <div
              key={`${content.uri}:${index}`}
              className="rounded-lg border p-3"
            >
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
          <div
            key={`${content.uri}:${index}`}
            className="rounded-lg border p-3"
          >
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
  resource,
  onReadResource,
}: {
  inventory: CodexCustomizationInventory;
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
        <Empty>No MCP servers are connected to this chat runtime.</Empty>
      ) : (
        inventory.mcpServers.map((server) => (
          <details
            key={server.name}
            className="rounded-lg border"
            open={inventory.mcpServers.length === 1}
          >
            <summary className="cursor-pointer list-none px-3 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-sm">
                  {server.serverInfo?.title ?? server.name}
                </strong>
                <Badge variant="outline">{server.authStatus}</Badge>
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
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Tools
                </h3>
                {server.tools.length === 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    None reported.
                  </p>
                ) : (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {server.tools.map((tool) => (
                      <span
                        key={tool.name}
                        className="rounded-md border px-2 py-1 text-xs"
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
                  <div className="mt-2 grid gap-2">
                    {server.resources.map((item) => (
                      <div
                        key={item.uri}
                        className="flex flex-col gap-2 rounded-md border p-2 sm:flex-row sm:items-center sm:justify-between"
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
                          onClick={() => onReadResource(server.name, item.uri)}
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
        ))
      )}
      {resource.isError ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
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
  const [resourceTarget, setResourceTarget] = useState<{
    server: string;
    uri: string;
  } | null>(null);
  const inventory = useQuery({
    queryKey: ["chat-customizations", chatId],
    queryFn: () => getChatCustomizations(chatId),
    enabled: open,
    refetchOnWindowFocus: false,
  });
  const refresh = useMutation({
    mutationFn: () => getChatCustomizations(chatId, true),
    onSuccess: (data) => {
      queryClient.setQueryData(["chat-customizations", chatId], data);
    },
  });
  const externalPreview = useMutation({
    mutationFn: () => getChatExternalImportPreview(chatId),
  });
  const resource = useMutation({
    mutationFn: (input: { server: string; uri: string }) =>
      readChatMcpResource(chatId, input),
  });

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      externalPreview.reset();
      resource.reset();
      setResourceTarget(null);
    }
    onOpenChange(nextOpen);
  };

  const handleReadResource = (server: string, uri: string) => {
    const target = { server, uri };
    setResourceTarget(target);
    resource.mutate(target);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[calc(100svh-2rem)] max-w-5xl flex-col gap-0 overflow-hidden p-0">
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

        <div className="min-h-0 flex-1 overflow-y-auto bg-muted/20 p-4 sm:p-6">
          <div className="mb-4 flex gap-3 rounded-xl border border-sky-500/30 bg-sky-500/5 p-4 text-sm leading-6">
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-sky-600" />
            <div>
              <p className="font-medium">Isolated, inspection-only view</p>
              <p className="text-xs leading-5 text-muted-foreground">
                This chat uses a Cantrip-owned Codex home. No skill, hook, MCP,
                plugin, or external configuration is changed from this panel.
                Guarded mutation controls are delivered separately.
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
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
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
            <div className="grid gap-4">
              {refresh.isError ? (
                <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
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
                description="Native skills visible to this isolated chat runtime, including disabled and scoped entries."
              >
                <SkillInventory inventory={inventory.data} />
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
                <McpInventory
                  inventory={inventory.data}
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
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded-lg border p-3 text-sm">
                    <p className="font-medium">Native subagents</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {inventory.data.capabilities.nativeSubagents.reason ??
                        "Available through Codex App Server thread and item events."}
                    </p>
                  </div>
                  <div className="rounded-lg border p-3 text-sm">
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
                title="External configuration preview"
                description="Detection is opt-in and restricted to the selected project. It does not scan your home directory or apply anything."
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
                  <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs">
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
                        disabled={externalPreview.isPending}
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
                      externalPreview.data.items.map((item) => (
                        <div key={item.id} className="rounded-lg border p-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline">
                              {item.itemType.replaceAll("_", " ")}
                            </Badge>
                            <p className="text-sm">{item.description}</p>
                          </div>
                          {importDetailLines(item).map((line) => (
                            <p
                              key={line}
                              className="mt-1 break-words text-xs text-muted-foreground"
                            >
                              {line}
                            </p>
                          ))}
                        </div>
                      ))
                    )}
                    <p className="text-xs leading-5 text-muted-foreground">
                      Review only: applying selected candidates is intentionally
                      unavailable in this inspection pass.
                    </p>
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
