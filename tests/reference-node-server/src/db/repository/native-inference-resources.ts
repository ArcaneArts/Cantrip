import type { NativeInferenceResourceAuthorization } from "@cantrip/protocol";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";
import { NativeCommandError } from "./native-command-errors.js";

/** A single primary-state snapshot orders authorization against resource
 * deletion. Later deletion revokes the worker's already-registered command owner. */
export async function authorizeNativeInferenceResource(
  database: RepositoryDatabase,
  ownerId: string,
  input: NativeInferenceResourceAuthorization,
) {
  const worker = and(
    eq(schema.workers.id, input.workerId),
    eq(schema.workers.ownerId, ownerId),
  );
  const rows =
    input.target.kind === "project"
      ? await database
          .select({ id: schema.projects.id })
          .from(schema.projects)
          .innerJoin(schema.workers, worker)
          .where(
            and(
              eq(schema.projects.id, input.target.projectId),
              eq(schema.projects.ownerId, ownerId),
            ),
          )
          .limit(1)
      : await database
          .select({ id: schema.chats.id })
          .from(schema.chats)
          .innerJoin(schema.workers, worker)
          .where(
            and(
              eq(schema.chats.id, input.target.chatId),
              eq(schema.chats.ownerId, ownerId),
              isNull(schema.chats.archivedAt),
              or(
                isNull(schema.chats.projectId),
                sql`EXISTS (SELECT 1 FROM ${schema.projects} WHERE ${schema.projects.id} = ${schema.chats.projectId} AND ${schema.projects.ownerId} = ${ownerId})`,
              ),
            ),
          )
          .limit(1);
  if (!rows.length)
    throw new NativeCommandError(
      "inference-resource-unavailable",
      "The inference resource is unavailable.",
      410,
    );
  return { ...input, ownerId, authorized: true as const };
}
