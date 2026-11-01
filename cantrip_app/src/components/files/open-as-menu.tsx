import * as ContextMenu from "@radix-ui/react-context-menu";
import { ChevronRight } from "lucide-react";
import {
  StyledContextMenuItem,
  styledMenuItemClass,
  styledMenuContentClass,
} from "@/components/ui/styled-menu";
import { FILE_VIEWERS } from "./file-viewers";
import { FileTypeIcon } from "./file-type-icon";

export function OpenAsMenu({
  onSelect,
}: {
  onSelect(viewer: string | null): void;
}) {
  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger className={styledMenuItemClass}>
        Open As <ChevronRight className="ml-auto size-4" />
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent
          className={`${styledMenuContentClass} max-h-[70vh] min-w-48 overflow-auto`}
        >
          <StyledContextMenuItem onSelect={() => onSelect(null)}>
            Automatic
          </StyledContextMenuItem>
          <ContextMenu.Separator className="my-1 h-px bg-border" />
          {FILE_VIEWERS.map((viewer) => (
            <StyledContextMenuItem
              key={viewer.id}
              onSelect={() => onSelect(viewer.id)}
            >
              <FileTypeIcon
                path={`file.${viewer.syntaxExtension ?? viewer.id}`}
                iconKind={viewer.icon}
                className="size-4"
              />
              {viewer.label}
            </StyledContextMenuItem>
          ))}
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}
