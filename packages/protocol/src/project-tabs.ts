import { z } from "zod";
import { privateDisplayLabelOpaqueSchema } from "./private-labels.js";
import {
  hasUnambiguousProjectPaneDestination,
  projectPaneDestinationShape,
  projectPaneRegionSchema,
} from "./project-pane-identifiers.js";
import { projectBuiltinSurfaceDefinitionIdSchema } from "./project-surface-identifiers.js";

export const projectViewKindSchema = z.enum([
  "history",
  "issues",
  "remote-desktop",
]);

export const projectViewCreateKindSchema = z.literal("remote-desktop");

const projectViewCreateBaseSchema = z.object({
  title: z.string().trim().min(1).max(200),
  kind: projectViewCreateKindSchema,
  worktreeId: z.string().min(1).optional(),
  ...projectPaneDestinationShape,
});

export const projectViewCreateSchema = projectViewCreateBaseSchema.refine(
  hasUnambiguousProjectPaneDestination,
  {
    message:
      "Specify only one of paneId, the deprecated tabGroupId, or targetRegion.",
    path: ["paneId"],
  },
);

export const encryptedProjectViewCreateSchema = projectViewCreateBaseSchema
  .omit({ title: true })
  .extend({
    id: z.string().uuid(),
    titleProtection: privateDisplayLabelOpaqueSchema,
  })
  .strict()
  .refine(hasUnambiguousProjectPaneDestination, {
    message:
      "Specify only one of paneId, the deprecated tabGroupId, or targetRegion.",
    path: ["paneId"],
  })
  .refine(
    (input) =>
      input.titleProtection.classification.recordKind === "project-view",
    {
      message: "Project-view title classification must be project-view.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const projectTabKindSchema = z.enum([
  "chat",
  "terminal",
  "explorer",
  "browser",
  "code",
  "history",
  "issues",
  "remote-desktop",
  "builtin",
]);

export const projectBuiltInSurfaceStateSchema = z
  .object({
    definitionId: projectBuiltinSurfaceDefinitionIdSchema,
    worktreeId: z.string().min(1).nullable(),
  })
  .strict();

export const projectDockPresentationModeSchema = z.enum([
  "closed",
  "split",
  "full",
]);

export const projectDockSplitFractionSchema = z.number().min(0.05).max(0.95);

export const projectCenterSplitDirectionSchema = z.enum([
  "horizontal",
  "vertical",
]);

export const projectCenterSplitEdgeSchema = z.enum([
  "left",
  "right",
  "top",
  "bottom",
]);

export const projectCenterSplitFractionSchema = z.number().min(0.1).max(0.9);

export type ProjectCenterLayoutNode =
  | { kind: "pane"; paneId: string }
  | {
      kind: "split";
      id: string;
      direction: z.infer<typeof projectCenterSplitDirectionSchema>;
      fraction: number;
      first: ProjectCenterLayoutNode;
      second: ProjectCenterLayoutNode;
    };

export const projectCenterLayoutNodeSchema: z.ZodType<ProjectCenterLayoutNode> =
  z.lazy(() =>
    z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("pane"),
          paneId: z.string().min(1),
        })
        .strict(),
      z
        .object({
          kind: z.literal("split"),
          id: z.string().min(1),
          direction: projectCenterSplitDirectionSchema,
          fraction: projectCenterSplitFractionSchema,
          first: projectCenterLayoutNodeSchema,
          second: projectCenterLayoutNodeSchema,
        })
        .strict(),
    ]),
  );

export const projectDockPresentationPreferenceSchema = z
  .object({
    preferredMode: projectDockPresentationModeSchema,
    splitFraction: projectDockSplitFractionSchema,
    restoreFraction: projectDockSplitFractionSchema,
  })
  .strict();

export const projectDockPresentationUpdateSchema =
  projectDockPresentationPreferenceSchema.extend({
    revision: z.number().int().nonnegative(),
    tabKey: z.string().min(1),
  });

