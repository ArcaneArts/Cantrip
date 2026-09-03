import { createSign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const APP_STORE_CONNECT_ORIGIN = "https://api.appstoreconnect.apple.com";
const DEFAULT_BUNDLE_ID = "art.cantrip";
const MAX_BATCH_SIZE = 4;

const feedbackAttributeNames = [
  "appPlatform",
  "appUptimeInMilliseconds",
  "architecture",
  "batteryPercentage",
  "buildBundleId",
  "comment",
  "connectionType",
  "createdDate",
  "deviceFamily",
  "deviceModel",
  "devicePlatform",
  "diskBytesAvailable",
  "diskBytesTotal",
  "locale",
  "osVersion",
  "pairedAppleWatch",
  "screenHeightInPoints",
  "screenWidthInPoints",
  "timeZone",
];

function base64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function boundedText(value, maximum = 1_000) {
  return String(value ?? "")
    .replaceAll("\0", "")
    .slice(0, maximum);
}

function requiredString(value, label) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`${label} is required.`);
  return result;
}

function safeResourceId(value) {
  const id = requiredString(value, "App Store Connect resource id");
  if (!/^[A-Za-z0-9._-]+$/u.test(id)) {
    throw new Error(`Unsafe App Store Connect resource id: ${id}`);
  }
  return id;
}

function extensionForContentType(contentType, url) {
  const normalized = String(contentType ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  const known = new Map([
    ["image/heic", ".heic"],
    ["image/heif", ".heif"],
    ["image/jpeg", ".jpg"],
    ["image/png", ".png"],
    ["image/webp", ".webp"],
  ]);
  if (known.has(normalized)) return known.get(normalized);
  const suffix = path.extname(new URL(url).pathname).toLowerCase();
  return /^\.(?:heic|heif|jpe?g|png|webp)$/u.test(suffix) ? suffix : ".image";
}

function encodedPath(relativePath) {
  return relativePath.split("/").map(encodeURIComponent).join("/");
}

function markdownCell(value) {
  return String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ");
}

function quotedComment(value) {
  const comment = String(value ?? "").trim();
  if (!comment) return "_No written comment was supplied._";
  return comment
    .split(/\r?\n/u)
    .map((line) => `> ${line || " "}`)
    .join("\n");
}

export function createAppStoreConnectToken({
  issuerId,
  keyId,
  privateKey,
  now = Date.now(),
}) {
  const issuedAt = Math.floor(now / 1_000) - 30;
  const header = base64Url(
    JSON.stringify({
      alg: "ES256",
      kid: requiredString(keyId, "Key id"),
      typ: "JWT",
    }),
  );
  const payload = base64Url(
    JSON.stringify({
      aud: "appstoreconnect-v1",
      exp: issuedAt + 20 * 60,
      iat: issuedAt,
      iss: requiredString(issuerId, "Issuer id"),
    }),
  );
  const unsigned = `${header}.${payload}`;
  const signature = createSign("SHA256")
    .update(unsigned)
    .end()
    .sign({
      dsaEncoding: "ieee-p1363",
      key: requiredString(privateKey, "Private key"),
    });
  return `${unsigned}.${base64Url(signature)}`;
}

async function responseDetail(response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const value = await response.json().catch(() => null);
    return boundedText(JSON.stringify(value), 2_000);
  }
  return boundedText(await response.text().catch(() => ""), 2_000);
}

async function appStoreJson(url, options) {
  const target = new URL(url, APP_STORE_CONNECT_ORIGIN);
  if (target.origin !== APP_STORE_CONNECT_ORIGIN) {
    throw new Error(
      `Refusing an unexpected App Store Connect origin: ${target.origin}`,
    );
  }
  const token = createAppStoreConnectToken(options.credentials);
  const response = await options.fetchImpl(target, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(
      `App Store Connect ${response.status} for ${target.pathname}: ${await responseDetail(response)}`,
    );
  }
  return response.json();
}

