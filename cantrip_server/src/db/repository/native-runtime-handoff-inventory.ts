import { and, asc, eq } from "drizzle-orm";
import {
  nativeRuntimeHandoffInventorySchema,
  type NativeRuntimeHandoffState,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";
import { NativeSettingsStateRepository } from "./native-settings-persistence.js";
import { ProviderAccountRepository } from "./provider-accounts.js";

/** Owned configuration inventory, not a cached provider health/readiness gate. */
export async function nativeRuntimeHandoffInventory(
  database: RepositoryDatabase,
  ownerId: string,
  chatId: string,
  latest: NativeRuntimeHandoffState | null,
) {
  const [chat] = await database
    .select({ id: schema.chats.id })
    .from(schema.chats)
    .where(and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, ownerId)));
  if (!chat) return null;
  const state = await new NativeSettingsStateRepository(database).get(
    ownerId,
    chatId,
  );
  const rows = await database
    .select({
      providerId: schema.modelProviders.id,
      providerName: schema.modelProviders.name,
      kind: schema.modelProviders.kind,
      routeId: schema.modelRoutes.id,
      name: schema.modelRoutes.modelName,
      profileName: schema.modelProfiles.name,
    })
    .from(schema.modelRoutes)
    .innerJoin(
      schema.modelProviders,
      eq(schema.modelProviders.id, schema.modelRoutes.providerId),
    )
    .innerJoin(
      schema.modelProfiles,
      eq(schema.modelProfiles.id, schema.modelRoutes.modelId),
    )
    .where(
      and(
        eq(schema.modelProviders.ownerId, ownerId),
        eq(schema.modelProfiles.ownerId, ownerId),
        eq(schema.modelRoutes.enabled, true),
      ),
    )
    .orderBy(
      asc(schema.modelProviders.name),
      asc(schema.modelProfiles.name),
      asc(schema.modelRoutes.position),
    );
  const accounts = new ProviderAccountRepository(database);
  const providers = await Promise.all(
    [...new Set(rows.map((row) => row.providerId))].map(async (id) => {
      const models = rows.filter((row) => row.providerId === id);
      const requiresAccount = ["chatgpt", "grok"].includes(models[0]!.kind);
      return {
        id,
        name: models[0]!.providerName,
        requiresAccount,
        accounts: requiresAccount
          ? (
              (await accounts.listModelProviderAccounts(ownerId, id)) ?? []
            ).filter((account) => account.enabled)
          : [],
        models: models.map(({ routeId, name, profileName }) => ({
          routeId,
          name,
          profileName,
        })),
      };
    }),
  );
  return nativeRuntimeHandoffInventorySchema.parse({
    chatId,
    binding: state?.binding ?? null,
    latest,
    providers,
  });
}