const projectTabMemberSummaryBaseSchema = z.object({
  tabKey: z.string().min(1),
  paneId: z.string().min(1),
  projectId: z.string().min(1),
  tabKind: projectTabKindSchema,
  tabId: z.string().min(1),
  builtInState: projectBuiltInSurfaceStateSchema.nullable().optional(),
  dockPresentation: projectDockPresentationPreferenceSchema
    .nullable()
    .optional(),
  position: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const projectTabMemberSummarySchema =
  projectTabMemberSummaryBaseSchema.extend({ title: z.string().min(1) });

const projectTabMemberWireSummaryObjectSchema =
  projectTabMemberSummaryBaseSchema.extend({
    titleProtection: privateDisplayLabelOpaqueSchema.nullable(),
  });

function validateProjectTabMemberWire(
  member: z.infer<typeof projectTabMemberWireSummaryObjectSchema>,
  context: z.RefinementCtx,
) {
  const expectedRecordKind =
    member.tabKind === "chat"
      ? "chat"
      : member.tabKind === "terminal"
        ? "terminal"
        : member.tabKind === "explorer"
          ? "explorer"
          : member.tabKind === "browser"
            ? "browser"
            : member.tabKind === "code"
              ? "code-tab"
              : member.tabKind === "builtin"
                ? null
                : "project-view";
  if (member.titleProtection === null) {
    if (member.tabKind !== "terminal" && member.tabKind !== "builtin") {
      context.addIssue({
        code: "custom",
        message:
          "Only Run configuration terminal tabs may omit a protected title.",
        path: ["titleProtection"],
      });
    }
  } else if (
    expectedRecordKind === null ||
    member.titleProtection.classification.recordKind !== expectedRecordKind
  ) {
    context.addIssue({
      code: "custom",
      message: "Tab-member title classification must match its surface kind.",
      path: ["titleProtection", "classification", "recordKind"],
    });
  }
  if (member.tabKind === "builtin") {
    const definition = projectBuiltinSurfaceDefinitionIdSchema.safeParse(
      member.tabId,
    );
    if (!definition.success) {
      context.addIssue({
        code: "custom",
        message: "Built-in tab id must be a built-in surface definition.",
        path: ["tabId"],
      });
    }
    if (!member.builtInState) {
      context.addIssue({
        code: "custom",
        message: "Built-in tabs must include their persisted state.",
        path: ["builtInState"],
      });
    } else if (member.builtInState.definitionId !== member.tabId) {
      context.addIssue({
        code: "custom",
        message: "Built-in tab state must match its definition id.",
        path: ["builtInState", "definitionId"],
      });
    }
  } else if (member.builtInState != null) {
    context.addIssue({
      code: "custom",
      message: "Entity-backed tabs cannot include built-in state.",
      path: ["builtInState"],
    });
  }
}

export const projectTabMemberWireSummarySchema =
  projectTabMemberWireSummaryObjectSchema.superRefine(
    validateProjectTabMemberWire,
  );

const legacyProjectTabMemberSummaryBaseSchema =
  projectTabMemberSummaryBaseSchema.omit({ paneId: true }).extend({
    groupId: z.string().min(1),
  });

export const legacyProjectTabMemberSummarySchema =
  legacyProjectTabMemberSummaryBaseSchema.extend({
    title: z.string().min(1),
  });

export const legacyProjectTabMemberWireSummarySchema =
  legacyProjectTabMemberSummaryBaseSchema
    .extend({ titleProtection: privateDisplayLabelOpaqueSchema.nullable() })
    .superRefine((member, context) =>
      validateProjectTabMemberWire(
        { ...member, paneId: member.groupId },
        context,
      ),
    );

const projectPaneSummaryBaseSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  region: projectPaneRegionSchema,
  position: z.number().int().nonnegative(),
  anchorTabKey: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

function validatePaneMembership(
  pane: {
    id: string;
    projectId: string;
    region?: z.infer<typeof projectPaneRegionSchema>;
    members: Array<{
      paneId: string;
      projectId: string;
      dockPresentation?: unknown | null;
    }>;
  },
  context: z.RefinementCtx,
) {
  for (const [index, member] of pane.members.entries()) {
    if (member.paneId !== pane.id) {
      context.addIssue({
        code: "custom",
        message: "Pane members must reference their containing pane.",
        path: ["members", index, "paneId"],
      });
    }
    if (member.projectId !== pane.projectId) {
      context.addIssue({
        code: "custom",
        message: "Pane members must belong to the pane project.",
        path: ["members", index, "projectId"],
      });
    }
    if (
      pane.region !== undefined &&
      pane.region !== "right" &&
      pane.region !== "bottom" &&
      member.dockPresentation != null
    ) {
      context.addIssue({
        code: "custom",
        message: "Dock presentation is only valid in right or bottom panes.",
        path: ["members", index, "dockPresentation"],
      });
    }
  }
}

export const projectPaneSummarySchema = projectPaneSummaryBaseSchema
  .extend({
    title: z.string().min(1).max(120),
    members: z.array(projectTabMemberSummarySchema).min(1),
  })
  .superRefine(validatePaneMembership);

export const projectPaneWireSummarySchema = projectPaneSummaryBaseSchema
  .extend({
    titleProtection: privateDisplayLabelOpaqueSchema.nullable(),
    members: z.array(projectTabMemberWireSummarySchema).min(1),
  })
  .superRefine((pane, context) => {
    validatePaneMembership(pane, context);
    if (
      pane.titleProtection &&
      pane.titleProtection.classification.recordKind !== "tab-group"
    ) {
      context.addIssue({
        code: "custom",
        message: "Tab-group title classification must be tab-group.",
        path: ["titleProtection", "classification", "recordKind"],
      });
    }
    if (pane.members.length === 1 && pane.titleProtection !== null) {
      context.addIssue({
        code: "custom",
        message: "A single-tab group derives its title from its member.",
        path: ["titleProtection"],
      });
    }
  });

export const projectPaneUpdateSchema = z.object({
  revision: z.number().int().nonnegative(),
  title: z.string().trim().min(1).max(120),
});

export const encryptedProjectPaneUpdateSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    titleProtection: privateDisplayLabelOpaqueSchema,
  })
  .strict()
  .refine(
    (input) => input.titleProtection.classification.recordKind === "tab-group",
    {
      message: "Tab-group title classification must be tab-group.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

function validatePaneLayout(
  layout: {
    projectId: string;
    panes: Array<{
      id?: string;
      projectId: string;
      region?: z.infer<typeof projectPaneRegionSchema>;
      members: Array<{ tabKey: string }>;
    }>;
    centerRoot?: ProjectCenterLayoutNode | null;
  },
  context: z.RefinementCtx,
) {
  const tabKeys = new Set<string>();
  for (const [paneIndex, pane] of layout.panes.entries()) {
    if (pane.projectId !== layout.projectId) {
      context.addIssue({
        code: "custom",
        message: "Panes must belong to the layout project.",
        path: ["panes", paneIndex, "projectId"],
      });
    }
    for (const [memberIndex, member] of pane.members.entries()) {
      if (tabKeys.has(member.tabKey)) {
        context.addIssue({
          code: "custom",
          message: "A surface view may be placed in at most one pane.",
          path: ["panes", paneIndex, "members", memberIndex, "tabKey"],
        });
      }
      tabKeys.add(member.tabKey);
    }
  }

  // Old clients may omit the topology field. Once present, it is authoritative
  // and must contain every center pane exactly once.
  if (layout.centerRoot === undefined) return;

  const centerPaneIds = new Set(
    layout.panes
      .filter(
        (pane): pane is typeof pane & { id: string; region: "center" } =>
          pane.region === "center" && pane.id !== undefined,
      )
      .map(({ id }) => id),
  );
  if (layout.centerRoot === null) {
    if (centerPaneIds.size > 0) {
      context.addIssue({
        code: "custom",
        message: "A center layout root is required when center panes exist.",
        path: ["centerRoot"],
      });
    }
    return;
  }

  const leafPaneIds = new Set<string>();
  const splitIds = new Set<string>();
  let nodeCount = 0;
  const visit = (
    node: ProjectCenterLayoutNode,
    path: (string | number)[],
    depth: number,
  ) => {
    nodeCount += 1;
    if (depth > 32 || nodeCount > 255) {
      context.addIssue({
        code: "custom",
        message: "The center layout exceeds its supported topology bounds.",
        path,
      });
      return;
    }
    if (node.kind === "pane") {
      if (leafPaneIds.has(node.paneId)) {
        context.addIssue({
          code: "custom",
          message: "A center pane may appear in the layout tree only once.",
          path: [...path, "paneId"],
        });
      }
      leafPaneIds.add(node.paneId);
      if (!centerPaneIds.has(node.paneId)) {
        context.addIssue({
          code: "custom",
          message: "Center layout leaves must reference center panes.",
          path: [...path, "paneId"],
        });
      }
      return;
    }
    if (splitIds.has(node.id)) {
      context.addIssue({
        code: "custom",
        message: "Center split ids must be unique.",
        path: [...path, "id"],
      });
    }
    splitIds.add(node.id);
    visit(node.first, [...path, "first"], depth + 1);
    visit(node.second, [...path, "second"], depth + 1);
  };
  visit(layout.centerRoot, ["centerRoot"], 1);
  for (const paneId of centerPaneIds) {
    if (!leafPaneIds.has(paneId)) {
      context.addIssue({
        code: "custom",
        message: "Every center pane must appear in the layout tree.",
        path: ["centerRoot"],
      });
    }
  }
}

export const projectTabLayoutSummarySchema = z
  .object({
    projectId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    panes: z.array(projectPaneSummarySchema),
    centerRoot: projectCenterLayoutNodeSchema.nullable().optional(),
  })
  .superRefine(validatePaneLayout);

export const projectTabLayoutWireSummarySchema = z
  .object({
    projectId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    panes: z.array(projectPaneWireSummarySchema),
    centerRoot: projectCenterLayoutNodeSchema.nullable().optional(),
  })
  .superRefine(validatePaneLayout);

export const projectPaneOrderSchema = z.object({
  revision: z.number().int().nonnegative(),
  region: projectPaneRegionSchema,
  paneIds: z
    .array(z.string().min(1))
    .min(1)
    .refine((paneIds) => new Set(paneIds).size === paneIds.length, {
      message: "Pane ids must be unique.",
    }),
});

export const projectPaneMemberOrderSchema = z.object({
  revision: z.number().int().nonnegative(),
  tabKeys: z
    .array(z.string().min(1))
    .min(1)
    .refine((tabKeys) => new Set(tabKeys).size === tabKeys.length, {
      message: "Tab keys must be unique.",
    }),
});

export const projectPaneMemberMoveSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    tabKey: z.string().min(1),
    targetPaneId: z.string().min(1).nullable(),
    targetRegion: projectPaneRegionSchema.optional(),
    targetMemberPosition: z.number().int().nonnegative(),
    targetPanePosition: z.number().int().nonnegative().optional(),
  })
  .superRefine((input, context) => {
    if (input.targetPaneId !== null && input.targetRegion !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Specify either a target pane or a target region, not both.",
        path: ["targetRegion"],
      });
    }
    if (
      input.targetPaneId === null &&
      input.targetPanePosition === undefined &&
      input.targetRegion !== "right" &&
      input.targetRegion !== "bottom"
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A pane position is required when splitting a tab into a new pane.",
        path: ["targetPanePosition"],
      });
    }
  });

