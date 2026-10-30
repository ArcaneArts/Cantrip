// Development-time export of the real protocol definitions. The native server
// embeds this data and implements every registered operation in Rust.
import * as protocol from "../../packages/protocol/dist/index.js";
import { cuaCursorPreferenceRecordSchema } from "../../packages/protocol/dist/computer-use-preferences.js";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { format, resolveConfig } from "prettier";
import { registerWorkerContracts } from "./worker-contracts.mjs";
import { registerWorkerCommandContracts } from "./worker-command-contracts.mjs";

export const contractRoots = [
  "accountRegistrationSchema",
  "authLoginSchema",
  "authReauthenticationSchema",
  "mobileSignInGrantExchangeSchema",
  "accountEncryptionProfileStateSchema",
  "accountEncryptionProfileSchema",
  "accountEncryptionProfileInitializeSchema",
  "accountEncryptionProfileInitializeResultSchema",
  "encryptionProfileMigrationUpdateSchema",
  "accountPasswordEncryptionChangeSchema",
  "encryptionPrincipalCreateSchema",
  "encryptionPrincipalApprovalSchema",
  "encryptionRevocationSchema",
  "encryptionPrincipalSchema",
  "encryptionPrincipalListSchema",
  "encryptionKeyGrantCreateSchema",
  "encryptionKeyGrantSchema",
  "encryptionKeyGrantListSchema",
  "workerEncryptionBootstrapRequestSchema",
  "workerEncryptionBootstrapResultSchema",
  "workerEnrollmentCodeCreateSchema",
  "workerEnrollmentCodeResultSchema",
  "workerEnrollmentCodeStatusSchema",
  "workerEnrollmentExchangeSchema",
  "workerEnrollmentResultSchema",
  "workerCredentialRotateSchema",
  "workerCredentialRotateResultSchema",
  "workerCredentialListSchema",
  "workerHeartbeatSchema",
  "workerSummarySchema",
  "workerListSchema",
  "workerConnectionEnvelopeSchema",
  "workerResponseEnvelopeSchema",
  "accountSessionListSchema",
  "accountLicenseWhitelistCreateSchema",
  "accountLicenseWhitelistEntrySchema",
  "accountAdminSummarySchema",
  "auditEventQuerySchema",
  "auditEventListSchema",
  "appLiveClientMessageSchema",
  "appLiveServerMessageSchema",
  "appLiveEventPayloadSchema",
  "clientControlRequestSchema",
  "projectWireSummarySchema",
  "projectWireListSchema",
  "executionPlacementResolutionSchema",
  "executionPlacementResolveRequestSchema",
  "executionTargetResolutionSchema",
  "executionTargetResolveRequestSchema",
  "executionTargetWireCatalogSchema",
  "chatWireSummarySchema",
  "projectChatWireSummarySchema",
  "standaloneChatWireSummarySchema",
  "contextualChatWireSummarySchema",
  "modelConfigurationSchema",
  "agentInteractionProvenanceSchema",
  "workerServerEnvelopeSchema",
  "workerRequestEnvelopeSchema",
  "accountResourceUsageSchema",
  "accountResourceUsageHistoryQuerySchema",
  "accountResourceUsageHistorySchema",
  "accountLiveTrafficQuerySchema",
  "accountLiveTrafficSchema",
  "policyTemplateListSchema",
  "policyTemplateDetailSchema",
  "encryptedPolicyCreateSchema",
  "encryptedPolicyUpdateSchema",
  "encryptedPolicyBootstrapSchema",
  "policyWireDetailSchema",
  "policyWireListSchema",
  "policyOrderUpdateSchema",
  "policyAssignmentUpdateSchema",
  "policyAssignmentWireListSchema",
  "policyDeleteSchema",
  "effectivePolicyWireListSchema",
  "standalonePolicyWireListSchema",
  "modelProfileCreateSchema",
  "modelProfileUpdateSchema",
  "modelProfileSummarySchema",
  "chatReasoningStateSchema",
  "modelConfigurationFailureSchema",
  "userSettingsUpdateSchema",
  "settingsBundleWireSchema",
  "appDestinationUpdateSchema",
  "appDestinationSchema",
  "cuaEffectWorkerStatusSchema",
  "ollamaModelInventorySchema",
  "providerQuotaSnapshotSchema",
  "providerRateLimitResetConsumeRequestSchema",
  "providerRateLimitResetConsumeResultSchema",
  "chatGptModelInventorySchema",
  "grokModelInventorySchema",
  "providerLegacyCredentialCaptureResultSchema",
  "providerLegacyCredentialPurgeResultSchema",
  "providerCredentialUploadSchema",
  "providerCredentialWireRecordSchema",
  "codexAuthStatusSchema",
  "codexDeviceLoginSchema",
  "encryptedModelProviderAccountCreateSchema",
  "encryptedModelProviderAccountUpdateSchema",
  "modelProviderAccountWireSummarySchema",
  "modelProviderAccountWireListSchema",
  "orderedIdsSchema",
  "providerAuthLiveStatusSchema",
  "providerModelCatalogResultSchema",
  "providerTelemetryWireAnalyticsSchema",
  "providerTelemetryExportSchema",
  "providerTelemetryDeleteResultSchema",
  "encryptedModelProviderCreateSchema",
  "encryptedModelProviderUpdateSchema",
  "modelProviderWireSummarySchema",
  "encryptedManagedFolderProjectCreateSchema",
  "projectFolderSetupJobSummarySchema",
  "projectFolderSetupRetrySchema",
  "managedFolderMaterializeReadySchema",
  "projectWorkspaceStorageContextSchema",
  "repositoryWorkerOperationWireRequestSchema",
  "repositoryOperationWireResponseSchema",
  "workerEncryptionRefreshRequestSchema",
  "workerEncryptionRefreshResultSchema",
  "encryptedTerminalCreateSchema",
  "encryptedTerminalUpdateSchema",
  "encryptedTerminalServiceConfigurationSchema",
  "worktreeSelectionSchema",
  "workspaceOwnershipSchema",
  "workspaceTabSchema",
  "projectCenterLayoutNodeSchema",
  "terminalWireSummarySchema",
  "terminalWireListSchema",
  "encryptedBrowserCreateSchema",
  "encryptedBrowserUpdateSchema",
  "browserWireSummarySchema",
  "browserWireListSchema",
  "browserTunnelWireRequestSchema",
  "browserServiceSchema",
  "browserServiceListSchema",
  "browserServiceFleetDiscoverySchema",
  "projectShareTunnelCreateSchema",
  "projectShareAttachmentWireSchema",
  "standaloneChatShareAttachmentWireSchema",
  "workerProjectShareOpenResultSchema",
  "tunnelUserWireCreateSchema",
  "tunnelUserWireUpdateSchema",
  "tunnelWireSummarySchema",
  "tunnelWireListSchema",
  "tunnelDataPlaneFrameHeaderSchema",
  "workerLinkIdentityResolveResultSchema",
  "workerLinkSessionOpenRequestSchema",
  "workerLinkSessionSchema",
  "workerLinkLeaseSchema",
  "workerLinkGrantBindingSchema",
  "installedWorkerLinkGrantSchema",
  "workerLinkResourceGrantSchema",
  "workerLinkTunnelGrantRequestSchema",
  "workerLinkTunnelGrantSchema",
  "workerLinkObservationGrantRequestSchema",
  "workerLinkTerminalGrantRequestSchema",
  "workerLinkRemoteSurfaceGrantRequestSchema",
  "remoteSurfaceAttachResultSchema",
  "terminalOpenResultSchema",
  "terminalClientMessageSchema",
  "terminalServerMessageSchema",
  "workerLinkPeerConfigurationSchema",
  "workerLinkPeerSessionOpenRequestSchema",
  "workerLinkPeerSessionSchema",
  "workerLinkPeerSessionDescriptorSchema",
  "workerLinkPeerSignalEnvelopeSchema",
  "workerLinkPeerSignalBatchSchema",
  "workerLinkPeerMailboxReadRequestSchema",
  "workerLinkPeerMailboxSchema",
  "workerLinkRouteUpdateRequestSchema",
  "workerLinkDirectActivationSchema",
  "workerLinkTelemetryBatchSchema",
  "workerLinkFrameHeaderSchema",
  "directAttachmentTicketSchema",
  "projectShareDirectCreateSchema",
  "directTunnelTicketSchema",
  "directTunnelPrepareRequestSchema",
  "tunnelAttachmentCreateSchema",
  "tunnelAttachmentCreateResultSchema",
  "tunnelAttachmentInitializeSchema",
  "tunnelAttachmentReadySchema",
  "tunnelDirectActivationSchema",
  "directCapabilityPrepareResultSchema",
  "directCapabilityRenewResultSchema",
  "directTransportTelemetrySchema",
];

