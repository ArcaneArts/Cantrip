import {
  POLICY_BODY_LIMIT,
  POLICY_KEY_LIMIT,
  POLICY_LIMIT,
  POLICY_NAME_LIMIT,
  POLICY_SUMMARY_LIMIT,
  policyCreateSchema,
  type PolicyCreate,
  type PolicyDetail,
} from "@cantrip/protocol/policies";
import { strFromU8, strToU8, unzip, zip } from "fflate";

const POLICY_FILE_FORMAT = "cantrip-policy";
const POLICY_BUNDLE_FORMAT = "cantrip-policy-bundle";
const POLICY_TRANSFER_VERSION = 1;
const POLICY_FILE_KEYS = new Set(["format", "version", "policy"]);
const POLICY_FIELDS = [
  "bodyMarkdown",
  "enabled",
  "key",
  "mandatory",
  "name",
  "summary",
] as const;
const POLICY_FILE_BYTE_LIMIT =
  (POLICY_BODY_LIMIT +
    POLICY_SUMMARY_LIMIT +
    POLICY_NAME_LIMIT +
    POLICY_KEY_LIMIT) *
    4 +
  8_192;
const POLICY_ARCHIVE_BYTE_LIMIT = POLICY_LIMIT * POLICY_FILE_BYTE_LIMIT;

interface PolicyTransferFile {
  format: typeof POLICY_FILE_FORMAT;
  version: typeof POLICY_TRANSFER_VERSION;
  policy: PolicyCreate;
}

export interface PreparedPolicyImport {
  policies: PolicyCreate[];
  renamedCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function policyFileFromDetail(
  policy: Pick<PolicyDetail, (typeof POLICY_FIELDS)[number]>,
): PolicyTransferFile {
  const content = Object.fromEntries(
    POLICY_FIELDS.map((field) => [field, policy[field]]),
  );
  return {
    format: POLICY_FILE_FORMAT,
    version: POLICY_TRANSFER_VERSION,
    policy: policyCreateSchema.parse(content),
  };
}

function policyParseError(sourceName: string, message: string): Error {
  return new Error(`${sourceName}: ${message}`);
}

export function serializePolicyFile(
  policy: Pick<PolicyDetail, (typeof POLICY_FIELDS)[number]>,
): string {
  return `${JSON.stringify(policyFileFromDetail(policy), null, 2)}\n`;
}

export function parsePolicyFile(
  value: string,
  sourceName = "Policy file",
): PolicyCreate {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw policyParseError(sourceName, "not valid JSON.");
  }
  if (!isRecord(decoded)) {
    throw policyParseError(sourceName, "expected a policy file object.");
  }
  const unexpectedKeys = Object.keys(decoded).filter(
    (key) => !POLICY_FILE_KEYS.has(key),
  );
  if (unexpectedKeys.length) {
    throw policyParseError(
      sourceName,
      `contains unsupported field${unexpectedKeys.length === 1 ? "" : "s"}: ${unexpectedKeys.join(", ")}.`,
    );
  }
  if (decoded.format !== POLICY_FILE_FORMAT) {
    throw policyParseError(
      sourceName,
      `expected format ${JSON.stringify(POLICY_FILE_FORMAT)}.`,
    );
  }
  if (decoded.version !== POLICY_TRANSFER_VERSION) {
    throw policyParseError(
      sourceName,
      `unsupported policy file version ${String(decoded.version)}.`,
    );
  }
  const result = policyCreateSchema.strict().safeParse(decoded.policy);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw policyParseError(
      sourceName,
      `invalid policy content (${path}${issue?.message ?? "validation failed"}).`,
    );
  }
  return result.data;
}

