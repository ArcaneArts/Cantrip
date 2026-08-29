import { z } from "zod";

export const projectOriginKindSchema = z.enum(["github", "managed-folder"]);
export const projectFolderManagementSchema = z.enum(["managed", "external"]);
export const projectSourceKindSchema = z.enum(["git", "folder"]);
export const projectRootKindSchema = z.enum(["git-worktree", "folder-root"]);

export const projectCapabilitiesSchema = z
  .object({
    git: z.boolean(),
    github: z.boolean(),
    worktrees: z.boolean(),
    replicas: z.boolean(),
    relocation: z.boolean(),
  })
  .strict();

export const projectCapabilitySchema = projectCapabilitiesSchema.keyof();

export const projectCapabilityUnavailableErrorSchema = z
  .object({
    code: z.literal("project-capability-unavailable"),
    capability: projectCapabilitySchema,
    error: z.string().min(1).max(1_000),
  })
  .strict();

export function projectCapabilitiesForOriginKind(
  originKind: z.infer<typeof projectOriginKindSchema>,
): z.infer<typeof projectCapabilitiesSchema> {
  const available = originKind === "github";
  return {
    git: available,
    github: available,
    worktrees: available,
    replicas: available,
    relocation: available,
  };
}

export type ProjectOriginKind = z.infer<typeof projectOriginKindSchema>;

export type ProjectFolderManagement = z.infer<
  typeof projectFolderManagementSchema
>;

export type ProjectSourceKind = z.infer<typeof projectSourceKindSchema>;

export type ProjectRootKind = z.infer<typeof projectRootKindSchema>;

export type ProjectCapabilities = z.infer<typeof projectCapabilitiesSchema>;

export type ProjectCapability = z.infer<typeof projectCapabilitySchema>;

export type ProjectCapabilityUnavailableError = z.infer<
  typeof projectCapabilityUnavailableErrorSchema
>;
