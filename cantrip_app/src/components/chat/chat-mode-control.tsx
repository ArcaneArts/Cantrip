import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ChatTurnMode } from "@cantrip/protocol";
import { Check, ListChecks, Sparkles, Target } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from "@/components/ui/styled-menu";
import { cn } from "@/lib/utils";

const chatModeOptions = [
  { icon: Sparkles, label: "Default", mode: "default" },
  { icon: ListChecks, label: "Plan", mode: "plan" },
  { icon: Target, label: "Goal", mode: "goal" },
] as const satisfies readonly {
  icon: typeof Sparkles;
  label: string;
  mode: ChatTurnMode;
}[];

export function ChatModeControl({
  disabled,
  mode,
  onChange,
}: {
  disabled: boolean;
  mode: ChatTurnMode;
  onChange(mode: ChatTurnMode): void;
}) {
  const activeMode =
    chatModeOptions.find((option) => option.mode === mode) ??
    chatModeOptions[0];
  const ActiveIcon = activeMode.icon;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className={cn(
            "size-7 shrink-0 text-muted-foreground",
            mode === "plan" && "text-sky-600 dark:text-sky-400",
            mode === "goal" && "text-violet-600 dark:text-violet-400",
          )}
          disabled={disabled}
          aria-label={`Message mode: ${activeMode.label}`}
          title={`Message mode: ${activeMode.label}`}
        >
          <ActiveIcon className="size-3.5" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <StyledDropdownMenuContent
          align="end"
          side="top"
          sideOffset={6}
          className="min-w-32"
        >
          {chatModeOptions.map((option) => {
            const Icon = option.icon;
            return (
              <StyledDropdownMenuItem
                key={option.mode}
                onSelect={() => onChange(option.mode)}
              >
                <Icon className="size-4" />
                <span className="flex-1">{option.label}</span>
                {mode === option.mode ? <Check className="size-3.5" /> : null}
              </StyledDropdownMenuItem>
            );
          })}
        </StyledDropdownMenuContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
