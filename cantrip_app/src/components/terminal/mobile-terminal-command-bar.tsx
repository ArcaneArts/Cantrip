import { KeyboardOff } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

export type MobileTerminalKey =
  "escape" | "arrow-left" | "arrow-up" | "arrow-down" | "arrow-right";

const ARROW_SUFFIXES = {
  "arrow-left": "D",
  "arrow-up": "A",
  "arrow-down": "B",
  "arrow-right": "C",
} as const;

export function mobileTerminalKeyInput(
  key: MobileTerminalKey,
  shift: boolean,
  applicationCursorKeysMode: boolean,
): string {
  if (key === "escape") return "\x1b";
  const suffix = ARROW_SUFFIXES[key];
  if (shift) return `\x1b[1;2${suffix}`;
  return applicationCursorKeysMode ? `\x1bO${suffix}` : `\x1b[${suffix}`;
}

const ARROW_ACTIONS: ReadonlyArray<{
  key: MobileTerminalKey;
  label: string;
  accessibleLabel: string;
}> = [
  { key: "arrow-left", label: "←", accessibleLabel: "Arrow left" },
  { key: "arrow-up", label: "↑", accessibleLabel: "Arrow up" },
  { key: "arrow-down", label: "↓", accessibleLabel: "Arrow down" },
  { key: "arrow-right", label: "→", accessibleLabel: "Arrow right" },
];

const buttonClassName =
  "inline-flex h-10 min-w-11 flex-1 touch-manipulation items-center justify-center rounded-md border border-border/70 bg-muted/70 px-2 text-sm font-medium text-foreground active:bg-accent disabled:pointer-events-none disabled:opacity-50";

export function MobileTerminalCommandBar({
  bottomInset,
  disabled = false,
  onDismiss,
  onKey,
}: {
  bottomInset: number;
  disabled?: boolean;
  onDismiss(): void;
  onKey(key: MobileTerminalKey, shift: boolean): void;
}) {
  const [shift, setShift] = useState(false);

  const runKey = (key: MobileTerminalKey) => {
    onKey(key, shift);
    setShift(false);
  };

  return (
    <div
      aria-label="Terminal keyboard actions"
      className="fixed left-0 right-0 z-50 h-12 border-t border-border bg-background/95 backdrop-blur"
      data-slot="mobile-terminal-command-bar"
      onPointerDown={(event) => event.preventDefault()}
      role="toolbar"
      style={{ bottom: `${bottomInset}px` }}
    >
      <div
        className="mx-auto flex h-full w-full max-w-md items-center gap-1 px-2"
        style={{
          paddingLeft: "max(0.5rem, env(safe-area-inset-left))",
          paddingRight: "max(0.5rem, env(safe-area-inset-right))",
        }}
      >
        <button
          aria-label="Escape"
          className={buttonClassName}
          disabled={disabled}
          onClick={() => runKey("escape")}
          type="button"
        >
          Esc
        </button>
        <button
          aria-label="Shift modifier"
          aria-pressed={shift}
          className={cn(
            buttonClassName,
            shift && "border-primary/50 bg-accent text-accent-foreground",
          )}
          disabled={disabled}
          onClick={() => setShift((active) => !active)}
          type="button"
        >
          Shift
        </button>
        {ARROW_ACTIONS.map((action) => (
          <button
            aria-label={action.accessibleLabel}
            className={buttonClassName}
            disabled={disabled}
            key={action.key}
            onClick={() => runKey(action.key)}
            type="button"
          >
            <span aria-hidden="true">{action.label}</span>
          </button>
        ))}
        <button
          aria-label="Dismiss keyboard"
          className={buttonClassName}
          onClick={onDismiss}
          type="button"
        >
          <KeyboardOff aria-hidden="true" className="size-4" />
        </button>
      </div>
    </div>
  );
}
