import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ChatPermissionProfileState } from "@cantrip/protocol";
import { Check, Loader2, Lock, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from "@/components/ui/styled-menu";
import { cn } from "@/lib/utils";

const PROFILE_LABELS: Record<string, string> = {
  ":read-only": "Read only",
  ":workspace": "Workspace",
  ":danger-full-access": "Full access",
  ":yolo": "YOLO mode",
};

export function permissionProfileLabel(id: string): string {
  return PROFILE_LABELS[id] ?? id.replace(/^:/, "");
}

function isUnrestrictedProfile(id: string): boolean {
  return id === ":danger-full-access" || id === ":yolo";
}

export function PermissionProfileControl({
  disabled,
  onChange,
  pending,
  state,
}: {
  disabled: boolean;
  onChange(id: string): void;
  pending: boolean;
  state: ChatPermissionProfileState | undefined;
}) {
  const available = state?.available === true;
  const allowed = state?.profiles.filter((profile) => profile.allowed) ?? [];
  const selectedLabel = state
    ? permissionProfileLabel(state.selectedId)
    : "Permissions";
  const title = !available
    ? (state?.reason ?? "Loading Codex permission profiles…")
    : state?.forcedByWorktreePolicy
      ? `${selectedLabel}; project policy forces ${permissionProfileLabel(state.effectiveId)} on Primary.`
      : selectedLabel;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className={cn(
            "size-7 shrink-0 text-muted-foreground",
            state &&
              isUnrestrictedProfile(state.effectiveId) &&
              "text-amber-600 dark:text-amber-400",
            state?.effectiveId === ":yolo" && "text-destructive",
          )}
          disabled={disabled || pending || !available || allowed.length === 0}
          aria-label={`Agent permissions: ${selectedLabel}`}
          title={title}
        >
          {pending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Lock className="size-3.5" />
          )}
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <StyledDropdownMenuContent
          align="end"
          side="top"
          sideOffset={6}
          className="w-72"
        >
          <DropdownMenu.Label className="px-2 py-1 text-xs font-medium text-muted-foreground">
            Agent permissions
          </DropdownMenu.Label>
          {allowed.map((profile) => {
            const yolo = profile.id === ":yolo";
            const unrestricted = isUnrestrictedProfile(profile.id);
            return (
              <StyledDropdownMenuItem
                key={profile.id}
                className={cn(
                  "items-start",
                  yolo && "text-destructive focus:text-destructive",
                )}
                onSelect={() => onChange(profile.id)}
              >
                {unrestricted ? (
                  <ShieldAlert className="mt-0.5 size-4 shrink-0" />
                ) : (
                  <Lock className="mt-0.5 size-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">
                    {permissionProfileLabel(profile.id)}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {yolo
                      ? "Unrestricted access and never ask for approval."
                      : profile.description}
                  </span>
                </span>
                {state?.selectedId === profile.id ? (
                  <Check className="mt-0.5 size-3.5 shrink-0" />
                ) : null}
              </StyledDropdownMenuItem>
            );
          })}
          {state?.forcedByWorktreePolicy ? (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <p className="px-2 py-1 text-xs text-amber-700 dark:text-amber-300">
                Project policy forces{" "}
                {permissionProfileLabel(state.effectiveId)} on Primary.
              </p>
            </>
          ) : null}
        </StyledDropdownMenuContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
