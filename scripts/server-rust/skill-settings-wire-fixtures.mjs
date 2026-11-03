export function skillSettingsWireFixtures() {
  const context = {
      workerId: "worker",
      providerId: "provider",
      projectId: null,
    },
    audienceKey = Buffer.alloc(32, 61).toString("base64url"),
    summary = { audienceKey, audience: "both" },
    item = {
      name: "private-settings-skill",
      description: "Private skill description 🌲",
      displayName: null,
      id: "private-settings-skill-id",
      audienceKey,
      audience: "ide",
      scope: "repo",
      location: "project",
      path: "/private/SKILL.md",
      enabled: true,
      editable: true,
      deletable: true,
    },
    file = { path: "SKILL.md", sizeBytes: 12 },
    request = { ...context, skillId: item.id };
  return {
    skillSettingsContextSchema: [context, { ...context, projectId: "project" }],
    skillAudienceContextSchema: [
      { workerId: context.workerId, providerId: context.providerId },
    ],
    skillAudienceUpdateSchema: [
      {
        workerId: context.workerId,
        providerId: context.providerId,
        ...summary,
      },
      {
        workerId: context.workerId,
        providerId: context.providerId,
        audienceKey,
      },
    ],
    skillAudienceSummarySchema: [summary, { audienceKey }],
    skillAudienceListSchema: [[], [summary]],
    skillSettingsInventorySchema: [{ project: [item], global: [], errors: [] }],
    skillSettingsDocumentSchema: [
      { skill: item, file, files: [file], content: "Private skill bytes 🌙" },
    ],
    skillSettingsMutationResultSchema: [
      { changed: true, recoveryPath: null },
      { changed: true, recoveryPath: "/private/recovery" },
    ],
    skillSettingsConfigResultSchema: [
      { skillId: item.id, effectiveEnabled: false },
    ],
    skillSettingsFileRequestSchema: [
      request,
      { ...request, file: "reference/extra.md" },
    ],
    skillSettingsFileUpdateSchema: [
      { ...request, content: "Private skill update" },
    ],
    skillSettingsDeleteRequestSchema: [request],
    skillSettingsConfigUpdateSchema: [{ ...request, enabled: false }],
  };
}
