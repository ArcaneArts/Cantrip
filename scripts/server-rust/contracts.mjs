// Development-time export of the real protocol definitions. The native server
// embeds this data and implements every registered operation in Rust.
import * as protocol from "../../packages/protocol/dist/index.js";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { format, resolveConfig } from "prettier";

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
  "modelConfigurationSchema",
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
function registerChecks(schema, tags) {
  const checks = (schema._zod.def.checks ?? []).filter(
    (c) => c._zod.def.check === "custom",
  );
  if (checks.length !== tags.length)
    throw new Error(
      "Live refinement registration no longer matches the protocol",
    );
  checks.forEach((check, index) => explicitChecks.set(check, tags[index]));
}
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
registerChecks(protocol.encryptedPrivateDisplayLabelSchema, [
  "private-label-envelope",
]);
registerChecks(protocol.modelConfigurationSchema, ["model-configuration"]);
const transforms = new Map([
  [protocol.appLiveEventPayloadSchema._zod.def.out, "live-json-object"],
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
  "nullable",
  "optional",
  "default",
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
    ])
      if (def[key]) node[key] = visit(def[key], `${where}/${key}`);
    if (def.options)
      node.options = def.options.map((s, i) => visit(s, `${where}/${i}`));
    if (def.discriminator) node.discriminator = def.discriminator;
    if (def.values) node.values = def.values;
    if (def.entries) node.values = Object.values(def.entries);
    if (def.type === "default") node.defaultValue = def.defaultValue;
    if (def.type === "transform") {
      node.transformTag = transforms.get(schema);
      if (!node.transformTag)
        throw new Error(`Unimplemented native value transform: ${where}`);
    }
    const checks = [...(def.check ? [schema] : []), ...(def.checks ?? [])];
    node.checks = checks.map((check) => {
      const c = check._zod.def;
      if (c.check === "overwrite") {
        if (c.tx.toString() !== "(input) => input.trim()")
          throw new Error(`Unimplemented native transform: ${where}`);
        return { check: "trim" };
      }
      if (c.check === "custom") {
        const tag =
          c.fn?.name === "hasCanonicalTrailingBits"
            ? "canonical-base64url"
            : (explicitChecks.get(check) ?? refinements.get(schema));
        if (!tag) throw new Error(`Unimplemented native refinement: ${where}`);
        const message = c.error?.({});
        return {
          check: "refinement",
          tag,
          ...(message ? { message } : {}),
          ...(c.abort ? { abort: true } : {}),
        };
      }
      if (!allowedChecks.has(c.check))
        throw new Error(`Unimplemented native check ${c.check}: ${where}`);
      if (c.format === "url" && (c.normalize || c.hostname || c.protocol))
        throw new Error(`Unimplemented native URL options: ${where}`);
      const result = {};
      for (const key of [
        "check",
        "format",
        "minimum",
        "maximum",
        "length",
        "value",
        "inclusive",
        "abort",
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