export const projectPaneMemberSplitSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    tabKey: z.string().min(1),
    targetPaneId: z.string().min(1),
    edge: projectCenterSplitEdgeSchema,
    fraction: projectCenterSplitFractionSchema.default(0.5),
  })
  .strict();

export const projectCenterSplitResizeSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    fraction: projectCenterSplitFractionSchema,
  })
  .strict();

const legacyTabGroupSummaryBaseSchema = projectPaneSummaryBaseSchema.omit({
  region: true,
});

function validateLegacyGroupMembership(
  group: {
    id: string;
    projectId: string;
    members: Array<{ groupId: string; projectId: string }>;
  },
  context: z.RefinementCtx,
) {
  validatePaneMembership(
    {
      id: group.id,
      projectId: group.projectId,
      members: group.members.map((member) => ({
        paneId: member.groupId,
        projectId: member.projectId,
      })),
    },
    context,
  );
}

export const tabGroupSummarySchema = legacyTabGroupSummaryBaseSchema
  .extend({
    title: z.string().min(1).max(120),
    members: z.array(legacyProjectTabMemberSummarySchema).min(1),
  })
  .superRefine(validateLegacyGroupMembership);

export const tabGroupWireSummarySchema = legacyTabGroupSummaryBaseSchema
  .extend({
    titleProtection: privateDisplayLabelOpaqueSchema.nullable(),
    members: z.array(legacyProjectTabMemberWireSummarySchema).min(1),
  })
  .superRefine((group, context) => {
    validateLegacyGroupMembership(group, context);
    if (
      group.titleProtection &&
      group.titleProtection.classification.recordKind !== "tab-group"
    ) {
      context.addIssue({
        code: "custom",
        message: "Tab-group title classification must be tab-group.",
        path: ["titleProtection", "classification", "recordKind"],
      });
    }
    if (group.members.length === 1 && group.titleProtection !== null) {
      context.addIssue({
        code: "custom",
        message: "A single-tab group derives its title from its member.",
        path: ["titleProtection"],
      });
    }
  });

