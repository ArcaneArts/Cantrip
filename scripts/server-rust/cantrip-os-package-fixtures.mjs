export function cantripOsPackageFixtures() {
  const id = "11111111-1111-4111-8111-111111111111";
  const at = "2026-11-06T00:00:00.000Z";
  const artifact = {
    name: "cantrip-os-recovery",
    version: "0.5.0",
    architecture: "all",
    sha256: "a".repeat(64),
    bytes: 21484,
  };
  const expected = {
    guestInstanceId: id,
    ownerId: "owner",
    workerId: "worker",
    identityPath: "/var/lib/cantrip-os-executor/instance.json",
  };
  const target = {
    generation: id,
    expected,
    bootId: id,
    initStart: "1",
    architecture: "amd64",
    containerId: null,
  };
  const scope = {
    ownerId: "owner",
    workerId: "worker",
    serverId: "server",
    instanceId: id,
    guestInstanceId: id,
    attachmentGeneration: id,
  };
  const transport = {
    kind: "ssh",
    host: "fixture.invalid",
    port: 22,
    user: "root",
    identityFile: "/private/key",
    knownHostsFile: "/private/known-hosts",
  };
  const input = {
    operationId: id,
    attachmentGeneration: id,
    targetGeneration: id,
    action: "repair",
    configuration: "preserve",
    packages: [artifact],
  };
  const command = {
    type: "cantrip-os.packages.operation",
    mode: "execute",
    scope,
    transport,
    operationId: id,
    target,
    action: "repair",
    configuration: "preserve",
    packages: [artifact],
  };
  const request = {
    version: 2,
    operationId: id,
    scopeKey: "b".repeat(64),
    action: "repair",
    configuration: "preserve",
    expected: { ...expected, bootId: id, initStart: "1" },
    packages: [artifact],
  };
  const record = {
    format: "cantrip-os-package-operation",
    version: 1,
    request,
    requestSha256: "c".repeat(64),
    state: "running",
    phase: "installing",
    createdAt: 1,
    updatedAt: 2,
    received: [artifact.sha256],
    process: null,
    installer: null,
    receipt: null,
    error: null,
    active: true,
    installerActive: true,
    diagnostics: "",
  };
  const installed = {
    name: artifact.name,
    exitCode: 0,
    status: "install ok installed\t0.5.0\tall",
    diagnostic: "",
  };
  const { diagnostic: _diagnostic, ...publicInstalled } = installed;
  const catalog = {
    target,
    installed: [publicInstalled],
    available: [artifact],
    unavailable: 0,
  };
  // Opaque schema fixture bytes; this is not a cryptographic authenticity claim.
  const envelope = {
    version: 1,
    algorithm: "AES-256-GCM",
    keyRevision: 1,
    nonce: Buffer.alloc(12).toString("base64url"),
    ciphertext: Buffer.alloc(16).toString("base64url"),
  };
  const result = {
    operationId: id,
    targetGeneration: id,
    action: "repair",
    configuration: "preserve",
    state: "ready",
    phase: "complete",
    startedAt: at,
    updatedAt: at,
    protectedResult: envelope,
    error: null,
  };
  const publicTarget = {
    generation: id,
    instanceId: id,
    workerId: "worker",
    attachmentGeneration: id,
    architecture: "amd64",
    verifiedAt: at,
  };
  const summary = {
    ...input,
    instanceId: id,
    workerId: "worker",
    state: "ready",
    phase: "complete",
    createdAt: at,
    updatedAt: at,
    protectedResult: envelope,
    error: null,
  };
  return {
    cantripOsPackageArtifactSchema: [artifact],
    cantripOsPackageArtifactsSchema: [[artifact]],
    cantripOsPackageNameSchema: [artifact.name],
    cantripOsPackageShaSchema: [artifact.sha256],
    cantripOsPackageManifestSchema: [
      {
        format: "cantrip-os-package-artifact",
        version: 1,
        file: "recovery.deb",
        artifact,
      },
    ],
    cantripOsPackageExpectedSchema: [expected],
    cantripOsPackageTargetSchema: [
      target,
      { ...target, architecture: "arm64", containerId: "d".repeat(64) },
    ],
    cantripOsGuestPackageRequestSchema: [
      request,
      { ...request, action: "upgrade" },
      { ...request, configuration: "package-defaults" },
    ],
    cantripOsPackageInstalledSchema: [installed],
    cantripOsPackageProbeSchema: [
      {
        version: 1,
        expected,
        bootId: id,
        initStart: "1",
        architecture: "amd64",
        packages: [installed],
      },
    ],
    cantripOsGuestPackageRecordSchema: [
      record,
      { ...record, extraReceiptMetadata: "retained" },
    ],
    cantripOsPackageScopeSchema: [scope],
    cantripOsPackageOperationCommandSchema: [
      command,
      ...["observe", "continue", "abandon"].map((mode) => ({
        ...command,
        mode,
      })),
    ],
    cantripOsPackageWorkerCommandSchema: [
      { type: "cantrip-os.packages.status", scope, transport },
      command,
    ],
    cantripOsPackageCatalogResultSchema: [catalog],
    cantripOsPackageCryptoContextSchema: [
      {
        ownerId: "owner",
        serverId: "server",
        workerId: "worker",
        instanceId: id,
        attachmentGeneration: id,
        targetGeneration: id,
        operationId: id,
      },
    ],
    cantripOsPackageProtectedResultSchema: [envelope],
    cantripOsPackageOperationResultSchema: [
      result,
      { ...result, state: "unknown", protectedResult: null },
    ],
    cantripOsPackagePrivateResultSchema: [
      { version: 1, request, record, diagnostic: null },
    ],
    cantripOsPackageTargetSummarySchema: [publicTarget],
    cantripOsPackageStatusSchema: [
      {
        target: publicTarget,
        installed: [publicInstalled],
        available: [artifact],
        unavailable: 0,
        error: null,
      },
      {
        target: null,
        installed: [],
        available: [],
        unavailable: 0,
        error: "Unavailable",
      },
    ],
    cantripOsPackageCreateSchema: [
      input,
      { ...input, configuration: "package-defaults" },
    ],
    cantripOsPackageControlSchema: [
      { attachmentGeneration: id, targetGeneration: id },
    ],
    cantripOsPackageSummarySchema: [summary],
    cantripOsPackageListQuerySchema: [{}, { limit: "1", cursor: id }],
    cantripOsPackagePageSchema: [{ items: [summary], nextCursor: null }],
  };
}
