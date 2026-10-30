import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import type { ProjectSidebarPage } from "./use-project-sidebar-page";
import { cn } from "@/lib/utils";

export function ProjectSidebarPages({
  page,
  onChange,
  files,
  conversations,
}: {
  page: ProjectSidebarPage;
  onChange(page: ProjectSidebarPage): void;
  files: ReactNode;
  conversations: ReactNode;
}) {
  const id = useId();
  const fileScroll = useRef<HTMLDivElement>(null);
  const fileOffset = useRef(0);
  const restoringOffset = useRef<number | null>(null);
  useLayoutEffect(() => {
    const element = fileScroll.current;
    if (page !== "files" || !element) return;
    restoringOffset.current = fileOffset.current;
    const restore = () => {
      if (restoringOffset.current === null) return;
      element.scrollTop = restoringOffset.current;
      if (element.scrollTop >= restoringOffset.current)
        restoringOffset.current = null;
    };
    restore();
    // Reauthorization or directory loading may initially clamp scroll to zero.
    // Retain the saved offset until the tree has rendered enough content.
    const observer = new MutationObserver(restore);
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [page]);
  const pages = ["files", "conversations"] as const;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="tablist"
        aria-label="Project sidebar"
        className="mb-1 flex h-8 shrink-0 items-center gap-1 border-t border-transparent pt-1 group-hover/sidebar-shell:border-border/70"
      >
        {pages.map((value, index) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`${id}-${value}-tab`}
            aria-controls={`${id}-${value}-panel`}
            aria-selected={page === value}
            tabIndex={page === value ? 0 : -1}
            className={cn(
              "h-6 rounded px-2 text-[10px] font-medium uppercase tracking-wide focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              page === value
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/60",
            )}
            onClick={() => onChange(value)}
            onKeyDown={(event) => {
              const next =
                event.key === "ArrowRight"
                  ? pages[(index + 1) % pages.length]
                  : event.key === "ArrowLeft"
                    ? pages[(index + pages.length - 1) % pages.length]
                    : event.key === "Home"
                      ? pages[0]
                      : event.key === "End"
                        ? pages[1]
                        : null;
              if (!next) return;
              event.preventDefault();
              onChange(next);
              document.getElementById(`${id}-${next}-tab`)?.focus();
            }}
          >
            {value === "files" ? "Files" : "Conversations"}
          </button>
        ))}
      </div>
      <div
        ref={fileScroll}
        hidden={page !== "files"}
        role="tabpanel"
        id={`${id}-files-panel`}
        aria-labelledby={`${id}-files-tab`}
        className={cn(
          "min-h-0 flex-1 overflow-y-auto",
          page === "files" && "flex flex-col",
        )}
        onWheel={() => {
          restoringOffset.current = null;
        }}
        onPointerDown={() => {
          restoringOffset.current = null;
        }}
        onKeyDown={() => {
          restoringOffset.current = null;
        }}
        onScroll={(event) => {
          if (page === "files" && restoringOffset.current === null)
            fileOffset.current = event.currentTarget.scrollTop;
        }}
      >
        {files}
      </div>
      <div
        hidden={page !== "conversations"}
        role="tabpanel"
        id={`${id}-conversations-panel`}
        aria-labelledby={`${id}-conversations-tab`}
        className={cn(
          "min-h-0 flex-1",
          page === "conversations" && "flex flex-col",
        )}
      >
        {conversations}
      </div>
    </div>
  );
}
