import { z } from "zod";
import {
  projectTabKindSchema,
  projectTabLayoutWireSummarySchema,
} from "./project-tabs.js";

export const PROJECT_BUILT_IN_SURFACE_DEFINITION_IDS = [
  "project.overview",
  "project.tasks",
  "git.history",
  "git.graph",
  "github.issues",
  "github.pull-requests",
  "github.actions",
] as const;

export const projectSurfaceDefinitionIdSchema = z.enum([
  "project.agent",
  "project.terminal",
  "project.explorer",
  "project.file",
  "project.browser",
  "project.code",
  "project.remote-desktop",
  "project.git-history",
  "project.github-issues",
  "project.overview",
  "project.tasks",
  "git.history",
  "git.graph",
  "github.issues",
  "github.pull-requests",
  "github.actions",
]);

export const projectBuiltinSurfaceDefinitionIdSchema = z.enum(
  PROJECT_BUILT_IN_SURFACE_DEFINITION_IDS,
);

export const surfaceScopeSchema = z.enum([
  "project",
  "worktree",
  "account",
  "global",
]);
export const surfaceCardinalitySchema = z.enum(["singleton", "multi-instance"]);
export const surfacePlacementRegionSchema = z.enum([
  "center",
  "right",
  "bottom",
  "left",
  "detached",
]);
export const surfaceCapabilitySchema = z.enum([
  "worker",
  "worktrees",
  "git",
  "github",
  "remote-desktop",
]);
export const surfaceCategorySchema = z.enum([
  "resources",
  "project-tools",
  "git",
  "github",
]);
export const surfaceLauncherLocationSchema = z.enum([
  "project-navigator",
  "surface-catalog",
  "command-palette",
  "right-rail",
  "bottom-rail",
]);

export const projectSurfaceDefinitionSchema = z
  .object({
    id: projectSurfaceDefinitionIdSchema,
    scope: surfaceScopeSchema,
    cardinality: surfaceCardinalitySchema,
    label: z.string().trim().min(1),
    icon: z.string().trim().min(1),
    category: surfaceCategorySchema,
    capabilityRequirements: z.array(surfaceCapabilitySchema),
    suggestedPlacement: surfacePlacementRegionSchema,
    supportedPlacements: z
      .array(surfacePlacementRegionSchema)
      .min(1)
      .refine((placements) => new Set(placements).size === placements.length, {
        message: "Supported surface placements must be unique.",
      }),
    deletable: z.boolean(),
    archivable: z.boolean(),
    launcherLocations: z
      .array(surfaceLauncherLocationSchema)
      .min(1)
      .refine((locations) => new Set(locations).size === locations.length, {
        message: "Surface launcher locations must be unique.",
      }),
    launcherPinnedByDefault: z.boolean(),
  })
  .strict()
  .superRefine((definition, context) => {
    if (
      !definition.supportedPlacements.includes(definition.suggestedPlacement)
    ) {
      context.addIssue({
        code: "custom",
        message: "The suggested placement must be supported.",
        path: ["suggestedPlacement"],
      });
    }
  });

export type ProjectSurfaceDefinition = z.infer<
  typeof projectSurfaceDefinitionSchema
>;

