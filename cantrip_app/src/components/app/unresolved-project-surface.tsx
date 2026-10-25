import type { ProjectSurface } from "@/lib/project-surface";
import { Button } from "@/components/ui/button";

export function UnresolvedProjectSurface({
  surface,
  query,
  onClose,
}: {
  surface: Extract<ProjectSurface, { kind: "unresolved" }>;
  query?: {
    isPending?: boolean;
    isLoading?: boolean;
    isError?: boolean;
    refetch?: () => Promise<unknown>;
  };
  onClose?: () => void;
}) {
  const loading = !query || query.isPending || query.isLoading;
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-sm"
      data-unresolved-tab-id={surface.tabKey}
    >
      <p role="status">
        {loading
          ? "Loading resource…"
          : query.isError
            ? "Could not load this resource."
            : "This resource is currently unavailable."}
      </p>
      <p className="text-muted-foreground">{surface.title}</p>
      <div className="flex gap-2">
        {!loading && query?.refetch ? (
          <Button
            variant="outline"
            onClick={() => {
              void query.refetch!().catch(() => {});
            }}
          >
            Retry
          </Button>
        ) : null}
        {onClose ? (
          <Button variant="ghost" onClick={onClose}>
            Close tab
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function unresolvedSurfaceCollection(
  surface: Extract<ProjectSurface, { kind: "unresolved" }>,
) {
  switch (surface.member.tabKind) {
    case "chat":
      return "chats";
    case "terminal":
      return "terminals";
    case "explorer":
      return "explorers";
    case "browser":
      return "browsers";
    case "code":
      return "codeTabs";
    default:
      return "projectViews";
  }
}