const refinements = new Map([
  [protocol.accountEncryptionProfileSchema, "password-wrapper-pair"],
  [
    protocol.accountEncryptionProfileInitializeSchema.shape.profile,
    "password-wrapper-pair",
  ],
  [protocol.accountEncryptionProfileInitializeSchema, "initial-client-wrapper"],
  [protocol.passwordWrappedMasterKeySchema, "password-wrapper"],
  [protocol.accountPasswordEncryptionChangeSchema, "password-change-kdf"],
  [protocol.encryptionPrincipalSchema, "principal-state"],
  [protocol.encryptionKeyGrantCreateSchema, "grant-create-metadata"],
  [protocol.encryptionKeyGrantSchema, "grant-metadata"],
  [protocol.workerEncryptionBootstrapResultSchema, "worker-bootstrap"],
  [protocol.workerEncryptionStatusSchema, "worker-encryption-status"],
  [protocol.managedWebRuntimeCapabilitiesSchema, "managed-runtime-components"],
  [protocol.managedWebRuntimeProgressSchema, "managed-runtime-progress"],
]);
// Register individual checks where safeExtend/refine reuses them, including
// schemas with multiple custom checks. Never infer an unknown callback's meaning.
const explicitChecks = new Map();
function registerCustom(schema, index, tag) {
  const check = (schema._zod.def.checks ?? []).filter(
    (c) => c._zod.def.check === "custom",
  )[index];
  if (!check)
    throw new Error("Missing explicitly registered native check: " + tag);
  const previous = explicitChecks.get(check);
  if (previous && previous !== tag)
    throw new Error("Conflicting native refinement registration: " + previous);
  explicitChecks.set(check, tag);
}
function registerChecks(schema, tags) {
  const checks = (schema._zod.def.checks ?? []).filter(
    (c) => c._zod.def.check === "custom",
  );
  if (checks.length !== tags.length)
    throw new Error(
      "Native refinement registration no longer matches the protocol",
    );
  tags.forEach((tag, index) => registerCustom(schema, index, tag));
}
registerChecks(protocol.repositoryWorkerOperationWireRequestSchema, [
  "repository-agent-model",
]);
registerChecks(protocol.workerLinkPeerSignalBatchSchema, [
  "worker-link-signal-bytes",
]);
registerChecks(protocol.workerLinkPeerMailboxSchema, [
  "worker-link-mailbox-bytes",
]);
registerChecks(protocol.clientControlCapabilitiesSchema, [
  "live-control-capabilities-unique",
]);
registerChecks(
  protocol.appLiveClientMessageSchema.options.find(
    (s) => s.shape.type.value === "subscribe",
  ).shape.scopes,
  ["live-scopes-unique"],
);
registerChecks(protocol.clientControlRequestSchema, ["live-control-window"]);
registerChecks(protocol.endpointContentOpaqueSchema, [
  "endpoint-protected-bytes",
]);
registerChecks(protocol.clientNotificationOpaqueSchema, [
  "endpoint-protected-bytes",
  "live-notification-domain",
]);
registerChecks(protocol.appLiveEventPayloadSchema, ["live-payload-bytes"]);
registerChecks(protocol.projectWireSummarySchema, ["project-wire-summary"]);
registerChecks(protocol.chatWireSummarySchema, ["chat-title-kind"]);
registerChecks(protocol.projectChatWireSummarySchema, ["chat-title-kind"]);
registerChecks(protocol.standaloneChatWireSummarySchema, ["chat-title-kind"]);
registerChecks(protocol.githubAgentWorkflowContextSchema, [
  "github-agent-workflow-context",
]);
registerChecks(protocol.executionPlacementSchema, [
  "execution-placement-replica",
]);
registerChecks(protocol.executionTargetWireDescriptorSchema, [
  "execution-target-title",
]);
registerChecks(protocol.encryptedPrivateDisplayLabelSchema, [
  "private-label-envelope",
]);
registerChecks(protocol.modelConfigurationSchema, ["model-configuration"]);
registerChecks(protocol.accountResourceUsageHistoryQuerySchema, [
  "usage-history-window",
]);
registerChecks(protocol.accountLiveTrafficQuerySchema, [
  "usage-live-traffic-query",
]);
registerChecks(protocol.encryptedPolicySummaryContentSchema, [
  "worker-command-protected-bytes:8192",
]);
registerChecks(protocol.encryptedPolicyBodyContentSchema, [
  "worker-command-protected-bytes:131072",
]);
registerChecks(protocol.encryptedPolicyUpdateSchema, ["policy-update-fields"]);
for (const schema of [
  protocol.policyOrderUpdateSchema,
  protocol.policyAssignmentUpdateSchema,
])
  registerChecks(schema.shape.policyIds, ["worker-command-unique"]);
