import { z } from "zod";

export const resourceAudienceSchema = z.enum(["ide", "chat", "both"]);

export type ResourceAudience = z.infer<typeof resourceAudienceSchema>;
