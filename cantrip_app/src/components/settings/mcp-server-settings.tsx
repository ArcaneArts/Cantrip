import type {
  McpServerConfiguration,
  McpServerSummary,
  ProjectSummary,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Cable,
  Braces,
  Copy,
  Loader2,
  Pencil,
  Plus,
  Server,
  Trash2,
} from "lucide-react";
import { type FormEvent, type ReactNode, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  copyProjectMcpServer,
  createGlobalMcpServer,
  createProjectMcpServer,
  deleteGlobalMcpServer,
  deleteProjectMcpServer,
  getGlobalMcpServers,
  getProjectMcpServers,
  getProjects,
  getWorkers,
  updateGlobalMcpServer,
  updateProjectMcpServer,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { errorMessage as errorText } from "@/lib/error-message";

type McpScope = { kind: "global" } | { kind: "project"; projectId: string };

interface ServerDraft {
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string;
  environment: string;
  url: string;
  bearerTokenEnvironmentVariable: string;
  headers: string;
  environmentHeaders: string;
  enabled: boolean;
}

const emptyDraft: ServerDraft = {
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  environment: "",
  url: "",
  bearerTokenEnvironmentVariable: "",
  headers: "",
  environmentHeaders: "",
  enabled: true,
};

const textareaClass =
  "min-h-24 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

function Field({
  children,
  label,
  hint,
}: {
  children: ReactNode;
  label: string;
  hint?: string;
}) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint ? (
        <span className="text-xs text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}

function formatMapping(value: Record<string, string>): string {
  return Object.entries(value)
    .map(([key, item]) => `${key}=${item}`)
    .join("\n");
}

export function parseMcpMapping(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [index, rawLine] of value.split("\n").entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new Error(`Line ${index + 1} must use NAME=value.`);
    }
    const key = line.slice(0, separator).trim();
    if (!key) throw new Error(`Line ${index + 1} is missing a name.`);
    result[key] = line.slice(separator + 1).trim();
  }
  return result;
}

function draftFor(server: McpServerSummary | null): ServerDraft {
  if (!server) return { ...emptyDraft };
  if (server.transport === "stdio") {
    return {
      ...emptyDraft,
      name: server.name,
      transport: "stdio",
      command: server.command,
      args: server.args.join("\n"),
      environment: formatMapping(server.environment),
      enabled: server.enabled,
    };
  }
  return {
    ...emptyDraft,
    name: server.name,
    transport: "http",
    url: server.url,
    bearerTokenEnvironmentVariable: server.bearerTokenEnvironmentVariable ?? "",
    headers: formatMapping(server.headers),
    environmentHeaders: formatMapping(server.environmentHeaders),
    enabled: server.enabled,
  };
}

function configurationFor(draft: ServerDraft): McpServerConfiguration {
  if (draft.transport === "stdio") {
    return {
      name: draft.name,
      transport: "stdio",
      command: draft.command,
      args: draft.args
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean),
      environment: parseMcpMapping(draft.environment),
      enabled: draft.enabled,
    };
  }
  return {
    name: draft.name,
    transport: "http",
    url: draft.url,
    bearerTokenEnvironmentVariable:
      draft.bearerTokenEnvironmentVariable.trim() || null,
    headers: parseMcpMapping(draft.headers),
    environmentHeaders: parseMcpMapping(draft.environmentHeaders),
    enabled: draft.enabled,
  };
}

function ServerRow({
  server,
  removing,
  onEdit,
  onRemove,
}: {
  server: McpServerSummary;
  removing: boolean;
  onEdit(): void;
  onRemove(): void;
}) {
  const detail =
    server.transport === "stdio"
      ? [server.command, ...server.args].join(" ")
      : server.url;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-3">
      <div className="flex min-w-0 items-start gap-2.5">
        <Server className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <p className="truncate text-sm font-medium">{server.name}</p>
            <Badge variant="secondary">{server.transport}</Badge>
            {!server.enabled ? <Badge variant="outline">Disabled</Badge> : null}
          </div>
          <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
            {detail}
          </p>
        </div>
      </div>
      <div className="flex items-center">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8"
          onClick={onEdit}
        >
          <Pencil className="size-3.5" />
          <span className="sr-only">Edit {server.name}</span>
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8"
          disabled={removing}
          onClick={onRemove}
        >
          {removing ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Trash2 className="size-3.5" />
          )}
          <span className="sr-only">Delete {server.name}</span>
        </Button>
      </div>
    </div>
  );
}

