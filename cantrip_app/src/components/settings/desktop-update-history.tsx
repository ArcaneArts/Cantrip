import { ChevronRight, History, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import {
  formatDesktopUpdateDate,
  groupDesktopUpdateHistory,
  type DesktopUpdateRelease,
} from "@/lib/desktop-update";

export function DesktopUpdateHistory({
  error,
  installedVersion,
  loading,
  headerAction,
  onOpenRelease,
  releases,
}: {
  error: string | null;
  installedVersion: string;
  loading: boolean;
  headerAction?: ReactNode;
  onOpenRelease(release: DesktopUpdateRelease): void;
  releases: DesktopUpdateRelease[];
}) {
  const groups = groupDesktopUpdateHistory(releases);
  const latestVersion = releases[0]?.version ?? null;

  return (
    <div data-slot="desktop-update-history" className="border-t">
      <div className="flex items-center justify-between gap-3 px-3 py-3">
        <div className="flex items-center gap-2.5">
          <History className="size-4 shrink-0 text-muted-foreground" />
          <div>
            <h3 className="text-sm font-semibold">Version history</h3>
            <p className="text-xs text-muted-foreground">
              Review release notes or install a specific signed version.
            </p>
          </div>
        </div>
        {headerAction}
      </div>

      {loading && releases.length === 0 ? (
        <div className="flex items-center gap-2 border-t px-3 py-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading versions…
        </div>
      ) : error && releases.length === 0 ? (
        <p className="border-t px-3 py-4 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : groups.length === 0 ? (
        <p className="border-t px-3 py-4 text-sm text-muted-foreground">
          No signed desktop releases are available yet.
        </p>
      ) : (
        <div className="border-t">
          {groups.map((group) => {
            const sectionId = `updates-${group.label.replaceAll(" ", "-").toLowerCase()}`;
            return (
              <section key={group.label} aria-labelledby={sectionId}>
                <h4
                  id={sectionId}
                  className="border-b bg-muted/25 px-3 py-1.5 text-[11px] font-semibold uppercase text-muted-foreground"
                >
                  {group.label}
                </h4>
                <div>
                  {group.releases.map((release) => {
                    const publishedAt = formatDesktopUpdateDate(
                      release.publishedAt,
                    );
                    return (
                      <button
                        key={release.version}
                        type="button"
                        data-slot="desktop-update-history-row"
                        className="grid w-full grid-cols-[minmax(0,1fr)_minmax(7rem,auto)_auto] items-center gap-3 border-b px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        onClick={() => onOpenRelease(release)}
                      >
                        <span className="min-w-0">
                          <span className="font-mono text-sm">
                            {release.version}
                          </span>
                          <span className="ml-2 inline-flex gap-1 align-middle text-[10px] uppercase text-muted-foreground">
                            {release.version === latestVersion ? (
                              <span>Latest</span>
                            ) : null}
                            {release.version === installedVersion ? (
                              <span>Installed</span>
                            ) : null}
                          </span>
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {publishedAt ?? "Date unavailable"}
                        </span>
                        <ChevronRight className="size-4 text-muted-foreground" />
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