async function allPages(url, options) {
  const resources = [];
  let next = url;
  while (next) {
    const page = await appStoreJson(next, options);
    if (!Array.isArray(page.data)) {
      throw new Error("App Store Connect returned a non-list response.");
    }
    resources.push(...page.data);
    next = typeof page.links?.next === "string" ? page.links.next : null;
  }
  return resources;
}

function buildById(resources) {
  return new Map(
    resources
      .filter((resource) => resource?.type === "builds" && resource.id)
      .map((resource) => [
        resource.id,
        {
          id: resource.id,
          uploadedDate: resource.attributes?.uploadedDate ?? null,
          version: resource.attributes?.version ?? null,
        },
      ]),
  );
}

export function normalizeFeedbackResource(resource, kind, builds = new Map()) {
  if (!resource || typeof resource !== "object") {
    throw new Error("Invalid App Store Connect feedback resource.");
  }
  const id = safeResourceId(resource.id);
  const attributes = {};
  for (const name of feedbackAttributeNames) {
    const value = resource.attributes?.[name];
    if (value !== undefined && value !== null) attributes[name] = value;
  }
  const buildId = resource.relationships?.build?.data?.id ?? null;
  return {
    assets: [],
    attributes,
    build: buildId ? (builds.get(buildId) ?? { id: buildId }) : null,
    id,
    kind,
    marker: feedbackMarker(kind, id),
  };
}

export function feedbackMarker(kind, id) {
  if (kind !== "crash" && kind !== "screenshot") {
    throw new Error(`Unknown TestFlight feedback kind: ${kind}`);
  }
  return `<!-- testflight-feedback-id: ${kind}:${safeResourceId(id)} -->`;
}

export function extractFeedbackMarkers(issueBodies) {
  const ids = new Set();
  const pattern =
    /<!--\s*testflight-feedback-id:\s*(crash|screenshot):([A-Za-z0-9._-]+)\s*-->/gu;
  for (const body of issueBodies) {
    for (const match of String(body ?? "").matchAll(pattern)) {
      ids.add(`${match[1]}:${match[2]}`);
    }
  }
  return ids;
}

export function selectUnimportedFeedback(
  feedback,
  issueBodies,
  limit = MAX_BATCH_SIZE,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) {
    throw new Error(
      `TestFlight feedback batches must contain 1-${MAX_BATCH_SIZE} reports.`,
    );
  }
  const imported = extractFeedbackMarkers(issueBodies);
  return [...feedback]
    .filter((item) => !imported.has(`${item.kind}:${item.id}`))
    .sort(
      (left, right) =>
        String(left.attributes?.createdDate ?? "").localeCompare(
          String(right.attributes?.createdDate ?? ""),
        ) ||
        left.kind.localeCompare(right.kind) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, limit);
}

export function renderIssueDraft(
  feedback,
  { assetBaseUrl, includeCrashLogs = false } = {},
) {
  const comment = String(feedback.attributes?.comment ?? "").trim();
  const summary =
    comment
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean) ??
    (feedback.kind === "crash"
      ? "Crash submitted without a comment"
      : "Screenshot submitted without a comment");
  const titlePrefix =
    feedback.kind === "crash" ? "[TestFlight crash]" : "[TestFlight]";
  const title = `${titlePrefix} ${summary.replace(/\s+/gu, " ").slice(0, 110)}`;
  const rows = [
    ["Submitted", feedback.attributes?.createdDate],
    ["Build", feedback.build?.version],
    [
      "Platform",
      feedback.attributes?.appPlatform ?? feedback.attributes?.devicePlatform,
    ],
    [
      "Device",
      feedback.attributes?.deviceModel ?? feedback.attributes?.deviceFamily,
    ],
    ["OS", feedback.attributes?.osVersion],
    ["Architecture", feedback.attributes?.architecture],
    ["Locale", feedback.attributes?.locale],
    ["Connection", feedback.attributes?.connectionType],
    ["App uptime (ms)", feedback.attributes?.appUptimeInMilliseconds],
    [
      "Screen",
      feedback.attributes?.screenWidthInPoints &&
      feedback.attributes?.screenHeightInPoints
        ? `${feedback.attributes.screenWidthInPoints} × ${feedback.attributes.screenHeightInPoints} pt`
        : null,
    ],
  ].filter(
    ([, value]) => value !== undefined && value !== null && value !== "",
  );
  const body = [
    "## TestFlight report",
    "",
    quotedComment(comment),
    "",
    "## Environment",
    "",
    "| Field | Value |",
    "| --- | --- |",
    ...rows.map(
      ([label, value]) => `| ${markdownCell(label)} | ${markdownCell(value)} |`,
    ),
  ];
  const publicAssets = (feedback.assets ?? []).filter(
    (asset) => asset.kind === "screenshot" || includeCrashLogs,
  );
  if (publicAssets.length > 0 && assetBaseUrl) {
    body.push("", "## Attachments", "");
    for (const asset of publicAssets) {
      const url = `${assetBaseUrl.replace(/\/$/u, "")}/${encodedPath(asset.path)}`;
      if (asset.kind === "screenshot") {
        body.push(`![TestFlight screenshot](${url})`);
      } else {
        body.push(`[TestFlight crash log](${url})`);
      }
    }
  }
  body.push(
    "",
    "_Tester identity and email were intentionally omitted from this public issue._",
    "",
    feedback.marker,
  );
  return { body: `${body.join("\n")}\n`, title };
}

