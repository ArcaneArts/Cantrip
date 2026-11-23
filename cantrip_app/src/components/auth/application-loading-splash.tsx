import { SessionWindowDragRegion } from "@/components/auth/session-window-drag-region";
import { CantripLoading } from "@/components/ui/cantrip-loading";
import { isMacosDesktopRuntime } from "@/lib/desktop-popout";

export function ApplicationLoadingSplash() {
  return (
    <>
      <SessionWindowDragRegion enabled={isMacosDesktopRuntime()} />
      <main
        className="flex min-h-dvh flex-col overflow-hidden bg-background text-foreground"
        data-application-loading-splash=""
      >
        <CantripLoading />
      </main>
    </>
  );
}
