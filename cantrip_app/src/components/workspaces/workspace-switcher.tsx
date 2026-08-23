import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import type { ProjectWorkspaceSummary } from "@cantrip/protocol";
import { Check, ChevronDown, Layers3, Plus, Settings } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  ProjectCreateMenu,
  type ProjectCreateSource,
} from "@/components/projects/project-create-menu";
import { WorkspaceCreateDialog } from "@/components/workspaces/workspace-create-dialog";

const itemClass =
  "flex cursor-default select-none items-center gap-2 rounded-md px-2 py-2 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground";

export function WorkspaceSwitcher({
  activeWorkspaceId,
  onAddProject,
  onCreate,
  onManage,
  onSelect,
  workspaces,
}: {
  activeWorkspaceId: string | null;
  onAddProject(source: ProjectCreateSource): void;
  onCreate(name: string): Promise<void>;
  onManage(): void;
  onSelect(workspaceId: string): void;
  workspaces: ProjectWorkspaceSummary[];
}) {
  const active =
    workspaces.find(({ id }) => id === activeWorkspaceId) ??
    workspaces.find(({ isDefault }) => isDefault) ??
    null;
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
      <div className="flex min-w-0 items-center gap-1">
        <DropdownMenuPrimitive.Root>
          <DropdownMenuPrimitive.Trigger asChild>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Layers3 className="size-3.5 shrink-0" />
              <span className="truncate">{active?.name ?? "Workspace"}</span>
              <ChevronDown className="ml-auto size-3.5 shrink-0" />
            </button>
          </DropdownMenuPrimitive.Trigger>
          <DropdownMenuPrimitive.Portal>
            <DropdownMenuPrimitive.Content
              align="start"
              sideOffset={4}
              className="z-[80] min-w-64 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
            >
              <DropdownMenuPrimitive.Label className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Workspaces
              </DropdownMenuPrimitive.Label>
              {workspaces.map((workspace) => (
                <DropdownMenuPrimitive.Item
                  key={workspace.id}
                  className={itemClass}
                  onSelect={() => onSelect(workspace.id)}
                >
                  <Layers3 className="size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">
                    {workspace.name}
                  </span>
                  <span className="text-[10px] tabular-nums text-muted-foreground">
                    {workspace.projectIds.length}
                  </span>
                  {workspace.id === active?.id ? (
                    <Check className="size-4" />
                  ) : null}
                </DropdownMenuPrimitive.Item>
              ))}
              <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
              <DropdownMenuPrimitive.Item
                className={itemClass}
                onSelect={() => {
                  setDialogOpen(true);
                }}
              >
                <Plus className="size-4" /> Workspace
              </DropdownMenuPrimitive.Item>
              <DropdownMenuPrimitive.Item
                className={itemClass}
                onSelect={onManage}
              >
                <Settings className="size-4" /> Manage workspaces
              </DropdownMenuPrimitive.Item>
            </DropdownMenuPrimitive.Content>
          </DropdownMenuPrimitive.Portal>
        </DropdownMenuPrimitive.Root>
        <ProjectCreateMenu onSelect={onAddProject}>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7 shrink-0"
            aria-label={`Add project to ${active?.name ?? "current workspace"}`}
          >
            <Plus className="size-4" />
            <span className="sr-only">
              Add project to {active?.name ?? "current workspace"}
            </span>
          </Button>
        </ProjectCreateMenu>
      </div>

      <WorkspaceCreateDialog
        onCreate={onCreate}
        onOpenChange={setDialogOpen}
        open={dialogOpen}
      />
    </>
  );
}