export const projectSurfaceRegistrySchema = z
  .array(projectSurfaceDefinitionSchema)
  .superRefine((definitions, context) => {
    const seen = new Set<string>();
    for (const [index, definition] of definitions.entries()) {
      if (seen.has(definition.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate surface definition ${definition.id}.`,
          path: [index, "id"],
        });
      }
      seen.add(definition.id);
    }
  });

const commonLauncherLocations = [
  "project-navigator",
  "surface-catalog",
  "command-palette",
] as const;
const centerAndDockPlacements = [
  "center",
  "right",
  "bottom",
  "detached",
] as const;

export const PROJECT_SURFACE_DEFINITIONS = projectSurfaceRegistrySchema.parse([
  {
    id: "project.agent",
    scope: "project",
    cardinality: "multi-instance",
    label: "Agent",
    icon: "message-square-code",
    category: "resources",
    capabilityRequirements: ["worker"],
    suggestedPlacement: "center",
    supportedPlacements: centerAndDockPlacements,
    deletable: true,
    archivable: true,
    launcherLocations: commonLauncherLocations,
    launcherPinnedByDefault: false,
  },
  {
    id: "project.terminal",
    scope: "project",
    cardinality: "multi-instance",
    label: "Terminal",
    icon: "square-terminal",
    category: "resources",
    capabilityRequirements: ["worker"],
    suggestedPlacement: "bottom",
    supportedPlacements: centerAndDockPlacements,
    deletable: true,
    archivable: false,
    launcherLocations: [...commonLauncherLocations, "bottom-rail"],
    launcherPinnedByDefault: false,
  },
  {
    id: "project.explorer",
    scope: "project",
    cardinality: "multi-instance",
    label: "Explorer",
    icon: "folder-tree",
    category: "resources",
    capabilityRequirements: ["worker"],
    suggestedPlacement: "center",
    supportedPlacements: ["center", "left", "right", "detached"],
    deletable: true,
    archivable: false,
    launcherLocations: commonLauncherLocations,
    launcherPinnedByDefault: false,
  },
  {
    id: "project.file",
    scope: "project",
    cardinality: "multi-instance",
    label: "File",
    icon: "file-code-2",
    category: "resources",
    capabilityRequirements: ["worker"],
    suggestedPlacement: "center",
    supportedPlacements: centerAndDockPlacements,
    deletable: true,
    archivable: false,
    launcherLocations: ["project-navigator", "surface-catalog"],
    launcherPinnedByDefault: false,
  },
  {
    id: "project.browser",
    scope: "project",
    cardinality: "multi-instance",
    label: "Browser",
    icon: "globe-2",
    category: "resources",
    capabilityRequirements: ["worker"],
    suggestedPlacement: "right",
    supportedPlacements: centerAndDockPlacements,
    deletable: true,
    archivable: false,
    launcherLocations: [...commonLauncherLocations, "right-rail"],
    launcherPinnedByDefault: false,
  },
  {
    id: "project.code",
    scope: "project",
    cardinality: "multi-instance",
    label: "Code",
    icon: "code-2",
    category: "resources",
    capabilityRequirements: ["worker"],
    suggestedPlacement: "center",
    supportedPlacements: centerAndDockPlacements,
    deletable: true,
    archivable: false,
    launcherLocations: commonLauncherLocations,
    launcherPinnedByDefault: false,
  },
  {
    id: "project.remote-desktop",
    scope: "project",
    cardinality: "multi-instance",
    label: "Remote Desktop",
    icon: "monitor-up",
    category: "resources",
    capabilityRequirements: ["remote-desktop"],
    suggestedPlacement: "right",
    supportedPlacements: centerAndDockPlacements,
    deletable: true,
    archivable: false,
    launcherLocations: [...commonLauncherLocations, "right-rail"],
    launcherPinnedByDefault: false,
  },
  {
    id: "project.git-history",
    scope: "project",
    cardinality: "multi-instance",
    label: "History (legacy resource)",
    icon: "history",
    category: "resources",
    capabilityRequirements: ["git"],
    suggestedPlacement: "center",
    supportedPlacements: centerAndDockPlacements,
    deletable: true,
    archivable: false,
    launcherLocations: commonLauncherLocations,
    launcherPinnedByDefault: false,
  },
  {
    id: "project.github-issues",
    scope: "project",
    cardinality: "multi-instance",
    label: "Issues (legacy resource)",
    icon: "circle-dot",
    category: "resources",
    capabilityRequirements: ["github"],
    suggestedPlacement: "center",
    supportedPlacements: centerAndDockPlacements,
    deletable: true,
    archivable: false,
    launcherLocations: commonLauncherLocations,
    launcherPinnedByDefault: false,
  },
  {
    id: "project.overview",
    scope: "project",
    cardinality: "singleton",
    label: "Overview",
    icon: "layout-dashboard",
    category: "project-tools",
    capabilityRequirements: [],
    suggestedPlacement: "center",
    supportedPlacements: centerAndDockPlacements,
    deletable: false,
    archivable: false,
    launcherLocations: commonLauncherLocations,
    launcherPinnedByDefault: true,
  },
  {
    id: "project.tasks",
    scope: "project",
    cardinality: "singleton",
    label: "Tasks",
    icon: "list-todo",
    category: "project-tools",
    capabilityRequirements: [],
    suggestedPlacement: "center",
    supportedPlacements: centerAndDockPlacements,
    deletable: false,
    archivable: false,
    launcherLocations: commonLauncherLocations,
    launcherPinnedByDefault: true,
  },
  {
    id: "git.history",
    scope: "project",
    cardinality: "singleton",
    label: "History",
    icon: "history",
    category: "git",
    capabilityRequirements: ["git"],
    suggestedPlacement: "right",
    supportedPlacements: centerAndDockPlacements,
    deletable: false,
    archivable: false,
    launcherLocations: [...commonLauncherLocations, "right-rail"],
    launcherPinnedByDefault: false,
  },
  {
    id: "git.graph",
    scope: "project",
    cardinality: "singleton",
    label: "Graph",
    icon: "git-fork",
    category: "git",
    capabilityRequirements: ["git"],
    suggestedPlacement: "right",
    supportedPlacements: centerAndDockPlacements,
    deletable: false,
    archivable: false,
    launcherLocations: [...commonLauncherLocations, "right-rail"],
    launcherPinnedByDefault: false,
  },
  {
    id: "github.issues",
    scope: "project",
    cardinality: "singleton",
    label: "Issues",
    icon: "circle-dot",
    category: "github",
    capabilityRequirements: ["github"],
    suggestedPlacement: "right",
    supportedPlacements: centerAndDockPlacements,
    deletable: false,
    archivable: false,
    launcherLocations: [...commonLauncherLocations, "right-rail"],
    launcherPinnedByDefault: false,
  },
  {
    id: "github.pull-requests",
    scope: "project",
    cardinality: "singleton",
    label: "Pull Requests",
    icon: "git-pull-request",
    category: "github",
    capabilityRequirements: ["github"],
    suggestedPlacement: "right",
    supportedPlacements: centerAndDockPlacements,
    deletable: false,
    archivable: false,
    launcherLocations: [...commonLauncherLocations, "right-rail"],
    launcherPinnedByDefault: false,
  },
  {
    id: "github.actions",
    scope: "project",
    cardinality: "singleton",
    label: "Actions",
    icon: "play-circle",
    category: "github",
    capabilityRequirements: ["github"],
    suggestedPlacement: "right",
    supportedPlacements: centerAndDockPlacements,
    deletable: false,
    archivable: false,
    launcherLocations: [...commonLauncherLocations, "right-rail"],
    launcherPinnedByDefault: false,
  },
] satisfies unknown[]);

export const projectSurfaceResourceRefSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("entity"),
        definitionId: projectSurfaceDefinitionIdSchema,
        resourceId: z.string().min(1),
      })
      .strict(),
    z
      .object({
        kind: z.literal("builtin"),
        definitionId: projectBuiltinSurfaceDefinitionIdSchema,
      })
      .strict(),
  ])
  .superRefine((reference, context) => {
    if (
      reference.kind === "entity" &&
      !entityViewPrefixByDefinition[reference.definitionId]
    ) {
      context.addIssue({
        code: "custom",
        message: `${reference.definitionId} is not currently entity-backed.`,
        path: ["definitionId"],
      });
    }
  });

export type ProjectSurfaceResourceRef = z.infer<
  typeof projectSurfaceResourceRefSchema
>;

const entityViewPrefixByDefinition: Partial<
  Record<z.infer<typeof projectSurfaceDefinitionIdSchema>, string>
> = {
  "project.agent": "chat",
  "project.terminal": "terminal",
  "project.explorer": "explorer",
  "project.file": "explorer",
  "project.browser": "browser",
  "project.code": "code",
  "project.remote-desktop": "view",
  "project.git-history": "view",
  "project.github-issues": "view",
};

const tabKindByEntityDefinition: Partial<
  Record<
    z.infer<typeof projectSurfaceDefinitionIdSchema>,
    z.infer<typeof projectTabKindSchema>
  >
> = {
  "project.agent": "chat",
  "project.terminal": "terminal",
  "project.explorer": "explorer",
  "project.file": "explorer",
  "project.browser": "browser",
  "project.code": "code",
  "project.remote-desktop": "remote-desktop",
  "project.git-history": "history",
  "project.github-issues": "issues",
};

export function projectSurfaceTabKind(
  resource: ProjectSurfaceResourceRef,
): z.infer<typeof projectTabKindSchema> | null {
  return resource.kind === "entity"
    ? (tabKindByEntityDefinition[resource.definitionId] ?? null)
    : null;
}

export function projectSurfaceViewId(input: {
  projectId: string;
  resource: ProjectSurfaceResourceRef;
}): string {
  if (input.resource.kind === "builtin") {
    return `builtin:${encodeURIComponent(input.projectId)}:${input.resource.definitionId}`;
  }
  const prefix = entityViewPrefixByDefinition[input.resource.definitionId];
  if (!prefix) {
    throw new Error(
      `Surface definition ${input.resource.definitionId} is not entity-backed.`,
    );
  }
  return `${prefix}:${input.resource.resourceId}`;
}

export const projectSurfaceViewSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    resource: projectSurfaceResourceRefSchema,
  })
  .strict()
  .superRefine((view, context) => {
    try {
      if (view.id !== projectSurfaceViewId(view)) {
        context.addIssue({
          code: "custom",
          message: "Surface view id must match its deterministic resource id.",
          path: ["id"],
        });
      }
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid surface.",
        path: ["resource", "definitionId"],
      });
    }
  });

export const projectTabPlacementSchema = z
  .object({
    viewId: z.string().min(1),
    paneId: z.string().min(1),
    position: z.number().int().nonnegative(),
  })
  .strict();

export const projectPaneSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    region: surfacePlacementRegionSchema,
    orderedViewIds: z
      .array(z.string().min(1))
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Pane view ids must be unique.",
      }),
  })
  .strict();

export const projectSurfaceLauncherTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("definition"),
      definitionId: projectSurfaceDefinitionIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("surface"),
      surfaceRef: projectSurfaceResourceRefSchema,
    })
    .strict(),
]);

export const projectSurfaceLauncherSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    location: surfaceLauncherLocationSchema,
    target: projectSurfaceLauncherTargetSchema,
    pinned: z.boolean(),
  })
  .strict();

export const projectSurfaceViewOpenSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    surfaceRef: projectSurfaceResourceRefSchema,
    targetPaneId: z.string().min(1).optional(),
  })
  .strict();

export const projectSurfaceViewCloseSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    viewId: z.string().min(1),
  })
  .strict();

export const projectSurfaceViewOpenResultSchema = z
  .object({
    disposition: z.enum(["opened", "focused"]),
    viewId: z.string().min(1),
    paneId: z.string().min(1),
    layout: projectTabLayoutWireSummarySchema,
  })
  .strict();

export const projectSurfaceViewCloseResultSchema = z
  .object({
    disposition: z.enum(["closed", "already-closed"]),
    viewId: z.string().min(1),
    layout: projectTabLayoutWireSummarySchema,
  })
  .strict();

export type ProjectSurfaceDefinitionId = z.infer<
  typeof projectSurfaceDefinitionIdSchema
>;
export type ProjectBuiltInSurfaceDefinitionId = z.infer<
  typeof projectBuiltinSurfaceDefinitionIdSchema
>;
export type SurfacePlacementRegion = z.infer<
  typeof surfacePlacementRegionSchema
>;
export type ProjectSurfaceView = z.infer<typeof projectSurfaceViewSchema>;
export type ProjectTabPlacement = z.infer<typeof projectTabPlacementSchema>;
export type ProjectPane = z.infer<typeof projectPaneSchema>;
export type ProjectSurfaceLauncher = z.infer<
  typeof projectSurfaceLauncherSchema
>;
export type ProjectSurfaceLauncherTarget = z.infer<
  typeof projectSurfaceLauncherTargetSchema
>;
export type ProjectSurfaceViewOpen = z.infer<
  typeof projectSurfaceViewOpenSchema
>;
export type ProjectSurfaceViewClose = z.infer<
  typeof projectSurfaceViewCloseSchema
>;
export type ProjectSurfaceViewOpenResult = z.infer<
  typeof projectSurfaceViewOpenResultSchema
>;
export type ProjectSurfaceViewCloseResult = z.infer<
  typeof projectSurfaceViewCloseResultSchema
>;
