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
  ShieldCheck,
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
import { getProjects } from "@/lib/project-encryption";
import {
  createProjectWorkspace,
  deleteProjectWorkspace,
  getProjectWorkspaces,
  updateProjectWorkspace,
} from "@/lib/workspace-encryption";
import { errorMessage } from "@/lib/error-message";
import { PolicyAssignmentControls } from "./policy-assignment-controls";

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

export function WorkspaceSettings({
  onOpenPolicySettings,
}: {
  onOpenPolicySettings?(policyId?: string): void;
}) {
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
  const [policyWorkspaceId, setPolicyWorkspaceId] = useState<string | null>(
    null,
  );

  const replaceWorkspace = (workspace: ProjectWorkspaceSummary) => {
    queryClient.setQueryData<ProjectWorkspaceSummary[]>(
      ["project-workspaces"],
      (current = []) =>
        current.some(({ id }) => id === workspace.id)
          ? current.map((item) => (item.id === workspace.id ? workspace : item))
          : [...current, workspace],
    );
    void queryClient.invalidateQueries({ queryKey: ["effective-policies"] });
  };

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
      void queryClient.invalidateQueries({ queryKey: ["effective-policies"] });
      setPolicyWorkspaceId((current) =>
        current === workspaceId ? null : current,
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

  const workspaceByProjectId = new Map<string, ProjectWorkspaceSummary>();
  for (const workspace of workspaces.data ?? []) {
    for (const projectId of workspace.projectIds) {
      workspaceByProjectId.set(projectId, workspace);
    }
  }

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
              Organize each project in one permanent workspace.
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

        <section className="grid gap-3">
          <div>
            <h2 className="text-sm font-semibold">Workspace management</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Rename workspaces, choose the default for new projects, and
              configure policies.
            </p>
          </div>
          <div className="divide-y border-y">
            {(workspaces.data ?? []).map((workspace) => (
              <div key={workspace.id}>
                <div className="flex flex-wrap items-center gap-3 px-3 py-3">
                  <span className="grid size-8 place-items-center text-muted-foreground">
                    <Layers3 className="size-4" />
                  </span>
                  <div className="min-w-40 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-sm font-semibold">
                        {workspace.name}
                      </h3>
                      {workspace.isDefault ? (
                        <Badge variant="secondary">Default</Badge>
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {workspace.projectIds.length} project
                      {workspace.projectIds.length === 1 ? "" : "s"}
                    </p>
                  </div>
                  <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
                    <Button
                      size="sm"
                      variant={
                        policyWorkspaceId === workspace.id ? "outline" : "ghost"
                      }
                      aria-expanded={policyWorkspaceId === workspace.id}
                      onClick={() =>
                        setPolicyWorkspaceId((current) =>
                          current === workspace.id ? null : workspace.id,
                        )
                      }
                    >
                      <ShieldCheck className="size-3.5" /> Policies
                    </Button>
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
                </div>
                {policyWorkspaceId === workspace.id ? (
                  <div className="border-t bg-muted/[0.025] p-3">
                    <PolicyAssignmentControls
                      scope={{
                        kind: "workspace",
                        id: workspace.id,
                        name: workspace.name,
                      }}
                      onEditPolicy={onOpenPolicySettings}
                      onManagePolicies={onOpenPolicySettings}
                    />
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </section>

        <section className="grid gap-3 pt-2">
          <div>
            <h2 className="text-sm font-semibold">Project workspaces</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              A project stays in the workspace where it was created or imported.
            </p>
          </div>
          {(projects.data ?? []).length ? (
            <div className="border-y">
              <table className="min-w-full border-collapse text-left text-sm">
                <thead className="bg-background text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th
                      scope="col"
                      className="sticky left-0 z-10 min-w-56 bg-background px-3 py-2 font-medium"
                    >
                      Project
                    </th>
                    <th scope="col" className="min-w-48 px-3 py-2 font-medium">
                      Workspace
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(projects.data ?? []).map((project: ProjectSummary) => (
                    <tr
                      key={project.id}
                      className="group border-b last:border-0"
                    >
                      <th
                        scope="row"
                        className="sticky left-0 z-[1] bg-background px-3 py-2.5 font-medium group-hover:bg-muted/30"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate">{project.name}</span>
                        </span>
                      </th>
                      <td className="px-3 py-2.5 text-muted-foreground group-hover:bg-muted/30">
                        {workspaceByProjectId.get(project.id)?.name ??
                          "Unavailable"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="border-y px-3 py-8 text-center text-sm text-muted-foreground">
              Add a project to see its workspace here.
            </p>
          )}
        </section>

        {makeDefault.isError || remove.isError ? (
          <p className="text-sm text-destructive">
            {message(makeDefault.error ?? remove.error)}
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
                Projects added here remain assigned to this workspace.
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
              Only an empty workspace can be deleted. Projects are never moved
              or deleted with a workspace.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteTarget) remove.mutate(deleteTarget.id);
              }}
              pending={remove.isPending}
              pendingLabel="Deleting…"
            >
              Delete workspace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