async function downloadScreenshot(screenshot, destination, fetchImpl) {
  const url = requiredString(screenshot?.url, "Screenshot URL");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error(`Refusing a non-HTTPS TestFlight screenshot URL: ${url}`);
  }
  const response = await fetchImpl(parsed);
  if (!response.ok) {
    throw new Error(
      `TestFlight screenshot download failed with ${response.status}.`,
    );
  }
  const extension = extensionForContentType(
    response.headers.get("content-type"),
    url,
  );
  const output = `${destination}${extension}`;
  await writeFile(output, Buffer.from(await response.arrayBuffer()), {
    flag: "wx",
  });
  return output;
}

async function collectKind({
  appId,
  credentials,
  fetchImpl,
  kind,
  outputDirectory,
}) {
  const type =
    kind === "screenshot"
      ? "betaFeedbackScreenshotSubmissions"
      : "betaFeedbackCrashSubmissions";
  const fields =
    feedbackAttributeNames.join(",") +
    (kind === "screenshot" ? ",screenshots" : "");
  const query = new URLSearchParams({
    [`fields[${type}]`]: fields,
    "fields[builds]": "version,uploadedDate",
    include: "build",
    limit: "200",
    sort: "createdDate",
  });
  const page = await appStoreJson(
    `/v1/apps/${encodeURIComponent(appId)}/${type}?${query}`,
    { credentials, fetchImpl },
  );
  const resources = [...(Array.isArray(page.data) ? page.data : [])];
  let next = typeof page.links?.next === "string" ? page.links.next : null;
  while (next) {
    const nextPage = await appStoreJson(next, { credentials, fetchImpl });
    resources.push(...(Array.isArray(nextPage.data) ? nextPage.data : []));
    next =
      typeof nextPage.links?.next === "string" ? nextPage.links.next : null;
    if (Array.isArray(nextPage.included)) {
      page.included = [...(page.included ?? []), ...nextPage.included];
    }
  }
  const builds = buildById(page.included ?? []);
  const normalized = [];
  for (const resource of resources) {
    const item = normalizeFeedbackResource(resource, kind, builds);
    const itemDirectory = path.join(outputDirectory, kind, item.id);
    await mkdir(itemDirectory, { recursive: true });
    if (kind === "screenshot") {
      const screenshots = Array.isArray(resource.attributes?.screenshots)
        ? resource.attributes.screenshots
        : [];
      for (const [index, screenshot] of screenshots.entries()) {
        const absolute = await downloadScreenshot(
          screenshot,
          path.join(itemDirectory, `screenshot-${index + 1}`),
          fetchImpl,
        );
        item.assets.push({
          expirationDate: screenshot.expirationDate ?? null,
          height: screenshot.height ?? null,
          kind: "screenshot",
          path: path
            .relative(outputDirectory, absolute)
            .split(path.sep)
            .join("/"),
          width: screenshot.width ?? null,
        });
      }
    } else {
      const crashResponse = await appStoreJson(
        `/v1/betaFeedbackCrashSubmissions/${encodeURIComponent(item.id)}/crashLog?fields[betaCrashLogs]=logText`,
        { credentials, fetchImpl },
      );
      const logText = crashResponse.data?.attributes?.logText;
      if (typeof logText === "string" && logText) {
        const relative = `${kind}/${item.id}/crash.log`;
        await writeFile(path.join(outputDirectory, relative), logText, {
          flag: "wx",
        });
        item.assets.push({ kind: "crash-log", path: relative });
      }
    }
    normalized.push(item);
  }
  return normalized;
}