function zipAsync(entries: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(entries, { level: 6 }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

function unzipAsync(data: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(data, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

export async function createPolicyBundle(
  policies: ReadonlyArray<Pick<PolicyDetail, (typeof POLICY_FIELDS)[number]>>,
): Promise<Uint8Array> {
  if (policies.length > POLICY_LIMIT) {
    throw new Error(
      `A policy bundle cannot contain more than ${POLICY_LIMIT} policies.`,
    );
  }
  const entries: Record<string, Uint8Array> = {};
  const manifestPolicies = policies.map((policy, index) => {
    const position = String(index + 1).padStart(3, "0");
    const file = `policies/${position}-${policy.key}.json`;
    entries[file] = strToU8(serializePolicyFile(policy));
    return { file, key: policy.key, name: policy.name };
  });
  entries["manifest.json"] = strToU8(
    `${JSON.stringify(
      {
        format: POLICY_BUNDLE_FORMAT,
        version: POLICY_TRANSFER_VERSION,
        policyCount: policies.length,
        policies: manifestPolicies,
      },
      null,
      2,
    )}\n`,
  );
  return zipAsync(entries);
}

export async function parsePolicyImport(
  sourceName: string,
  data: Uint8Array,
): Promise<PolicyCreate[]> {
  const lowerName = sourceName.toLowerCase();
  if (lowerName.endsWith(".json")) {
    if (data.byteLength > POLICY_FILE_BYTE_LIMIT) {
      throw policyParseError(sourceName, "policy file is too large.");
    }
    return [parsePolicyFile(strFromU8(data), sourceName)];
  }
  if (!lowerName.endsWith(".zip")) {
    throw policyParseError(
      sourceName,
      "choose a .json policy or .zip policy bundle.",
    );
  }
  if (data.byteLength > POLICY_ARCHIVE_BYTE_LIMIT) {
    throw policyParseError(sourceName, "policy archive is too large.");
  }

  let entries: Record<string, Uint8Array>;
  try {
    entries = await unzipAsync(data);
  } catch {
    throw policyParseError(sourceName, "not a valid ZIP archive.");
  }
  const policyEntries = Object.entries(entries)
    .filter(([name]) => {
      const normalized = name.toLowerCase();
      return (
        normalized.endsWith(".json") &&
        !normalized.endsWith("/manifest.json") &&
        normalized !== "manifest.json"
      );
    })
    .sort(([left], [right]) => left.localeCompare(right));
  if (!policyEntries.length) {
    throw policyParseError(
      sourceName,
      "archive contains no policy JSON files.",
    );
  }
  if (policyEntries.length > POLICY_LIMIT) {
    throw policyParseError(
      sourceName,
      `archive contains more than ${POLICY_LIMIT} policies.`,
    );
  }
  let totalBytes = 0;
  return policyEntries.map(([entryName, contents]) => {
    totalBytes += contents.byteLength;
    if (
      contents.byteLength > POLICY_FILE_BYTE_LIMIT ||
      totalBytes > POLICY_ARCHIVE_BYTE_LIMIT
    ) {
      throw policyParseError(
        sourceName,
        "expanded policy archive is too large.",
      );
    }
    return parsePolicyFile(strFromU8(contents), `${sourceName}/${entryName}`);
  });
}

function availablePolicyKey(
  requestedKey: string,
  usedKeys: Set<string>,
): string {
  if (!usedKeys.has(requestedKey)) return requestedKey;
  let suffix = 2;
  while (true) {
    const suffixText = `-${suffix}`;
    const prefix = requestedKey
      .slice(0, POLICY_KEY_LIMIT - suffixText.length)
      .replace(/-+$/u, "");
    const candidate = `${prefix}${suffixText}`;
    if (!usedKeys.has(candidate)) return candidate;
    suffix += 1;
  }
}

export function preparePolicyImports(
  importedPolicies: readonly PolicyCreate[],
  existingPolicies: ReadonlyArray<{ key: string }>,
): PreparedPolicyImport {
  const remainingCapacity = POLICY_LIMIT - existingPolicies.length;
  if (importedPolicies.length > remainingCapacity) {
    throw new Error(
      `Only ${remainingCapacity} more polic${remainingCapacity === 1 ? "y" : "ies"} can be imported (limit ${POLICY_LIMIT}).`,
    );
  }
  const usedKeys = new Set(existingPolicies.map(({ key }) => key));
  let renamedCount = 0;
  const policies = importedPolicies.map((policy) => {
    const key = availablePolicyKey(policy.key, usedKeys);
    usedKeys.add(key);
    if (key !== policy.key) renamedCount += 1;
    return { ...policy, key };
  });
  return { policies, renamedCount };
}