registerChecks(protocol.policyAssignmentWireListSchema.shape.directPolicyIds, [
  "worker-command-unique",
]);
registerChecks(protocol.policyAssignmentWireListSchema, [
  "policy-assignment-references",
]);
registerChecks(protocol.modelProfileCreateSchema.shape.routes, [
  "model-routes-enabled",
]);
registerChecks(protocol.appDestinationUpdateSchema, [
  "settings-destination-fields",
]);
registerChecks(protocol.mobileProjectTabConfigurationsSchema, [
  "settings-mobile-project-limit",
]);
registerChecks(cuaCursorPreferenceRecordSchema.shape.protectedContent, [
  "endpoint-protected-bytes",
  "settings-cursor-content",
]);
registerChecks(protocol.eliteRevealConfigSchema, ["settings-elite-range"]);
registerChecks(protocol.encryptedModelProviderAccountUpdateSchema, [
  "provider-account-update-fields",
]);
registerChecks(protocol.encryptedModelProviderCreateSchema, [
  "provider-initial-account",
]);
registerChecks(protocol.providerAuthLiveStatusSchema, [
  "provider-auth-live-kind",
]);
const recursiveJson = registerWorkerContracts(registerChecks);
registerChecks(protocol.encryptedTerminalCreateSchema, [
  "terminal-placement",
  "terminal-title",
]);
registerChecks(protocol.encryptedTerminalUpdateSchema, ["terminal-title"]);
registerChecks(protocol.terminalWireSummarySchema, ["terminal-wire"]);
registerChecks(protocol.encryptedBrowserCreateSchema, [
  "browser-placement",
  "browser-title",
]);
registerChecks(protocol.encryptedBrowserUpdateSchema, ["browser-update"]);
registerChecks(protocol.projectShareTunnelCreateSchema, [
  "project-share-tunnel-identity",
]);
registerChecks(protocol.browserWireSummarySchema, ["browser-title"]);
registerChecks(protocol.browserServiceSchema.shape.url, [
  "browser-service-http-url",
]);
registerChecks(protocol.tunnelUserWireCreateSchema, [
  "tunnel-create-operation",
  "tunnel-create-revision",
]);
registerChecks(protocol.workspaceOwnershipSchema, ["workspace-ownership"]);
registerChecks(protocol.workspaceTabSchema, ["workspace-tab"]);
registerChecks(protocol.projectSurfaceResourceRefSchema, [
  "workspace-resource",
]);
const commandContracts = registerWorkerCommandContracts(registerCustom);
const transforms = new Map([
  [protocol.appLiveEventPayloadSchema._zod.def.out, "live-json-object"],
  ...commandContracts.transforms,
]);
const allowedTypes = new Set([
  "object",
  "array",
  "record",
  "string",
  "number",
  "boolean",
  "literal",
  "enum",
  "union",
  "intersection",
  "nullable",
  "optional",
  "default",
  "prefault",
  "readonly",
  "tuple",
  "unknown",
  "never",
  "null",
  "pipe",
  "transform",
]);
const allowedChecks = new Set([
  "min_length",
  "max_length",
  "length_equals",
  "greater_than",
  "less_than",
  "number_format",
  "string_format",
]);