export function McpServerSettings({
  scope,
  className,
}: {
  scope: McpScope;
  className?: string;
}) {
  const queryClient = useQueryClient();
  const projectId = scope.kind === "project" ? scope.projectId : null;
  const queryKey = projectId
    ? (["mcp-servers", "project", projectId] as const)
    : (["mcp-servers", "global"] as const);
  const servers = useQuery({
    queryKey,
    queryFn: () =>
      projectId ? getProjectMcpServers(projectId) : getGlobalMcpServers(),
  });
  const workers = useQuery({ queryKey: ["workers"], queryFn: getWorkers });
  const inherited = useQuery({
    enabled: Boolean(projectId),
    queryKey: ["mcp-servers", "global"],
    queryFn: getGlobalMcpServers,
  });
  const projects = useQuery({
    enabled: Boolean(projectId),
    queryKey: ["projects"],
    queryFn: getProjects,
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<McpServerSummary | null>(null);
  const [draft, setDraft] = useState<ServerDraft>(emptyDraft);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [sourceProjectId, setSourceProjectId] = useState("");
  const [sourceServerId, setSourceServerId] = useState("");
  const sourceServers = useQuery({
    enabled: Boolean(copyOpen && sourceProjectId),
    queryKey: ["mcp-servers", "project", sourceProjectId],
    queryFn: () => getProjectMcpServers(sourceProjectId),
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey });
  };
  const save = useMutation({
    mutationFn: (input: McpServerConfiguration) => {
      if (projectId) {
        return editing
          ? updateProjectMcpServer(projectId, editing.id, input)
          : createProjectMcpServer(projectId, input);
      }
      return editing
        ? updateGlobalMcpServer(editing.id, input)
        : createGlobalMcpServer(input);
    },
    onSuccess: async () => {
      setDialogOpen(false);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (serverId: string) =>
      projectId
        ? deleteProjectMcpServer(projectId, serverId)
        : deleteGlobalMcpServer(serverId),
    onSuccess: refresh,
  });
  const copy = useMutation({
    mutationFn: () =>
      copyProjectMcpServer(projectId!, {
        sourceProjectId,
        sourceServerId,
      }),
    onSuccess: async () => {
      setCopyOpen(false);
      await refresh();
    },
  });

  const sourceProjects = useMemo(
    () =>
      (projects.data ?? []).filter(
        (project: ProjectSummary) => project.id !== projectId,
      ),
    [projectId, projects.data],
  );

  const openEditor = (server: McpServerSummary | null) => {
    setEditing(server);
    setDraft(draftFor(server));
    setDraftError(null);
    save.reset();
    setDialogOpen(true);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      setDraftError(null);
      save.mutate(configurationFor(draft));
    } catch (error) {
      setDraftError(errorText(error));
    }
  };

  return (
    <section className={cn("divide-y border-y", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <Cable className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <h2 className="text-sm font-semibold">MCP servers</h2>
            <p className="text-xs text-muted-foreground">
              {projectId
                ? "Local servers apply only to this project and override inherited names."
                : "Global servers are available to Codex in every project."}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {projectId ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                const firstProject = sourceProjects[0]?.id ?? "";
                setSourceProjectId(firstProject);
                setSourceServerId("");
                copy.reset();
                setCopyOpen(true);
              }}
            >
              <Copy className="size-3.5" /> Copy from project
            </Button>
          ) : null}
          <Button type="button" size="sm" onClick={() => openEditor(null)}>
            <Plus className="size-3.5" /> Add server
          </Button>
        </div>
      </div>

      {projectId && inherited.data?.length ? (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-xs text-muted-foreground">
          <span>Inherited from Settings:</span>
          {inherited.data.map((server) => (
            <Badge key={server.id} variant="outline">
              {server.name}
              {servers.data?.some((local) => local.name === server.name)
                ? " · overridden"
                : ""}
            </Badge>
          ))}
        </div>
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <Braces className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <p className="truncate text-sm font-medium">CodeGraph</p>
              <Badge variant="secondary">Managed</Badge>
              <Badge variant="outline">Read only</Badge>
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              Automatically injected for authorized worker-backed worktrees ·{" "}
              {
                (workers.data ?? []).filter(
                  ({ codegraph }) => codegraph.mcpInjectionAvailable,
                ).length
              }
              /{workers.data?.length ?? 0} workers ready
            </p>
          </div>
        </div>
        <Badge
          variant={
            (workers.data ?? []).some(
              ({ codegraph }) => codegraph.mcpInjectionAvailable,
            )
              ? "secondary"
              : "outline"
          }
        >
          {(workers.data ?? []).some(
            ({ codegraph }) => codegraph.mcpInjectionAvailable,
          )
            ? "Available"
            : "Unavailable"}
        </Badge>
      </div>

      {servers.isLoading ? (
        <div className="flex items-center gap-2 px-3 py-5 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading MCP servers…
        </div>
      ) : servers.isError ? (
        <p className="px-3 py-4 text-sm text-destructive">
          {errorText(servers.error)}
        </p>
      ) : servers.data?.length ? (
        <div className="divide-y">
          {servers.data.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              removing={remove.isPending && remove.variables === server.id}
              onEdit={() => openEditor(server)}
              onRemove={() => remove.mutate(server.id)}
            />
          ))}
        </div>
      ) : (
        <p className="px-3 py-5 text-sm text-muted-foreground">
          {projectId
            ? "No project-local MCP servers. Global servers still apply."
            : "No global MCP servers configured."}
        </p>
      )}

      {remove.isError ? (
        <p className="px-3 py-3 text-sm text-destructive">
          {errorText(remove.error)}
        </p>
      ) : null}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl">
          <form className="grid gap-5" onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>
                {editing ? "Edit MCP server" : "Add MCP server"}
              </DialogTitle>
              <DialogDescription>
                Configure a local command over stdio or a streamable HTTP
                endpoint.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Name"
                hint="Letters, numbers, hyphens, and underscores."
              >
                <Input
                  value={draft.name}
                  required
                  maxLength={100}
                  placeholder="github"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field label="Transport">
                <select
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none ring-ring focus:ring-2"
                  value={draft.transport}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      transport: event.target.value as ServerDraft["transport"],
                    }))
                  }
                >
                  <option value="stdio">Local command (stdio)</option>
                  <option value="http">Streamable HTTP</option>
                </select>
              </Field>
            </div>
            {draft.transport === "stdio" ? (
              <>
                <Field label="Command">
                  <Input
                    value={draft.command}
                    required
                    placeholder="npx"
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        command: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field
                  label="Arguments"
                  hint="One argument per line; quoting is not required."
                >
                  <textarea
                    className={textareaClass}
                    value={draft.args}
                    placeholder={"-y\n@modelcontextprotocol/server-github"}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        args: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field
                  label="Environment"
                  hint="One NAME=value pair per line. Values are passed only to the MCP process."
                >
                  <textarea
                    className={textareaClass}
                    value={draft.environment}
                    placeholder="GITHUB_PERSONAL_ACCESS_TOKEN=…"
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        environment: event.target.value,
                      }))
                    }
                  />
                </Field>
              </>
            ) : (
              <>
                <Field label="URL">
                  <Input
                    type="url"
                    required
                    value={draft.url}
                    placeholder="https://example.com/mcp"
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        url: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field
                  label="Bearer token environment variable"
                  hint="Optional variable name; the secret stays in the worker environment."
                >
                  <Input
                    value={draft.bearerTokenEnvironmentVariable}
                    placeholder="MCP_API_TOKEN"
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        bearerTokenEnvironmentVariable: event.target.value,
                      }))
                    }
                  />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="Static headers"
                    hint="One NAME=value pair per line."
                  >
                    <textarea
                      className={textareaClass}
                      value={draft.headers}
                      placeholder="X-Organization=team"
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          headers: event.target.value,
                        }))
                      }
                    />
                  </Field>
                  <Field
                    label="Headers from environment"
                    hint="HEADER=ENV_VARIABLE per line."
                  >
                    <textarea
                      className={textareaClass}
                      value={draft.environmentHeaders}
                      placeholder="Authorization=MCP_AUTH_HEADER"
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          environmentHeaders: event.target.value,
                        }))
                      }
                    />
                  </Field>
                </div>
              </>
            )}
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={draft.enabled}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    enabled: event.target.checked,
                  }))
                }
              />
              Enabled
            </label>
            {draftError || save.isError ? (
              <p className="text-sm text-destructive">
                {draftError ?? errorText(save.error)}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                {editing ? "Save changes" : "Add server"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={copyOpen} onOpenChange={setCopyOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy MCP server</DialogTitle>
            <DialogDescription>
              Copy a project-local configuration into this project. The new copy
              can be edited independently.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <Field label="Source project">
              <select
                className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none ring-ring focus:ring-2"
                value={sourceProjectId}
                onChange={(event) => {
                  setSourceProjectId(event.target.value);
                  setSourceServerId("");
                }}
              >
                <option value="">Choose a project</option>
                {sourceProjects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="MCP server">
              <select
                className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none ring-ring focus:ring-2"
                value={sourceServerId}
                disabled={!sourceProjectId || sourceServers.isLoading}
                onChange={(event) => setSourceServerId(event.target.value)}
              >
                <option value="">Choose a server</option>
                {(sourceServers.data ?? []).map((server) => (
                  <option key={server.id} value={server.id}>
                    {server.name} · {server.transport}
                  </option>
                ))}
              </select>
            </Field>
            {sourceProjectId &&
            !sourceServers.isLoading &&
            !sourceServers.data?.length ? (
              <p className="text-sm text-muted-foreground">
                This project has no local MCP servers to copy.
              </p>
            ) : null}
            {copy.isError ? (
              <p className="text-sm text-destructive">
                {errorText(copy.error)}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setCopyOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!sourceProjectId || !sourceServerId || copy.isPending}
              onClick={() => copy.mutate()}
            >
              {copy.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Copy className="size-4" />
              )}
              Copy server
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
