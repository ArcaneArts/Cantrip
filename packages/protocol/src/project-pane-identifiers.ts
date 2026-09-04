import { z } from "zod";

export const projectPaneRegionSchema = z.enum([
  "center",
  "right",
  "bottom",
  "left",
]);

export const projectPaneDestinationShape = {
  paneId: z.string().min(1).optional(),
  /** @deprecated Use paneId. */
  tabGroupId: z.string().min(1).optional(),
  targetRegion: projectPaneRegionSchema.optional(),
} as const;

export function hasUnambiguousProjectPaneDestination(input: {
  paneId?: string;
  tabGroupId?: string;
  targetRegion?: ProjectPaneRegion;
}): boolean {
  return (
    [input.paneId, input.tabGroupId, input.targetRegion].filter(
      (destination) => destination !== undefined,
    ).length <= 1
  );
}

export function projectPaneIdFromDestination(input: {
  paneId?: string;
  tabGroupId?: string;
}): string | undefined {
  return input.paneId ?? input.tabGroupId;
}

export type ProjectPaneRegion = z.infer<typeof projectPaneRegionSchema>;