export const tabGroupUpdateSchema = projectPaneUpdateSchema;
export const encryptedTabGroupUpdateSchema = encryptedProjectPaneUpdateSchema;

function validateLegacyGroupLayout(
  layout: {
    projectId: string;
    groups: Array<{
      projectId: string;
      members: Array<{ tabKey: string }>;
    }>;
  },
  context: z.RefinementCtx,
) {
  validatePaneLayout(
    { projectId: layout.projectId, panes: layout.groups },
    context,
  );
}

export const legacyProjectTabLayoutSummarySchema = z
  .object({
    projectId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    groups: z.array(tabGroupSummarySchema),
  })
  .superRefine(validateLegacyGroupLayout);

export const legacyProjectTabLayoutWireSummarySchema = z
  .object({
    projectId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    groups: z.array(tabGroupWireSummarySchema),
  })
  .superRefine(validateLegacyGroupLayout);

export const tabGroupOrderSchema = z.object({
  revision: z.number().int().nonnegative(),
  groupIds: z
    .array(z.string().min(1))
    .min(1)
    .refine((groupIds) => new Set(groupIds).size === groupIds.length, {
      message: "Tab group ids must be unique.",
    }),
});

export const tabGroupMemberOrderSchema = projectPaneMemberOrderSchema;

export const tabGroupMemberMoveSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    tabKey: z.string().min(1),
    targetGroupId: z.string().min(1).nullable(),
    targetMemberPosition: z.number().int().nonnegative(),
    targetGroupPosition: z.number().int().nonnegative().optional(),
  })
  .superRefine((input, context) => {
    if (
      input.targetGroupId === null &&
      input.targetGroupPosition === undefined
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A sidebar position is required when splitting a tab into a new group.",
        path: ["targetGroupPosition"],
      });
    }
  });

