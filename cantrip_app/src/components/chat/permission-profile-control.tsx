import type { ChatPermissionProfileState } from "@cantrip/protocol";
import { Lock, ShieldAlert } from "lucide-react";

import { cn } from "@/lib/utils";

const PROFILE_LABELS: Record<string, string> = {
  ":read-only": "Read only",
  ":workspace": "Workspace",
  ":danger-full-access": "Full access",
};

export function permissionProfileLabel(id: string): string {
  return PROFILE_LABELS[id] ?? id.replace(/^:/, "");
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
  if (!state?.available) {
    return (
      <span
        className="inline-flex min-w-0 items-center gap-1 px-1 py-1 text-xs text-muted-foreground"
        title={state?.reason ?? "Loading Codex permission profiles…"}
      >
        <Lock className="size-3.5 shrink-0" />
        <span className="truncate">Sandbox</span>
      </span>
    );
  }
  const allowed = state.profiles.filter((profile) => profile.allowed);
  return (
    <span className="flex min-w-0 items-center gap-1">
      {state.effectiveId === ":danger-full-access" ? (
        <ShieldAlert className="size-3.5 shrink-0 text-destructive" />
      ) : (
        <Lock className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <select
        aria-label="Codex permission profile"
        value={state.selectedId}
        disabled={disabled || pending}
        title={
          state.forcedByWorktreePolicy
            ? `Project policy forces ${permissionProfileLabel(state.effectiveId)} on Primary.`
            : allowed.find((profile) => profile.id === state.selectedId)
                ?.description
        }
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          "min-w-0 max-w-36 truncate rounded-md bg-transparent px-1 py-1 text-xs font-medium outline-none disabled:cursor-not-allowed",
          state.effectiveId === ":danger-full-access" && "text-destructive",
        )}
      >
        {allowed.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {permissionProfileLabel(profile.id)}
          </option>
        ))}
      </select>
      {state.forcedByWorktreePolicy ? (
        <span className="shrink-0 text-[10px] text-amber-700 dark:text-amber-300">
          → {permissionProfileLabel(state.effectiveId)}
        </span>
      ) : null}
    </span>
  );
}
