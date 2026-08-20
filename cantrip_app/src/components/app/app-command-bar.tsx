import type {
  ProjectSummary,
  ProjectWorkspaceSummary,
} from "@cantrip/protocol";
import { Command as CommandPrimitive } from "cmdk";
import {
  Bot,
  Check,
  CornerDownLeft,
  Folder,
  FolderGit2,
  Search,
  SquareTerminal,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  APP_ACTION_IDS,
  availableAppActions,
  type AppActionContext,
  type AppActionId,
} from "@/lib/app-actions";
import { advanceDoubleShiftGesture } from "@/lib/command-bar";

function projectMemberships(
  projectId: string,
  workspaces: readonly ProjectWorkspaceSummary[],
): ProjectWorkspaceSummary[] {
  return workspaces.filter(({ projectIds }) => projectIds.includes(projectId));
}

function projectDetail(
  project: ProjectSummary,
  memberships: readonly ProjectWorkspaceSummary[],
): string {
  const source =
    project.source?.displayPath ??
    project.github?.nameWithOwner ??
    (project.originKind === "managed-folder"
      ? "Worker-bound folder"
      : "GitHub repository");
  const workspaceNames = memberships.map(({ name }) => name).join(", ");
  return workspaceNames ? `${source} · ${workspaceNames}` : source;
}

function AppActionIcon({ actionId }: { actionId: AppActionId }) {
  return actionId === APP_ACTION_IDS.newAgentChat ? (
    <Bot className="size-4" />
  ) : (
    <SquareTerminal className="size-4" />
  );
}

export function AppCommandBar({
  context,
  currentProjectId,
  onAction,
  onOpenChange,
  onSelectProject,
  open,
  projects,
  workspaces,
}: {
  context: AppActionContext;
  currentProjectId: string | null;
  onAction(actionId: AppActionId): void;
  onOpenChange(open: boolean): void;
  onSelectProject(projectId: string): void;
  open: boolean;
  projects: readonly ProjectSummary[];
  workspaces: readonly ProjectWorkspaceSummary[];
}) {
  const [query, setQuery] = useState("");
  const lastShiftAtRef = useRef<number | null>(null);
  const actions = useMemo(() => availableAppActions(context), [context]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) {
        lastShiftAtRef.current = null;
        return;
      }
      const result = advanceDoubleShiftGesture(
        lastShiftAtRef.current,
        event,
        performance.now(),
      );
      lastShiftAtRef.current = result.lastShiftAt;
      if (!result.triggered) return;
      event.preventDefault();
      onOpenChange(true);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onOpenChange]);

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const runAction = (actionId: AppActionId) => {
    onOpenChange(false);
    onAction(actionId);
  };
  const selectProject = (projectId: string) => {
    onOpenChange(false);
    onSelectProject(projectId);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="top-[15vh] flex max-h-[70vh] max-w-2xl -translate-y-0 flex-col gap-0 overflow-hidden p-0"
        showClose={false}
      >
        <DialogTitle className="sr-only">Cantrip command bar</DialogTitle>
        <DialogDescription className="sr-only">
          Search available actions or switch to a project.
        </DialogDescription>
        <Command loop>
          <div className="flex h-16 shrink-0 items-center gap-3 border-b px-5">
            <Search className="size-5 shrink-0 text-muted-foreground" />
            <CommandPrimitive.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              className="min-w-0 flex-1 bg-transparent text-lg outline-none placeholder:text-muted-foreground"
              placeholder="Search actions and projects…"
              aria-label="Search actions and projects"
            />
            <kbd className="hidden rounded-md border bg-muted/60 px-2 py-1 text-[10px] text-muted-foreground sm:inline-flex">
              shift shift
            </kbd>
          </div>
          <CommandList className="min-h-32 flex-1 overscroll-contain overflow-y-auto p-2">
            <CommandEmpty>No matching actions or projects.</CommandEmpty>
            {actions.length > 0 ? (
              <CommandGroup heading="Actions">
                {actions.map((action) => (
                  <CommandItem
                    key={action.id}
                    value={`action ${action.label} ${action.keywords.join(" ")}`}
                    className="gap-3 rounded-lg px-3 py-2.5"
                    onSelect={() => runAction(action.id)}
                  >
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                      <AppActionIcon actionId={action.id} />
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {action.label}
                    </span>
                    <kbd className="shrink-0 rounded border bg-background/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {action.shortcut.label}
                    </kbd>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {projects.length > 0 ? (
              <CommandGroup heading="Projects">
                {projects.map((project) => {
                  const memberships = projectMemberships(
                    project.id,
                    workspaces,
                  );
                  const detail = projectDetail(project, memberships);
                  const current = project.id === currentProjectId;
                  return (
                    <CommandItem
                      key={project.id}
                      value={`project ${project.name} ${detail} ${project.id}`}
                      className="gap-3 rounded-lg px-3 py-2.5"
                      onSelect={() => selectProject(project.id)}
                    >
                      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                        {project.originKind === "github" ? (
                          <FolderGit2 className="size-4" />
                        ) : (
                          <Folder className="size-4" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {project.name}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {detail}
                        </span>
                      </span>
                      {project.setupStatus !== "ready" ? (
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] capitalize text-muted-foreground">
                          {project.setupStatus}
                        </span>
                      ) : current ? (
                        <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
                          <Check className="size-3" /> Current
                        </span>
                      ) : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
        <div className="flex min-h-9 shrink-0 items-center justify-between gap-3 border-t px-4 text-[11px] text-muted-foreground">
          <span>Actions adapt to the current view</span>
          <span className="hidden items-center gap-3 sm:flex">
            <span>↑↓ Navigate</span>
            <span className="flex items-center gap-1">
              <CornerDownLeft className="size-3" /> Select
            </span>
            <span>esc Close</span>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
