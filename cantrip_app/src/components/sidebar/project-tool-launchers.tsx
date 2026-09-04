import type {
  ProjectBuiltInSurfaceDefinitionId,
  ProjectCapabilities,
  ProjectSurfaceLauncher,
} from "@cantrip/protocol";
import { projectBuiltinSurfaceDefinitionIdSchema } from "@cantrip/protocol";
import {
  CircleDot,
  CirclePlay,
  ChevronDown,
  ChevronRight,
  GitPullRequest,
  History,
  LayoutDashboard,
  ListTodo,
  Network,
  Pin,
  PinOff,
  X,
  type LucideProps,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { ProjectSurface } from "@/lib/project-surface";
import { projectSurfaceDefinition } from "@/lib/project-surface-registry";
import { projectBuiltInSurfaceAvailable } from "@/lib/project-tool-surfaces";
import { cn } from "@/lib/utils";

type BuiltInSurface = Extract<ProjectSurface, { kind: "builtin" }>;

export function ProjectBuiltInSurfaceIcon({
  definitionId,
  ...props
}: LucideProps & { definitionId: ProjectBuiltInSurfaceDefinitionId }) {
  const Icon =
    definitionId === "project.overview"
      ? LayoutDashboard
      : definitionId === "project.tasks"
        ? ListTodo
        : definitionId === "git.history"
          ? History
          : definitionId === "git.graph"
            ? Network
            : definitionId === "github.issues"
              ? CircleDot
              : definitionId === "github.pull-requests"
                ? GitPullRequest
                : CirclePlay;
  return <Icon {...props} />;
}

function ToolRow({
  capabilities,
  launcher,
  onClose,
  onOpen,
  onPin,
  onSelect,
  selectedTabKey,
  surface,
}: {
  capabilities: ProjectCapabilities;
  launcher: ProjectSurfaceLauncher;
  onClose(surface: BuiltInSurface): void;
  onOpen(definitionId: ProjectBuiltInSurfaceDefinitionId): void;
  onPin(definitionId: ProjectBuiltInSurfaceDefinitionId, pinned: boolean): void;
  onSelect(tabKey: string): void;
  selectedTabKey: string | null;
  surface: BuiltInSurface | undefined;
}) {
  if (launcher.target.kind !== "definition") return null;
  const parsedDefinitionId = projectBuiltinSurfaceDefinitionIdSchema.safeParse(
    launcher.target.definitionId,
  );
  if (!parsedDefinitionId.success) return null;
  const definitionId = parsedDefinitionId.data;
  const available = projectBuiltInSurfaceAvailable(definitionId, capabilities);
  const label = projectSurfaceDefinition(definitionId).label;
  const active = Boolean(surface && surface.tabKey === selectedTabKey);
  return (
    <div
      className={cn(
        "group flex min-w-0 items-center gap-1 rounded-md",
        surface && "bg-muted/40",
      )}
      data-project-tool={definitionId}
    >
      <button
        type="button"
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted",
          !available && !surface && "cursor-not-allowed opacity-50",
          active && "text-foreground",
        )}
        disabled={!available && !surface}
        title={!available ? `${label} is unavailable for this project` : label}
        onClick={() =>
          surface ? onSelect(surface.tabKey) : onOpen(definitionId)
        }
      >
        <ProjectBuiltInSurfaceIcon
          className="size-3.5 shrink-0"
          definitionId={definitionId}
        />
        <span className="min-w-0 flex-1 truncate capitalize">{label}</span>
        {!available ? (
          <span className="text-[10px] text-muted-foreground">Unavailable</span>
        ) : null}
      </button>
      {surface ? (
        <Button
          aria-label={`Close ${label}`}
          className="size-6 opacity-0 group-hover:opacity-100 focus:opacity-100"
          size="icon"
          variant="ghost"
          onClick={() => onClose(surface)}
        >
          <X className="size-3" />
        </Button>
      ) : null}
      <Button
        aria-label={`${launcher.pinned ? "Unpin" : "Pin"} ${label}`}
        aria-pressed={launcher.pinned}
        className="size-6"
        size="icon"
        variant="ghost"
        onClick={() => onPin(definitionId, !launcher.pinned)}
      >
        {launcher.pinned ? (
          <PinOff className="size-3" />
        ) : (
          <Pin className="size-3" />
        )}
      </Button>
    </div>
  );
}

export function ProjectToolLaunchers({
  capabilities,
  launchers,
  onClose,
  onOpen,
  onPin,
  onSelect,
  selectedTabKey,
  surfaces,
}: {
  capabilities: ProjectCapabilities;
  launchers: readonly ProjectSurfaceLauncher[];
  onClose(surface: BuiltInSurface): void;
  onOpen(definitionId: ProjectBuiltInSurfaceDefinitionId): void;
  onPin(definitionId: ProjectBuiltInSurfaceDefinitionId, pinned: boolean): void;
  onSelect(tabKey: string): void;
  selectedTabKey: string | null;
  surfaces: readonly ProjectSurface[];
}) {
  const [catalogOpen, setCatalogOpen] = useState(false);
  const navigatorLaunchers = launchers.filter(
    (launcher) =>
      launcher.location === "project-navigator" &&
      launcher.target.kind === "definition" &&
      projectBuiltinSurfaceDefinitionIdSchema.safeParse(
        launcher.target.definitionId,
      ).success,
  );
  const openByDefinition = new Map(
    surfaces
      .filter(
        (surface): surface is BuiltInSurface => surface.kind === "builtin",
      )
      .map((surface) => [surface.entity.definitionId, surface]),
  );
  const pinnedLaunchers = navigatorLaunchers.filter(({ pinned }) => pinned);
  const catalogLaunchers = navigatorLaunchers.filter(({ pinned }) => !pinned);
  const renderTool = (launcher: ProjectSurfaceLauncher) => {
    if (launcher.target.kind !== "definition") return null;
    const parsedDefinitionId =
      projectBuiltinSurfaceDefinitionIdSchema.safeParse(
        launcher.target.definitionId,
      );
    if (!parsedDefinitionId.success) return null;
    const definitionId = parsedDefinitionId.data;
    return (
      <ToolRow
        key={launcher.id}
        capabilities={capabilities}
        launcher={launcher}
        surface={openByDefinition.get(definitionId)}
        onClose={onClose}
        onOpen={onOpen}
        onPin={onPin}
        onSelect={onSelect}
        selectedTabKey={selectedTabKey}
      />
    );
  };
  return (
    <div className="mb-1 flex flex-col gap-1" data-project-tool-launchers>
      {pinnedLaunchers.length ? (
        <section aria-label="Pinned project tools">
          <div className="px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Pinned
          </div>
          {pinnedLaunchers.map(renderTool)}
        </section>
      ) : null}
      {catalogLaunchers.length ? (
        <section aria-label="Project tools catalog">
          <button
            type="button"
            aria-expanded={catalogOpen}
            className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => setCatalogOpen((open) => !open)}
          >
            {catalogOpen ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
            Project tools
          </button>
          {catalogOpen ? (
            <div className="pl-2" data-project-tool-catalog>
              {catalogLaunchers.map(renderTool)}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