export const projectViewUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200),
});

export const encryptedProjectViewUpdateSchema = z
  .object({ titleProtection: privateDisplayLabelOpaqueSchema })
  .strict()
  .refine(
    (input) =>
      input.titleProtection.classification.recordKind === "project-view",
    {
      message: "Project-view title classification must be project-view.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

const projectViewSummaryBaseSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  kind: projectViewKindSchema,
  worktreeId: z.string().min(1).nullable(),
  position: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const projectViewSummarySchema = projectViewSummaryBaseSchema.extend({
  title: z.string().min(1).max(200),
});

export const projectViewWireSummarySchema = projectViewSummaryBaseSchema
  .extend({ titleProtection: privateDisplayLabelOpaqueSchema })
  .refine(
    (view) => view.titleProtection.classification.recordKind === "project-view",
    {
      message: "Project-view title classification must be project-view.",
      path: ["titleProtection", "classification", "recordKind"],
    },
  );

export const projectViewListSchema = z.array(projectViewSummarySchema);
export const projectViewWireListSchema = z.array(projectViewWireSummarySchema);

export type ProjectViewKind = z.infer<typeof projectViewKindSchema>;
export type ProjectViewCreate = z.infer<typeof projectViewCreateSchema>;
export type EncryptedProjectViewCreate = z.infer<
  typeof encryptedProjectViewCreateSchema
>;
export type ProjectViewUpdate = z.infer<typeof projectViewUpdateSchema>;
export type EncryptedProjectViewUpdate = z.infer<
  typeof encryptedProjectViewUpdateSchema
>;
export type ProjectViewSummary = z.infer<typeof projectViewSummarySchema>;
export type ProjectViewWireSummary = z.infer<
  typeof projectViewWireSummarySchema
>;
export type ProjectTabKind = z.infer<typeof projectTabKindSchema>;
export type ProjectBuiltInSurfaceState = z.infer<
  typeof projectBuiltInSurfaceStateSchema
>;
export type ProjectDockPresentationMode = z.infer<
  typeof projectDockPresentationModeSchema
>;
export type ProjectDockPresentationPreference = z.infer<
  typeof projectDockPresentationPreferenceSchema
>;
export type ProjectDockPresentationUpdate = z.infer<
  typeof projectDockPresentationUpdateSchema
>;
export type ProjectTabMemberSummary = z.infer<
  typeof projectTabMemberSummarySchema
>;
export type ProjectTabMemberWireSummary = z.infer<
  typeof projectTabMemberWireSummarySchema
>;
export type ProjectPaneSummary = z.infer<typeof projectPaneSummarySchema>;
export type ProjectPaneWireSummary = z.infer<
  typeof projectPaneWireSummarySchema
>;
export type ProjectPaneUpdate = z.infer<typeof projectPaneUpdateSchema>;
export type EncryptedProjectPaneUpdate = z.infer<
  typeof encryptedProjectPaneUpdateSchema
>;
export type ProjectPaneOrder = z.infer<typeof projectPaneOrderSchema>;
export type ProjectPaneMemberOrder = z.infer<
  typeof projectPaneMemberOrderSchema
>;
export type ProjectPaneMemberMove = z.infer<typeof projectPaneMemberMoveSchema>;
export type ProjectPaneMemberSplit = z.infer<
  typeof projectPaneMemberSplitSchema
>;
export type ProjectCenterSplitResize = z.infer<
  typeof projectCenterSplitResizeSchema
>;
export type LegacyProjectTabMemberSummary = z.infer<
  typeof legacyProjectTabMemberSummarySchema
>;
export type LegacyProjectTabMemberWireSummary = z.infer<
  typeof legacyProjectTabMemberWireSummarySchema
>;
export type TabGroupSummary = z.infer<typeof tabGroupSummarySchema>;
export type TabGroupWireSummary = z.infer<typeof tabGroupWireSummarySchema>;
export type TabGroupUpdate = z.infer<typeof tabGroupUpdateSchema>;
export type EncryptedTabGroupUpdate = z.infer<
  typeof encryptedTabGroupUpdateSchema
>;
export type ProjectTabLayoutSummary = z.infer<
  typeof projectTabLayoutSummarySchema
>;
export type ProjectTabLayoutWireSummary = z.infer<
  typeof projectTabLayoutWireSummarySchema
>;
export type LegacyProjectTabLayoutSummary = z.infer<
  typeof legacyProjectTabLayoutSummarySchema
>;
export type LegacyProjectTabLayoutWireSummary = z.infer<
  typeof legacyProjectTabLayoutWireSummarySchema
>;
export type TabGroupOrder = z.infer<typeof tabGroupOrderSchema>;
export type TabGroupMemberOrder = z.infer<typeof tabGroupMemberOrderSchema>;
export type TabGroupMemberMove = z.infer<typeof tabGroupMemberMoveSchema>;
