import { WandSparkles } from "lucide-react";
import type { ReactNode } from "react";

import { SessionWindowDragRegion } from "@/components/auth/session-window-drag-region";
import { isMacosDesktopRuntime } from "@/lib/desktop-popout";
import { getActiveServerConnection } from "@/lib/server-connections";

export function SessionFrame({ children }: { children: ReactNode }) {
  const active = getActiveServerConnection();
  return (
    <>
      <SessionWindowDragRegion enabled={isMacosDesktopRuntime()} />
      <main className="grid min-h-dvh place-items-center bg-background px-4 py-10 text-foreground">
        <section className="w-full max-w-md space-y-6">
          <header className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl border bg-card">
              <WandSparkles className="size-5" />
            </span>
            <span className="min-w-0">
              <span className="block text-base font-semibold">Cantrip</span>
              <span className="block truncate text-xs text-muted-foreground">
                {active
                  ? `${active.name} · ${active.url || "Local development server"}`
                  : "Remote server required"}
              </span>
            </span>
          </header>
          {children}
        </section>
      </main>
    </>
  );
}
