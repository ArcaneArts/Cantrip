import type {
  ProjectSummary,
  ProjectWorkspaceSummary,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FolderGit2,
  Layers3,
  Loader2,
  Pencil,
  Plus,
  Star,
  Trash2,
} from "lucide-react";
import { useState, type FormEvent } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  createProjectWorkspace,
  deleteProjectWorkspace,
  getProjects,
  getProjectWorkspaces,
  updateProjectWorkspace,
} from "@/lib/api";
import { errorMessage } from "@/lib/error-message";

function message(error: unknown): string {
  return errorMessage(error, "Workspace update failed.");
}

export function promoteDefaultWorkspace(
  workspaces: ProjectWorkspaceSummary[],
  promoted: ProjectWorkspaceSummary,
): ProjectWorkspaceSummary[] {
  return workspaces.map((workspace) =>
    workspace.id === promoted.id
      ? promoted
      : workspace.isDefault
        ? { ...workspace, isDefault: false }
        : workspace,
  );
}

export function WorkspaceSettings() {
  const queryClient = useQueryClient();
  const projects = useQuery({ queryFn: getProjects, queryKey: ["projects"] });
  const workspaces = useQuery({
    queryFn: getProjectWorkspaces,
    queryKey: ["project-workspaces"],
  });
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ProjectWorkspaceSummary | null>(null);
  const [name, setName] = useState("");
  const [deleteTarget, setDeleteTarget] =
    useState<ProjectWorkspaceSummary | null>(null);

  const replaceWorkspace = (workspace: ProjectWorkspaceSummary) =>
    queryClient.setQueryData<ProjectWorkspaceSummary[]>(
      ["project-workspaces"],
      (current = []) =>
        current.some(({ id }) => id === workspace.id)
          ? current.map((item) => (item.id === workspace.id ? workspace : item))
          : [...current, workspace],
    );

  const save = useMutation({
    mutationFn: () =>
      editing
        ? updateProjectWorkspace(editing.id, { name: name.trim() })
        : createProjectWorkspace({ name: name.trim() }),
    onSuccess: (workspace) => {
      replaceWorkspace(workspace);
      setEditorOpen(false);
      setEditing(null);
      setName("");
    },
  });
  const membership = useMutation({
    mutationFn: ({
      projectIds,
      workspaceId,
    }: {
      projectIds: string[];
      workspaceId: string;
    }) => updateProjectWorkspace(workspaceId, { projectIds }),
    onSuccess: replaceWorkspace,
  });
  const makeDefault = useMutation({
    mutationFn: (workspaceId: string) =>
      updateProjectWorkspace(workspaceId, { isDefault: true }),
    onSuccess: (workspace) => {
      queryClient.setQueryData<ProjectWorkspaceSummary[]>(
        ["project-workspaces"],
        (current = []) => promoteDefaultWorkspace(current, workspace),
      );
      void queryClient.invalidateQueries({
        queryKey: ["project-workspaces"],
      });
    },
  });
  const remove = useMutation({
    mutationFn: deleteProjectWorkspace,
    onSuccess: (_value, workspaceId) => {
      queryClient.setQueryData<ProjectWorkspaceSummary[]>(
        ["project-workspaces"],
        (current = []) => current.filter(({ id }) => id !== workspaceId),
      );
      setDeleteTarget(null);
    },
  });

  const openEditor = (workspace: ProjectWorkspaceSummary | null) => {
    save.reset();
    setEditing(workspace);
    setName(workspace?.name ?? "");
    setEditorOpen(true);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim()) save.mutate();
  };

  if ((projects.isLoading || workspaces.isLoading) && !workspaces.data) {
    return (
      <div className="grid min-h-48 place-items-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  return (
    <>
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-base font-semibold">Workspaces</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              Filter the sidebar without duplicating projects, repositories, or
              worktrees.
            </p>
          </div>
          <Button size="sm" onClick={() => openEditor(null)}>
            <Plus className="size-4" /> Workspace
          </Button>
        </div>

        {workspaces.isError || projects.isError ? (
          <p className="text-sm text-destructive">
            {message(workspaces.error ?? projects.error)}
          </p>
        ) : null}

        <div className="divide-y border-y">
          {(workspaces.data ?? []).map((workspace) => (
            <section key={workspace.id}>
              <div className="flex items-center gap-3 px-3 py-3">
                <span className="grid size-8 place-items-center text-muted-foreground">
                  <Layers3 className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-sm font-semibold">
                      {workspace.name}
                    </h2>
                    {workspace.isDefault ? (
                      <Badge variant="secondary">Default</Badge>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {workspace.projectIds.length} project
                    {workspace.projectIds.length === 1 ? "" : "s"}
                  </p>
                </div>
                {!workspace.isDefault ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={makeDefault.isPending}
                    onClick={() => makeDefault.mutate(workspace.id)}
                    title={`Make ${workspace.name} the default workspace`}
                  >
                    <Star className="size-3.5" />
                    <span className="hidden sm:inline">Make default</span>
                  </Button>
                ) : null}
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  onClick={() => openEditor(workspace)}
                >
                  <Pencil className="size-3.5" />
                  <span className="sr-only">Rename {workspace.name}</span>
                </Button>
                {!workspace.isDefault ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-8"
                    onClick={() => setDeleteTarget(workspace)}
                  >
                    <Trash2 className="size-3.5" />
                    <span className="sr-only">Delete {workspace.name}</span>
                  </Button>
                ) : null}
              </div>
              <div className="border-t p-2">
                {(projects.data ?? []).length ? (
                  <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                    {(projects.data ?? []).map((project: ProjectSummary) => {
                      const checked = workspace.projectIds.includes(project.id);
                      return (
                        <label
                          key={project.id}
                          className="flex cursor-pointer items-center gap-2 px-2 py-2 text-sm hover:bg-muted/50"
                        >
                          <input
                            type="checkbox"
                            className="size-3.5 accent-primary"
                            checked={checked}
                            disabled={membership.isPending}
                            onChange={(event) => {
                              const ids = new Set(workspace.projectIds);
                              if (event.target.checked) ids.add(project.id);
                              else ids.delete(project.id);
                              membership.mutate({
                                workspaceId: workspace.id,
                                projectIds: [...ids],
                              });
                            }}
                          />
                          <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate">{project.name}</span>
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <p className="px-2 py-4 text-center text-sm text-muted-foreground">
                    Import a project before assigning workspace visibility.
                  </p>
                )}
              </div>
            </section>
          ))}
        </div>

        {membership.isError || makeDefault.isError || remove.isError ? (
          <p className="text-sm text-destructive">
            {message(membership.error ?? makeDefault.error ?? remove.error)}
          </p>
        ) : null}
      </div>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent>
          <form className="grid gap-5" onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>
                {editing ? "Rename workspace" : "New workspace"}
              </DialogTitle>
              <DialogDescription>
                A workspace is only a project visibility filter.
              </DialogDescription>
            </DialogHeader>
            <label className="grid gap-2 text-sm">
              Name
              <Input
                autoFocus
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Organization Company 1"
              />
            </label>
            {save.isError ? (
              <p className="text-sm text-destructive">{message(save.error)}</p>
            ) : null}
            <DialogFooter>
              <Button disabled={!name.trim() || save.isPending} type="submit">
                {save.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                {editing ? "Save" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleteTarget?.name}?</DialogTitle>
            <DialogDescription>
              Projects, repositories, tabs, and files are not deleted. This
              removes only the workspace filter and its memberships.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={remove.isPending}
              onClick={() => {
                if (deleteTarget) remove.mutate(deleteTarget.id);
              }}
            >
              Delete workspace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
