import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ChatPermissionProfileState } from "@cantrip/protocol";
import { Check, Loader2, Lock, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from "@/components/ui/styled-menu";
import { cn } from "@/lib/utils";

export const BUILTIN_PERMISSION_PROFILES = [
  { id: ":read-only", description: "Inspect files without writing." },
  { id: ":workspace", description: "Read and write inside the workspace." },
  {
    id: ":danger-full-access",
    description: "Unrestricted access with approval prompts.",
  },
  {
    id: ":yolo",
    description: "Unrestricted access and never ask for approval.",
  },
] as const;

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

export interface NativePermissionControlState {
  confirmed:
    import("./native-permission-settings").NativePermissionSelection | null;
  confirmedPresetId: string | null;
  requestedLabel?: string | null;
  status?:
    "requesting" | "queued" | "applied" | "rejected" | "uncertain" | null;
  error?: string | null;
  disabled?: boolean;
}

export function PermissionProfileControl({
  open,
  onOpenChange,
  onChange,
  pending,
  state,
  native,
}: {
  open?: boolean;
  onOpenChange?(open: boolean): void;
  onChange(id: string | null): void;
  pending: boolean;
  state: ChatPermissionProfileState | undefined;
  native?: NativePermissionControlState;
}) {
  const available = state?.available === true;
  const allowed =
    state?.profiles.filter((profile) => profile.allowed) ??
    BUILTIN_PERMISSION_PROFILES.map((profile) => ({
      ...profile,
      allowed: true,
    }));
  const defaultId = state?.defaultId ?? ":workspace";
  const selectedLabel = native
    ? native.confirmed
      ? native.confirmedPresetId
        ? permissionProfileLabel(native.confirmedPresetId)
        : "Custom native permissions"
      : "Native permissions unconfirmed"
    : state?.usesDefault
      ? `Default (${permissionProfileLabel(defaultId)})`
      : state
        ? permissionProfileLabel(state.selectedId)
        : "Permissions";
  const actualId = native ? native.confirmedPresetId : state?.effectiveId;
  const title = native
    ? `${selectedLabel}${native.requestedLabel ? `; requested ${native.requestedLabel}` : ""}${state?.forcedByWorktreePolicy ? `; Primary policy requires ${permissionProfileLabel(state.effectiveId)}` : ""}`
    : !available
      ? (state?.reason ?? "Loading Codex permission profiles…")
      : state?.forcedByWorktreePolicy
        ? `${selectedLabel}; project policy forces ${permissionProfileLabel(state.effectiveId)} on Primary.`
        : selectedLabel;

  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className={cn(
            "size-7 shrink-0 text-foreground/80",
            actualId &&
              isUnrestrictedProfile(actualId) &&
              "text-amber-600 dark:text-amber-400",
            actualId === ":yolo" && "text-destructive",
          )}
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
          <StyledDropdownMenuItem
            className="items-start"
            disabled={native?.disabled || (native && pending)}
            onSelect={() => onChange(null)}
          >
            <Lock className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">Default</span>
              <span className="block text-xs text-muted-foreground">
                {native && !state
                  ? "Use the account’s current default permission profile."
                  : `Follow the account default: ${permissionProfileLabel(defaultId)}.`}
              </span>
            </span>
            {!native && state?.usesDefault ? (
              <Check className="mt-0.5 size-3.5 shrink-0" />
            ) : null}
          </StyledDropdownMenuItem>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
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
                disabled={native?.disabled || (native && pending)}
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
                {(
                  native
                    ? native.confirmedPresetId === profile.id
                    : !state?.usesDefault && state?.selectedId === profile.id
                ) ? (
                  <Check className="mt-0.5 size-3.5 shrink-0" />
                ) : null}
              </StyledDropdownMenuItem>
            );
          })}
          {native ? (
            <div
              className="space-y-1 border-t px-2 py-2 text-xs"
              data-slot="native-permission-state"
            >
              <p>Last confirmed: {selectedLabel}</p>
              {native.confirmed ? (
                <>
                  <p>
                    Approval policy:{" "}
                    {typeof native.confirmed.approvalPolicy === "string"
                      ? native.confirmed.approvalPolicy
                      : JSON.stringify(native.confirmed.approvalPolicy)}
                  </p>
                  <p>Reviewer: {native.confirmed.approvalsReviewer}</p>
                  <p>
                    Sandbox:{" "}
                    {typeof native.confirmed.sandboxPolicy?.type === "string"
                      ? native.confirmed.sandboxPolicy.type
                      : "Custom policy"}
                  </p>
                </>
              ) : (
                <p>Waiting for confirmed native permissions.</p>
              )}
              {native.requestedLabel ? (
                <p>Requested: {native.requestedLabel}</p>
              ) : null}
              {native.status === "requesting" || native.status === "queued" ? (
                <p role="status">
                  Permission change is awaiting native confirmation.
                </p>
              ) : null}
              {native.status === "rejected" ? (
                <p role="status">
                  Permission change was rejected. The last confirmed permissions
                  remain shown.
                </p>
              ) : null}
              {native.status === "uncertain" ? (
                <p role="status">
                  The permission change has an unconfirmed outcome. It has not
                  been sent again.
                </p>
              ) : null}
              {native.error ? <p role="alert">{native.error}</p> : null}
            </div>
          ) : null}
          {state?.forcedByWorktreePolicy ? (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <p className="px-2 py-1 text-xs text-amber-700 dark:text-amber-300">
                Project policy forces{" "}
                {permissionProfileLabel(state.effectiveId)} on Primary.
              </p>
            </>
          ) : null}
          {!native && !available ? (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <p className="px-2 py-1 text-xs text-muted-foreground">
                {state?.reason ?? "Starting Codex to verify permissions…"}
              </p>
            </>
          ) : null}
        </StyledDropdownMenuContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
