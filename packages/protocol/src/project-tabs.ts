import { z } from "zod";
import { privateDisplayLabelOpaqueSchema } from "./private-labels.js";

export const projectViewKindSchema = z.enum([
  "history",
  "issues",
  "remote-desktop",
]);

export const projectViewCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  kind: projectViewKindSchema,
  worktreeId: z.string().min(1).optional(),
  tabGroupId: z.string().min(1).optional(),
});

export const encryptedProjectViewCreateSchema = projectViewCreateSchema
  .omit({ title: true })
  .extend({
    id: z.string().uuid(),
    titleProtection: privateDisplayLabelOpaqueSchema,
  })
  .strict()
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
]);

const projectTabMemberSummaryBaseSchema = z.object({
  tabKey: z.string().min(1),
  groupId: z.string().min(1),
  projectId: z.string().min(1),
  tabKind: projectTabKindSchema,
  tabId: z.string().min(1),
  position: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const projectTabMemberSummarySchema =
  projectTabMemberSummaryBaseSchema.extend({ title: z.string().min(1) });

export const projectTabMemberWireSummarySchema =
  projectTabMemberSummaryBaseSchema
    .extend({
      titleProtection: privateDisplayLabelOpaqueSchema.nullable(),
    })
    .superRefine((member, context) => {
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
                  : "project-view";
      if (member.titleProtection === null) {
        if (member.tabKind !== "terminal") {
          context.addIssue({
            code: "custom",
            message:
              "Only Run configuration terminal tabs may omit a protected title.",
            path: ["titleProtection"],
          });
        }
      } else if (
        member.titleProtection.classification.recordKind !== expectedRecordKind
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Tab-member title classification must match its surface kind.",
          path: ["titleProtection", "classification", "recordKind"],
        });
      }
    });

const tabGroupSummaryBaseSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  position: z.number().int().nonnegative(),
  anchorTabKey: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const tabGroupSummarySchema = tabGroupSummaryBaseSchema.extend({
  title: z.string().min(1).max(120),
  members: z.array(projectTabMemberSummarySchema).min(1),
});

export const tabGroupWireSummarySchema = tabGroupSummaryBaseSchema
  .extend({
    titleProtection: privateDisplayLabelOpaqueSchema.nullable(),
    members: z.array(projectTabMemberWireSummarySchema).min(1),
  })
  .superRefine((group, context) => {
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

export const tabGroupUpdateSchema = z.object({
  revision: z.number().int().nonnegative(),
  title: z.string().trim().min(1).max(120),
});

export const encryptedTabGroupUpdateSchema = z
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

export const projectTabLayoutSummarySchema = z.object({
  projectId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  groups: z.array(tabGroupSummarySchema),
});

export const projectTabLayoutWireSummarySchema = z.object({
  projectId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  groups: z.array(tabGroupWireSummarySchema),
});

export const tabGroupOrderSchema = z.object({
  revision: z.number().int().nonnegative(),
  groupIds: z
    .array(z.string().min(1))
    .min(1)
    .refine((groupIds) => new Set(groupIds).size === groupIds.length, {
      message: "Tab group ids must be unique.",
    }),
});

export const tabGroupMemberOrderSchema = z.object({
  revision: z.number().int().nonnegative(),
  tabKeys: z
    .array(z.string().min(1))
    .min(1)
    .refine((tabKeys) => new Set(tabKeys).size === tabKeys.length, {
      message: "Tab keys must be unique.",
    }),
});

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
export type ProjectTabMemberSummary = z.infer<
  typeof projectTabMemberSummarySchema
>;
export type ProjectTabMemberWireSummary = z.infer<
  typeof projectTabMemberWireSummarySchema
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
export type TabGroupOrder = z.infer<typeof tabGroupOrderSchema>;
export type TabGroupMemberOrder = z.infer<typeof tabGroupMemberOrderSchema>;
export type TabGroupMemberMove = z.infer<typeof tabGroupMemberMoveSchema>;
