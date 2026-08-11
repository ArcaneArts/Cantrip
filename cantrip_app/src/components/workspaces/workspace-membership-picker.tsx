import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import type { ProjectWorkspaceSummary } from "@cantrip/protocol";
import { Check, Layers3, Plus } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function WorkspaceMembershipPicker({
  requiredWorkspaceId,
  selectedIds,
  trailingAction,
  onChange,
  workspaces,
}: {
  requiredWorkspaceId: string;
  selectedIds: ReadonlySet<string>;
  trailingAction?: ReactNode;
  onChange(ids: Set<string>): void;
  workspaces: ProjectWorkspaceSummary[];
}) {
  const selected = workspaces.filter(({ id }) => selectedIds.has(id));
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-xs text-muted-foreground">Import into</span>
      {selected.map((workspace) => (
        <Badge key={workspace.id} variant="secondary" className="gap-1.5">
          <Layers3 className="size-3" />
          {workspace.name}
        </Badge>
      ))}
      <DropdownMenuPrimitive.Root>
        <DropdownMenuPrimitive.Trigger asChild>
          <Button
            size="icon"
            variant="outline"
            className="size-6 rounded-full"
            title="Add another workspace"
          >
            <Plus className="size-3" />
            <span className="sr-only">Add another workspace</span>
          </Button>
        </DropdownMenuPrimitive.Trigger>
        <DropdownMenuPrimitive.Portal>
          <DropdownMenuPrimitive.Content
            align="start"
            sideOffset={4}
            className="z-[80] min-w-52 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
          >
            <DropdownMenuPrimitive.Label className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Project visibility
            </DropdownMenuPrimitive.Label>
            {workspaces.map((workspace) => {
              const checked = selectedIds.has(workspace.id);
              const required = workspace.id === requiredWorkspaceId;
              return (
                <DropdownMenuPrimitive.CheckboxItem
                  key={workspace.id}
                  checked={checked}
                  disabled={required}
                  onCheckedChange={(next) => {
                    const ids = new Set(selectedIds);
                    if (next) ids.add(workspace.id);
                    else ids.delete(workspace.id);
                    ids.add(requiredWorkspaceId);
                    onChange(ids);
                  }}
                  onSelect={(event) => event.preventDefault()}
                  className="flex cursor-default select-none items-center gap-2 rounded-md px-2 py-2 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent"
                >
                  <span className="grid size-4 place-items-center">
                    {checked ? <Check className="size-3.5" /> : null}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {workspace.name}
                  </span>
                  {required ? (
                    <span className="text-[10px] text-muted-foreground">
                      Current
                    </span>
                  ) : null}
                </DropdownMenuPrimitive.CheckboxItem>
              );
            })}
          </DropdownMenuPrimitive.Content>
        </DropdownMenuPrimitive.Portal>
      </DropdownMenuPrimitive.Root>
      {trailingAction ? (
        <div className="ml-auto pl-3">{trailingAction}</div>
      ) : null}
    </div>
  );
}
