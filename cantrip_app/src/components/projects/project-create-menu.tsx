import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Folder, FolderGit2 } from "lucide-react";
import type { ReactNode } from "react";

import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from "@/components/ui/styled-menu";

export type ProjectCreateSource = "folder" | "github";

export function ProjectCreateMenu({
  children,
  onSelect,
}: {
  children: ReactNode;
  onSelect(source: ProjectCreateSource): void;
}) {
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        {children}
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <StyledDropdownMenuContent
          align="end"
          className="min-w-52"
          sideOffset={4}
        >
          <StyledDropdownMenuItem onSelect={() => onSelect("github")}>
            <FolderGit2 className="size-4" />
            GitHub repository
          </StyledDropdownMenuItem>
          <StyledDropdownMenuItem onSelect={() => onSelect("folder")}>
            <Folder className="size-4" />
            Folder
          </StyledDropdownMenuItem>
        </StyledDropdownMenuContent>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
