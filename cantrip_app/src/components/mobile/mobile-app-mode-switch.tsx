import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Check,
  ChevronDown,
  Code2,
  MessageSquare,
  UsersRound,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from "@/components/ui/styled-menu";
import { TooltipButton, TooltipTarget } from "@/components/ui/tooltip";
import type { ShellAppMode } from "@/lib/app-mode";

const modes = [
  ["ide", "IDE", Code2],
  ["chat", "Chat", MessageSquare],
  ["council", "Council", UsersRound],
] as const;

export function MobileAppModeSwitch({
  currentMode,
  labeled = false,
  onChooseMode,
  onSwitch,
}: {
  currentMode: ShellAppMode;
  labeled?: boolean;
  onChooseMode?(mode: ShellAppMode): void;
  onSwitch(): void;
}) {
  if (onChooseMode) {
    const [, name, ModeIcon] =
      modes.find(([id]) => id === currentMode) ?? modes[0];
    return (
      <DropdownMenu.Root>
        <TooltipTarget
          tooltip={
            currentMode === "council" ? "Switch Cantrip mode" : undefined
          }
        >
          <DropdownMenu.Trigger asChild>
            <Button
              aria-label="Switch Cantrip mode"
              className="gap-1"
              size="sm"
              variant="ghost"
            >
              <ModeIcon className="size-4" />
              {labeled ? name : null}
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenu.Trigger>
        </TooltipTarget>
        <DropdownMenu.Portal>
          <StyledDropdownMenuContent align="end" className="min-w-44">
            {modes.map(([id, label, Icon]) => (
              <StyledDropdownMenuItem
                key={id}
                aria-current={id === currentMode ? "page" : undefined}
                className="justify-between"
                onSelect={() => onChooseMode(id)}
              >
                <span className="flex items-center gap-2">
                  <Icon className="size-4" /> Cantrip {label}
                </span>
                {id === currentMode ? <Check className="size-3.5" /> : null}
              </StyledDropdownMenuItem>
            ))}
          </StyledDropdownMenuContent>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    );
  }
  const switchingToChat = currentMode === "ide";
  const label = switchingToChat ? "Chats" : "IDE";
  const accessibleLabel = `Switch to ${label}`;
  const Icon = switchingToChat ? MessageSquare : Code2;

  return (
    <TooltipButton
      aria-label={accessibleLabel}
      className={labeled ? undefined : "size-9"}
      onClick={onSwitch}
      size={labeled ? "sm" : "icon"}
      tooltip={accessibleLabel}
      variant="ghost"
    >
      <Icon className="size-4" />
      {labeled ? label : null}
    </TooltipButton>
  );
}