export async function collectTestFlightFeedback({
  bundleId = DEFAULT_BUNDLE_ID,
  credentials,
  fetchImpl = fetch,
  now = new Date(),
  outputDirectory,
}) {
  const destination = path.resolve(
    requiredString(outputDirectory, "Output directory"),
  );
  await mkdir(destination, { recursive: true });
  const appQuery = new URLSearchParams({
    "fields[apps]": "name,bundleId",
    "filter[bundleId]": bundleId,
    limit: "2",
  });
  const apps = await allPages(`/v1/apps?${appQuery}`, {
    credentials,
    fetchImpl,
  });
  if (apps.length !== 1) {
    throw new Error(
      `Expected exactly one App Store Connect app for ${bundleId}; found ${apps.length}.`,
    );
  }
  const app = apps[0];
  const feedback = [
    ...(await collectKind({
      appId: app.id,
      credentials,
      fetchImpl,
      kind: "screenshot",
      outputDirectory: destination,
    })),
    ...(await collectKind({
      appId: app.id,
      credentials,
      fetchImpl,
      kind: "crash",
      outputDirectory: destination,
    })),
  ].sort(
    (left, right) =>
      String(left.attributes.createdDate ?? "").localeCompare(
        String(right.attributes.createdDate ?? ""),
      ) ||
      left.kind.localeCompare(right.kind) ||
      left.id.localeCompare(right.id),
  );
  const manifest = {
    app: {
      bundleId: app.attributes?.bundleId ?? bundleId,
      id: app.id,
      name: app.attributes?.name ?? null,
    },
    collectedAt: now.toISOString(),
    feedback,
    schemaVersion: 1,
    source: "app-store-connect-api",
  };
  await writeFile(
    path.join(destination, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" },
  );
  return manifest;
}

function parseArguments(arguments_) {
  const [command, ...rest] = arguments_;
  const values = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    const equals = argument.indexOf("=");
    if (equals !== -1) {
      values.set(argument.slice(2, equals), argument.slice(equals + 1));
      continue;
    }
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value.`);
    }
    values.set(argument.slice(2), value);
    index += 1;
  }
  return { command, values };
}

async function run() {
  const { command, values } = parseArguments(process.argv.slice(2));
  if (command !== "collect") {
    throw new Error(
      "Usage: testflight-feedback.mjs collect --output <directory> [--bundle-id art.cantrip]",
    );
  }
  const privateKey = await readFile(
    requiredString(
      process.env.APPSTORE_CONNECT_KEY_PATH,
      "APPSTORE_CONNECT_KEY_PATH",
    ),
    "utf8",
  );
  const manifest = await collectTestFlightFeedback({
    bundleId:
      values.get("bundle-id") ??
      process.env.APPSTORE_CONNECT_BUNDLE_ID ??
      DEFAULT_BUNDLE_ID,
    credentials: {
      issuerId: process.env.APPSTORE_CONNECT_ISSUER_ID,
      keyId: process.env.APPSTORE_CONNECT_KEY_ID,
      privateKey,
    },
    outputDirectory: values.get("output"),
  });
  const screenshotCount = manifest.feedback.filter(
    (item) => item.kind === "screenshot",
  ).length;
  const crashCount = manifest.feedback.filter(
    (item) => item.kind === "crash",
  ).length;
  console.log(
    `Collected ${screenshotCount} screenshot and ${crashCount} crash TestFlight reports.`,
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
