import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from "@/components/ui/styled-menu";
export function ConversationRowMenu({
  title,
  pending,
  archive,
  rename,
  fork,
  place,
  restore,
  remove,
}: {
  title: string;
  pending: boolean;
  archive?: () => void;
  rename?: () => void;
  fork?: () => void;
  place?: (region: "center" | "right" | "bottom") => void;
  restore?: () => void;
  remove?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const button = trigger.current;
    const openMenu = () => {
      if (!button?.disabled) {
        button?.focus();
        setOpen(true);
      }
    };
    button?.addEventListener("cantrip:open-conversation-menu", openMenu);
    return () =>
      button?.removeEventListener("cantrip:open-conversation-menu", openMenu);
  }, []);
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          ref={trigger}
          type="button"
          disabled={pending}
          data-conversation-menu=""
          aria-label={`Actions for ${title}`}
          className="grid size-7 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <StyledDropdownMenuContent align="end">
          {rename ? (
            <StyledDropdownMenuItem onSelect={rename}>
              Rename
            </StyledDropdownMenuItem>
          ) : null}
          {fork ? (
            <StyledDropdownMenuItem onSelect={fork}>
              Fork
            </StyledDropdownMenuItem>
          ) : null}
          {place
            ? (
                [
                  ["center", "Place in top rail"],
                  ["right", "Place in right rail"],
                  ["bottom", "Place in bottom rail"],
                ] as const
              ).map(([region, label]) => (
                <StyledDropdownMenuItem
                  key={region}
                  onSelect={() => place(region)}
                >
                  {label}
                </StyledDropdownMenuItem>
              ))
            : null}
          {archive ? (
            <StyledDropdownMenuItem onSelect={archive}>
              Archive
            </StyledDropdownMenuItem>
          ) : null}
          {restore ? (
            <StyledDropdownMenuItem onSelect={restore}>
              Restore
            </StyledDropdownMenuItem>
          ) : null}
          {remove ? (
            <StyledDropdownMenuItem
              onSelect={remove}
              className="text-destructive focus:text-destructive"
            >
              Permanently Delete
            </StyledDropdownMenuItem>
          ) : null}
        </StyledDropdownMenuContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function openConversationRowMenu(element: HTMLElement) {
  element
    .closest("[data-conversation-row]")
    ?.querySelector<HTMLButtonElement>("[data-conversation-menu]")
    ?.dispatchEvent(new Event("cantrip:open-conversation-menu"));
}
