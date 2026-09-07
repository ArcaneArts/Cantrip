import { useState } from "react";
import { Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isMacosDesktopRuntime } from "@/lib/desktop-popout";
import { errorMessage } from "@/lib/error-message";

const permissionUrls = {
  accessibility:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  capture:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
} as const;

export function ComputerUseSettings({
  enabled,
  pending,
  onChange,
}: {
  enabled: boolean;
  pending: boolean;
  onChange(enabled: boolean): void;
}) {
  const [error, setError] = useState<string | null>(null);
  const openPermissions = async (kind: keyof typeof permissionUrls) => {
    setError(null);
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(permissionUrls[kind]);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  return (
    <section className="px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Monitor className="size-4 shrink-0 text-muted-foreground" />
          <div>
            <h2 className="text-sm font-semibold">Computer use</h2>
            {!enabled ? (
              <p className="text-xs text-muted-foreground">
                Computer use is not enabled.
              </p>
            ) : null}
          </div>
        </div>
        <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/50">
          <input
            type="checkbox"
            aria-label="Enable computer use"
            className="size-3.5 accent-primary"
            checked={enabled}
            disabled={pending}
            onChange={(event) => onChange(event.target.checked)}
          />
          Enable computer use
        </label>
      </div>
      {enabled ? (
        <div className="mt-3 space-y-2 text-xs text-muted-foreground">
          <p>
            Agents can view and interact with applications on their worker.
            Start a new agent turn after enabling. Turning this off stops active
            computer-use sessions.
          </p>
          <p>
            On the Mac running the worker, allow Accessibility and Screen
            Recording for Cantrip or cantrip-cua when macOS requests them.
          </p>
          {isMacosDesktopRuntime() ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void openPermissions("accessibility")}
              >
                Open Accessibility settings
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void openPermissions("capture")}
              >
                Open Screen Recording settings
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
