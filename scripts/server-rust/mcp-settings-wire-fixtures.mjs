export function mcpSettingsWireFixtures() {
  const bytes = (n) => Buffer.alloc(n, 71).toString("base64url");
  const create = {
    id: "88888888-8888-4888-8888-000000000001",
    enabled: true,
    workerId: null,
    nameBlindIndex: bytes(32),
    protectedConfiguration: {
      formatVersion: 1,
      keyRevision: 1,
      envelope: {
        version: 1,
        algorithm: "AES-256-GCM",
        keyRevision: 1,
        nonce: bytes(12),
        ciphertext: bytes(32),
      },
    },
  };
  const update = { ...create };
  delete update.id;
  const summary = {
    ...create,
    audience: "ide",
    scope: "global",
    projectId: null,
    createdAt: "2026-11-03T12:00:00.123Z",
    updatedAt: "2026-11-03T12:00:00.123Z",
  };
  const candidate = {
    source: "codex",
    sourceScope: "user",
    configuration: { ...create, workerId: "worker" },
  };
  const issue = {
    source: "claude",
    sourceScope: "project",
    code: "invalid-config",
    message: "A configuration was invalid.",
  };
  const discovery = {
    workerId: "worker",
    observedAt: summary.updatedAt,
    candidates: [candidate],
    issues: [issue],
  };
  return {
    encryptedMcpServerCreateSchema: [
      create,
      { ...create, audience: "both", workerId: "worker" },
      { ...create, workerId: "\ud800" },
    ],
    encryptedMcpServerUpdateSchema: [
      update,
      { ...update, audience: "chat", workerId: "worker" },
    ],
    mcpServerWireSummarySchema: [
      summary,
      { ...summary, scope: "project", projectId: "project", audience: "both" },
    ],
    mcpServerWireListSchema: [[], [summary]],
    mcpServerDiscoveryResultSchema: [
      discovery,
      { ...discovery, candidates: [], issues: [] },
    ],
  };
}

// Keep exact large-array limits outside the recursive mutation corpus: each
// boundary is still evaluated directly by both Source and Rust.
export function mcpSettingsBoundaryFixtures() {
  const fixtures = mcpSettingsWireFixtures();
  const summary = fixtures.mcpServerWireSummarySchema[0];
  const discovery = fixtures.mcpServerDiscoveryResultSchema[0];
  const candidate = discovery.candidates[0];
  const result = [];
  for (const count of [200, 201]) {
    result.push({
      schema: "mcpServerWireListSchema",
      input: Array(count).fill(summary),
    });
    for (const field of ["candidates", "issues"])
      result.push({
        schema: "mcpServerDiscoveryResultSchema",
        input: {
          ...discovery,
          [field]: Array(count).fill(discovery[field][0]),
        },
      });
  }
  for (const workerId of [undefined, null, ""]) {
    const configuration = { ...candidate.configuration };
    if (workerId === undefined) delete configuration.workerId;
    else configuration.workerId = workerId;
    result.push({
      schema: "mcpServerDiscoveryResultSchema",
      input: {
        ...discovery,
        candidates: [{ ...candidate, configuration }],
      },
    });
  }
  return result;
}