function constantMessage(error, where) {
  if (error === undefined) return undefined;
  // Zod normalizeParams wraps configured string messages in these two
  // closures. Arbitrary error maps require an explicit native implementation.
  if (typeof error === "string") return error;
  if (
    typeof error !== "function" ||
    !["() => params", "() => params.error"].includes(error.toString())
  )
    throw new Error("Unimplemented native error map: " + where);
  const message = error({});
  if (typeof message !== "string")
    throw new Error("Expected a constant protocol error message: " + where);
  return message;
}

export function buildContractManifest() {
  const nodes = [];
  const ids = new Map();
  const names = new Map(
    Object.entries(protocol)
      .filter(([, s]) => s?._zod)
      .map(([name, s]) => [s, name]),
  );
  function visit(schema, where) {
    if (ids.has(schema)) return ids.get(schema);
    if (!schema?._zod)
      throw new Error(`Protocol schema is unavailable: ${where}`);
    const id = nodes.length;
    ids.set(schema, id);
    const node = { type: schema._zod.def.type };
    if (schema._zod.optin === "optional") node.optionalIn = true;
    if (schema._zod.optout === "optional") node.optionalOut = true;
    nodes.push(node);
    if (recursiveJson.has(schema)) {
      node.type = "json";
      node.checks = [];
      return id;
    }
    if (commandContracts.forwards.has(schema)) {
      node.type = "forward";
      node.innerType = visit(
        commandContracts.forwards.get(schema),
        where + "/forward",
      );
      node.checks = [];
      return id;
    }
    if (schema === protocol.projectCenterLayoutNodeSchema) {
      node.type = "forward";
      node.innerType = visit(schema._zod.def.getter(), where + "/lazy");
      node.checks = [];
      return id;
    }
    const def = schema._zod.def;
    if (!allowedTypes.has(def.type))
      throw new Error(`Unimplemented native schema type ${def.type}: ${where}`);
    if (names.has(schema)) node.name = names.get(schema);
    if (def.coerce) node.coerce = true;
    if (def.shape)
      node.shape = Object.fromEntries(
        Object.entries(def.shape).map(([key, value]) => [
          key,
          visit(value, `${where}/${key}`),
        ]),
      );
    for (const key of [
      "innerType",
      "element",
      "keyType",
      "valueType",
      "catchall",
      "in",
      "out",
      "rest",
      "left",
      "right",
    ])
      if (def[key]) node[key] = visit(def[key], `${where}/${key}`);
    if (def.options)
      node.options = def.options.map((s, i) => visit(s, `${where}/${i}`));
    if (def.items)
      node.items = def.items.map((s, i) => visit(s, `${where}/items/${i}`));
    if (def.discriminator) node.discriminator = def.discriminator;
    if (def.values) node.values = def.values;
    if (def.entries) node.values = Object.values(def.entries);
    if (["default", "prefault"].includes(def.type))
      node.defaultValue = def.defaultValue;
    if (def.type === "transform") {
      node.transformTag = transforms.get(schema);
      if (!node.transformTag)
        throw new Error(`Unimplemented native value transform: ${where}`);
    }
    const checks = [...(def.check ? [schema] : []), ...(def.checks ?? [])];
    node.checks = checks.map((check) => {
      const c = check._zod.def;
      if (c.check === "overwrite") {
        const tag = new Map([
          ["(input) => input.trim()", "trim"],
          ["(input) => input.toLowerCase()", "lowercase"],
        ]).get(c.tx.toString());
        if (!tag) throw new Error(`Unimplemented native transform: ${where}`);
        return { check: tag };
      }
      if (c.check === "custom") {
        const tag =
          c.fn?.name === "hasCanonicalTrailingBits"
            ? "canonical-base64url"
            : (explicitChecks.get(check) ?? refinements.get(schema));
        if (!tag) throw new Error(`Unimplemented native refinement: ${where}`);
        const message = constantMessage(c.error, where);
        return {
          check: "refinement",
          tag,
          // These callbacks explicitly supply path before message. Predicate
          // issues acquire their configured message during Zod finalization.
          messageAfterPath:
            c.type === "custom" ||
            [
              "worker-wire-link-candidates",
              "worker-command-link-lease",
              "worker-command-link-configuration",
              "worker-command-link-grant",
              "worker-command-link-session",
              "worker-link-signal-bytes",
              "workspace-ownership",
              "workspace-tab",
            ].includes(tag),
          ...(message ? { message } : {}),
          ...(c.path ? { path: c.path } : {}),
          ...(c.abort ? { abort: true } : {}),
        };
      }
      if (!allowedChecks.has(c.check))
        throw new Error(`Unimplemented native check ${c.check}: ${where}`);
      if (c.format === "url" && (c.normalize || c.hostname || c.protocol))
        throw new Error(`Unimplemented native URL options: ${where}`);
      const result = {};
      const message = constantMessage(c.error, where);
      if (message !== undefined) result.message = message;
      for (const key of [
        "check",
        "format",
        "minimum",
        "maximum",
        "length",
        "value",
        "inclusive",
        "abort",
        "prefix",
      ])
        if (c[key] !== undefined) result[key] = c[key];
      if (c.pattern) {
        result.pattern = c.pattern.source;
        result.flags = c.pattern.flags;
        result.displayPattern = c.pattern.toString();
      }
      if (c.when) result.when = "length";
      return result;
    });
    if (
      node.checks.filter(
        (c) => c.check === "refinement" && c.tag !== "canonical-base64url",
      ).length > 1 &&
      checks.some(
        (c) => c._zod.def.check === "custom" && !explicitChecks.has(c),
      )
    )
      throw new Error(
        `Multiple native custom checks require explicit implementations: ${where}`,
      );
    return id;
  }
  return {
    schemaVersion: 1,
    roots: Object.fromEntries(
      contractRoots.map((name) => [name, visit(protocol[name], name)]),
    ),
    nodes,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const destination = new URL(
    "../../cantrip_server_rs/contracts/security.json",
    import.meta.url,
  );
  await mkdir(fileURLToPath(new URL(".", destination)), { recursive: true });
  const manifest = buildContractManifest();
  const filename = fileURLToPath(destination);
  await writeFile(
    destination,
    await format(JSON.stringify(manifest), {
      ...(await resolveConfig(filename)),
      filepath: filename,
    }),
  );
  console.log(
    JSON.stringify({
      roots: Object.keys(manifest.roots).length,
      nodes: manifest.nodes.length,
    }),
  );
}
