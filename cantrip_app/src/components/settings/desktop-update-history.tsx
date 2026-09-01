import { History, Loader2 } from "lucide-react";

import {
  formatDesktopUpdateDate,
  type DesktopUpdateRelease,
} from "@/lib/desktop-update";
import { cn } from "@/lib/utils";

export function DesktopUpdateVersionList({
  error,
  installedVersion,
  loading,
  onSelectRelease,
  releases,
  selectedVersion,
}: {
  error: string | null;
  installedVersion: string;
  loading: boolean;
  onSelectRelease(release: DesktopUpdateRelease): void;
  releases: DesktopUpdateRelease[];
  selectedVersion: string | null;
}) {
  const latestVersion = releases[0]?.version ?? null;

  return (
    <aside
      data-slot="desktop-update-version-list"
      className="flex min-h-0 flex-col border-b sm:border-b-0 sm:border-r"
    >
      <div className="flex items-center gap-2.5 border-b px-3 py-3">
        <History className="size-4 shrink-0 text-muted-foreground" />
        <div>
          <h3 className="text-sm font-semibold">Versions</h3>
          <p className="text-xs text-muted-foreground">
            Select a signed release.
          </p>
        </div>
      </div>

      {loading && releases.length === 0 ? (
        <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading versions…
        </div>
      ) : error && releases.length === 0 ? (
        <p className="px-3 py-4 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : releases.length === 0 ? (
        <p className="px-3 py-4 text-sm text-muted-foreground">
          No signed desktop releases are available yet.
        </p>
      ) : (
        <div className="min-h-0 overflow-y-auto p-1.5">
          {releases.map((release) => {
            const publishedAt = formatDesktopUpdateDate(release.publishedAt);
            const selected = release.version === selectedVersion;
            return (
              <button
                key={release.version}
                type="button"
                data-slot="desktop-update-version-row"
                data-selected={selected ? "true" : undefined}
                className={cn(
                  "grid w-full gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected && "bg-muted",
                )}
                onClick={() => onSelectRelease(release)}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="font-mono text-sm">{release.version}</span>
                  {release.version === latestVersion ? (
                    <span className="text-[10px] uppercase text-muted-foreground">
                      Latest
                    </span>
                  ) : null}
                  {release.version === installedVersion ? (
                    <span className="text-[10px] uppercase text-muted-foreground">
                      Installed
                    </span>
                  ) : null}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {publishedAt ?? "Date unavailable"}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </aside>
  );
}
