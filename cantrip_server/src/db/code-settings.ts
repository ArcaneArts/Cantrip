import {
  CODE_SETTINGS_PROFILE_ID,
  codeSettingsPublicStatusSchema,
  codeSettingsStoredProfileSchema,
  codeSettingsUploadSchema,
  type CodeSettingsPublicStatus,
  type CodeSettingsStoredProfile,
  type CodeSettingsUpload,
} from "@cantrip/protocol/code-settings";
import { and, eq, ne } from "drizzle-orm";

import * as schema from "./schema.js";
import type { RepositoryDatabase } from "./repository.js";

type CodeSettingsRow = typeof schema.codeSettingsProfiles.$inferSelect;

export class CodeSettingsRevisionConflictError extends Error {
  constructor(readonly currentRevision: number | null) {
    super("Global Code settings changed since this worker last synchronized.");
    this.name = "CodeSettingsRevisionConflictError";
  }
}

function toStoredProfile(row: CodeSettingsRow): CodeSettingsStoredProfile {
  return codeSettingsStoredProfileSchema.parse({
    profileId: row.profileId,
    record: {
      operationId: row.protectedOperationId,
      revision: row.revision,
      protectedContent: row.protectedContent,
    },
    updatedAt: row.updatedAt.toISOString(),
    updatedByWorkerId: row.updatedByWorkerId,
  });
}

export class CodeSettingsRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  async get(
    ownerId: string,
    profileId: string = CODE_SETTINGS_PROFILE_ID,
  ): Promise<CodeSettingsStoredProfile | null> {
    const rows = await this.database
      .select()
      .from(schema.codeSettingsProfiles)
      .where(
        and(
          eq(schema.codeSettingsProfiles.ownerId, ownerId),
          eq(schema.codeSettingsProfiles.profileId, profileId),
        ),
      )
      .limit(1);
    return rows[0] ? toStoredProfile(rows[0]) : null;
  }

  async publicStatus(
    ownerId: string,
    profileId: string = CODE_SETTINGS_PROFILE_ID,
  ): Promise<CodeSettingsPublicStatus> {
    const record = await this.get(ownerId, profileId);
    return codeSettingsPublicStatusSchema.parse({
      profileId,
      initialized: record !== null,
      revision: record?.record.revision ?? null,
      updatedAt: record?.updatedAt ?? null,
      updatedByWorkerId: record?.updatedByWorkerId ?? null,
    });
  }

  async compareAndSwap(
    ownerId: string,
    workerId: string,
    profileId: string,
    rawUpload: CodeSettingsUpload,
  ): Promise<{ created: boolean; profile: CodeSettingsStoredProfile }> {
    const upload = codeSettingsUploadSchema.parse(rawUpload);
    const now = new Date();
    const values = {
      protectedOperationId: upload.record.operationId,
      protectedContent: upload.record.protectedContent,
      revision: upload.record.revision,
      updatedByWorkerId: workerId,
      updatedAt: now,
    };

    if (upload.expectedRevision === null) {
      const rows = await this.database
        .insert(schema.codeSettingsProfiles)
        .values({
          ownerId,
          profileId,
          ...values,
          createdAt: now,
        })
        .onConflictDoNothing({
          target: [
            schema.codeSettingsProfiles.ownerId,
            schema.codeSettingsProfiles.profileId,
          ],
        })
        .returning();
      if (rows[0]) return { created: true, profile: toStoredProfile(rows[0]) };
      const current = await this.get(ownerId, profileId);
      throw new CodeSettingsRevisionConflictError(
        current?.record.revision ?? null,
      );
    }

    const rows = await this.database
      .update(schema.codeSettingsProfiles)
      .set(values)
      .where(
        and(
          eq(schema.codeSettingsProfiles.ownerId, ownerId),
          eq(schema.codeSettingsProfiles.profileId, profileId),
          eq(schema.codeSettingsProfiles.revision, upload.expectedRevision),
          ne(
            schema.codeSettingsProfiles.protectedOperationId,
            upload.record.operationId,
          ),
        ),
      )
      .returning();
    if (rows[0]) return { created: false, profile: toStoredProfile(rows[0]) };
    const current = await this.get(ownerId, profileId);
    throw new CodeSettingsRevisionConflictError(
      current?.record.revision ?? null,
    );
  }
}
