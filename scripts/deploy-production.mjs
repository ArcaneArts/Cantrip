import { spawnSync } from "node:child_process";
import { promises as dns } from "node:dns";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const deploymentDirectory = path.join(scriptRoot, "deploy", "production");
const deploymentConfigPath = path.join(deploymentDirectory, "deploy.json");

const requiredSecretNames = [
  "CANTRIP_ACTIVE_SECRET_ENCRYPTION_KEY_ID",
  "CANTRIP_ADMIN_EMAIL",
  "CANTRIP_API_DOMAIN",
  "CANTRIP_APP_ORIGINS",
  "CANTRIP_METRICS_TOKEN",
  "CANTRIP_PUBLIC_ORIGIN",
  "CANTRIP_SECRET_ENCRYPTION_KEYS",
  "DATABASE_URL",
];

// This allowlist deliberately excludes deployment credentials and legacy
// worker authentication. Adding a CANTRIP_* value to Infisical must never make
// it appear in the service environment accidentally.
const forwardedSecretNames = [
  ...requiredSecretNames,
  "CANTRIP_ACCOUNT_COMMAND_CONCURRENCY",
  "CANTRIP_ACCOUNT_COMMAND_RATE_PER_MINUTE",
  "CANTRIP_ACCOUNT_RELAY_BYTES_PER_MINUTE",
  "CANTRIP_ACCOUNT_REMOTE_SURFACE_LIMIT",
  "CANTRIP_ACCOUNT_UPLOAD_BYTES_PER_MINUTE",
  "CANTRIP_ACCOUNT_UPLOAD_CONCURRENCY",
  "CANTRIP_ACCOUNT_WEBSOCKET_LIMIT",
  "CANTRIP_ADMIN_BOOTSTRAP_TOKEN",
  "CANTRIP_AGENT_MODEL",
  "CANTRIP_AGENT_MODEL_PROVIDER",
  "CANTRIP_API_BODY_LIMIT_BYTES",
  "CANTRIP_API_RATE_LIMIT_PER_MINUTE",
  "CANTRIP_AUTH_RATE_LIMIT",
  "CANTRIP_COORDINATION_PRESENCE_TTL_MS",
  "CANTRIP_OLLAMA_BASE_URL",
  "CANTRIP_PAIRING_RATE_LIMIT_PER_MINUTE",
  "CANTRIP_PUBLIC_REGISTRATION",
  "CANTRIP_SCHEDULER_LEASE_TTL_MS",
  "CANTRIP_SESSION_TTL_SECONDS",
  "CANTRIP_TURN_SHARED_SECRET",
  "CANTRIP_TURN_TTL_SECONDS",
  "CANTRIP_TURN_URLS",
  "CANTRIP_UPLOAD_LIMIT_BYTES",
  "CANTRIP_UPLOAD_RATE_LIMIT_PER_MINUTE",
  "CANTRIP_WEBRTC_NEGOTIATION_TIMEOUT_MS",
  "CANTRIP_WEBSOCKET_HANDSHAKE_RATE_PER_MINUTE",
  "CANTRIP_WEBSOCKET_MAX_PAYLOAD_BYTES",
  "CANTRIP_WORKER_COMMAND_CONCURRENCY",
  "CANTRIP_WORKER_COMMAND_RATE_PER_MINUTE",
  "CANTRIP_WORKER_RELAY_BYTES_PER_MINUTE",
  "CANTRIP_WORKER_REMOTE_SURFACE_LIMIT",
  "CANTRIP_WORKER_UPLOAD_BYTES_PER_MINUTE",
];

const deploymentOverrides = Object.freeze({
  CANTRIP_AUTH_MODE: "accounts",
  CANTRIP_BOOTSTRAP_MODE: "hosted",
  CANTRIP_COOKIE_SAME_SITE: "none",
  CANTRIP_COOKIE_SECURE: "true",
  CANTRIP_COORDINATION_MAX_INSTANCES: "1",
  CANTRIP_DATA_DIR: "/var/lib/cantrip",
  CANTRIP_DEPLOYMENT_MODE: "hosted",
  CANTRIP_LICENSE_WHITELIST_ENABLED: "true",
  CANTRIP_SERVER_HOST: "127.0.0.1",
  CANTRIP_SERVER_PORT: "4310",
  CANTRIP_TRUSTED_PROXIES: "loopback",
  NODE_ENV: "production",
});

function command(commandName, arguments_, options = {}) {
  const result = spawnSync(commandName, arguments_, {
    cwd: options.cwd ?? scriptRoot,
    encoding: "utf8",
    env: options.env,
    input: options.input,
    maxBuffer: 16 * 1024 * 1024,
    stdio: options.inherit ? "inherit" : ["pipe", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(
      `${commandName} ${arguments_.join(" ")} failed${detail ? `: ${detail}` : "."}`,
    );
  }
  return {
    status: result.status ?? 1,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

function secretCommand(commandName, arguments_, options = {}) {
  const result = spawnSync(commandName, arguments_, {
    cwd: options.cwd ?? scriptRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${commandName} could not read production secrets. Confirm the CLI is installed, authenticated, and authorized for the configured Infisical project.`,
    );
  }
  return result.stdout ?? "";
}

function git(root, arguments_) {
  return command("git", arguments_, { cwd: root }).stdout.trim();
}

export function parseInfisicalSecrets(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Infisical returned malformed JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Infisical returned an unexpected secrets document.");
  }
  const secrets = new Map();
  for (const item of parsed) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.secretKey !== "string" ||
      typeof item.secretValue !== "string"
    ) {
      throw new Error("Infisical returned an invalid secret entry.");
    }
    if (secrets.has(item.secretKey)) {
      throw new Error(`Infisical returned duplicate ${item.secretKey} values.`);
    }
    secrets.set(item.secretKey, item.secretValue);
  }
  return secrets;
}

function normalizedOrigin(name, value) {
  let origin;
  try {
    origin = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTPS origin.`);
  }
  if (
    origin.protocol !== "https:" ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  ) {
    throw new Error(`${name} must be an HTTPS origin without a path.`);
  }
  return origin.origin;
}

export function buildProductionEnvironment(secrets, config) {
  const secret = (name) => secrets.get(name)?.trim();
  const missing = requiredSecretNames.filter((name) => !secret(name));
  if (missing.length > 0) {
    throw new Error(
      `Infisical production is missing required secrets: ${missing.join(", ")}.`,
    );
  }

  if (secret("CANTRIP_API_DOMAIN") !== config.apiDomain) {
    throw new Error(`CANTRIP_API_DOMAIN must equal ${config.apiDomain}.`);
  }

  const adminEmail = secret("CANTRIP_ADMIN_EMAIL");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(adminEmail)) {
    throw new Error("CANTRIP_ADMIN_EMAIL must be a valid email address.");
  }
  if (secret("CANTRIP_METRICS_TOKEN").length < 32) {
    throw new Error(
      "CANTRIP_METRICS_TOKEN must contain at least 32 characters.",
    );
  }

  let keyring;
  try {
    keyring = JSON.parse(secret("CANTRIP_SECRET_ENCRYPTION_KEYS"));
  } catch {
    throw new Error("CANTRIP_SECRET_ENCRYPTION_KEYS must contain JSON.");
  }
  if (!keyring || typeof keyring !== "object" || Array.isArray(keyring)) {
    throw new Error("CANTRIP_SECRET_ENCRYPTION_KEYS must contain an object.");
  }
  const activeKeyId = secret("CANTRIP_ACTIVE_SECRET_ENCRYPTION_KEY_ID");
  const activeKey = keyring[activeKeyId];
  if (
    typeof activeKey !== "string" ||
    !/^[A-Za-z0-9+/]{43}=$/u.test(activeKey) ||
    Buffer.from(activeKey, "base64").length !== 32
  ) {
    throw new Error(
      "CANTRIP_ACTIVE_SECRET_ENCRYPTION_KEY_ID must select a base64-encoded 32-byte key.",
    );
  }

  let databaseUrl;
  try {
    databaseUrl = new URL(secret("DATABASE_URL"));
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (
    !["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
    !databaseUrl.hostname ||
    databaseUrl.searchParams.get("sslmode") !== "require"
  ) {
    throw new Error(
      "DATABASE_URL must be a PostgreSQL URL with sslmode=require.",
    );
  }

  const apiOrigin = normalizedOrigin(
    "CANTRIP_PUBLIC_ORIGIN",
    secret("CANTRIP_PUBLIC_ORIGIN"),
  );
  if (apiOrigin !== `https://${config.apiDomain}`) {
    throw new Error(
      `CANTRIP_PUBLIC_ORIGIN must equal https://${config.apiDomain}.`,
    );
  }

  const environment = {};
  for (const name of forwardedSecretNames) {
    const value = secret(name);
    if (value !== undefined && value !== "") environment[name] = value;
  }
  return { ...environment, ...deploymentOverrides };
}

export function quoteSystemdEnvironmentValue(value) {
  if (typeof value !== "string" || /[\u0000\r\n]/u.test(value)) {
    throw new Error(
      "Service environment values cannot contain NUL or newlines.",
    );
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function serializeSystemdEnvironment(environment) {
  return `${Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      if (!/^[A-Z_][A-Z0-9_]*$/u.test(name)) {
        throw new Error(`Invalid service environment name: ${name}`);
      }
      return `${name}=${quoteSystemdEnvironmentValue(value)}`;
    })
    .join("\n")}\n`;
}

export function validateDeploymentConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("deploy/production/deploy.json must contain an object.");
  }
  for (const name of [
    "apiDomain",
    "infisicalEnvironment",
    "platform",
    "sshHost",
    "sshPrivateKeySecret",
    "sshUser",
  ]) {
    if (typeof config[name] !== "string" || !config[name].trim()) {
      throw new Error(`Deployment configuration is missing ${name}.`);
    }
  }
  for (const name of ["apiDomain"]) {
    if (
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/u.test(config[name])
    ) {
      throw new Error(`Deployment ${name} is invalid.`);
    }
  }
  if (config.platform !== "linux/amd64") {
    throw new Error("Production deployment currently requires linux/amd64.");
  }
  if (!/^[A-Za-z0-9.-]+$/u.test(config.sshHost)) {
    throw new Error("Deployment sshHost is invalid.");
  }
  if (!/^[a-z_][a-z0-9_-]*$/u.test(config.sshUser)) {
    throw new Error("Deployment sshUser is invalid.");
  }
  return config;
}

async function loadDeploymentConfig() {
  const [source, caddyfile] = await Promise.all([
    readFile(deploymentConfigPath, "utf8"),
    readFile(path.join(deploymentDirectory, "Caddyfile"), "utf8"),
  ]);
  const config = validateDeploymentConfig(JSON.parse(source));
  const caddySites = new Set(
    caddyfile
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.endsWith(" {") && !line.startsWith("servers"))
      .map((line) => line.slice(0, -2)),
  );
  for (const domain of [config.apiDomain]) {
    if (!caddySites.has(domain)) {
      throw new Error(`The production Caddyfile is missing ${domain}.`);
    }
  }
  return config;
}

async function validateProductionSource(root, expectedCommit) {
  const topLevel = await realpath(git(root, ["rev-parse", "--show-toplevel"]));
  if (topLevel !== (await realpath(root))) {
    throw new Error(`Deployment must run from the repository root: ${root}`);
  }
  const branch = git(root, ["branch", "--show-current"]);
  if (branch !== "main") {
    throw new Error(
      `Production deployment must run from main; the current branch is ${branch || "detached"}.`,
    );
  }
  if (git(root, ["status", "--porcelain"])) {
    throw new Error(
      "Production deployment requires a clean main working tree.",
    );
  }
  const commit = git(root, ["rev-parse", "refs/heads/main"]);
  const remoteRefs = git(root, [
    "ls-remote",
    "--heads",
    "origin",
    "main",
    "release",
  ]);
  const remoteCommits = new Map(
    remoteRefs.split("\n").map((line) => {
      const [sha, ref] = line.trim().split(/\s+/u);
      return [ref, sha];
    }),
  );
  if (commit !== remoteCommits.get("refs/heads/main")) {
    throw new Error(
      "Production deployment requires main to equal origin/main.",
    );
  }
  if (commit !== remoteCommits.get("refs/heads/release")) {
    throw new Error(
      "Production deployment requires origin/release to point at main. Run pnpm release first.",
    );
  }
  if (expectedCommit && commit !== expectedCommit) {
    throw new Error("The release commit changed before deployment began.");
  }
  return commit;
}

async function validateProductionDns(config) {
  for (const domain of [config.apiDomain]) {
    let addresses;
    try {
      addresses = await dns.resolve4(domain);
    } catch {
      throw new Error(`${domain} does not have a resolvable IPv4 address.`);
    }
    if (!addresses.includes(config.sshHost)) {
      throw new Error(
        `${domain} must resolve to ${config.sshHost} before deployment (resolved: ${addresses.join(", ")}).`,
      );
    }
  }
}

function sshOptions(keyPath) {
  return [
    "-i",
    keyPath,
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=15",
  ];
}

function runSsh(config, keyPath, remoteCommand, options = {}) {
  return command(
    "ssh",
    [
      ...sshOptions(keyPath),
      `${config.sshUser}@${config.sshHost}`,
      remoteCommand,
    ],
    options,
  );
}

function writeRemoteEnvironment(config, keyPath, environmentFile) {
  const installEnvironment = [
    "set -eu",
    "install -d -o root -g root -m 0700 /etc/cantrip",
    "temporary=$(mktemp /etc/cantrip/production.env.XXXXXX)",
    "trap 'rm -f -- \"$temporary\"' EXIT HUP INT TERM",
    'cat > "$temporary"',
    'chown root:root "$temporary"',
    'chmod 0600 "$temporary"',
    'mv -f "$temporary" /etc/cantrip/production.env',
    "trap - EXIT HUP INT TERM",
  ].join("; ");
  runSsh(config, keyPath, installEnvironment, {
    input: environmentFile,
  });
}

export function productionServerBuildArguments(
  config,
  outputDirectory,
  versionPatch,
) {
  const normalizedVersionPatch = String(versionPatch).trim();
  if (!/^\d+$/u.test(normalizedVersionPatch)) {
    throw new Error("Production version patch must be a Git commit count.");
  }
  return [
    "buildx",
    "build",
    "--platform",
    config.platform,
    "--build-arg",
    `CANTRIP_VERSION_PATCH=${normalizedVersionPatch}`,
    "--target",
    "distribution",
    "--output",
    `type=local,dest=${outputDirectory}`,
    "--file",
    path.join("deploy", "docker", "server.Dockerfile"),
    ".",
  ];
}

function buildServerBundle(config, temporaryDirectory, versionPatch) {
  const outputDirectory = path.join(temporaryDirectory, "server");
  const artifactPath = path.join(temporaryDirectory, "cantrip-server.tar.gz");
  console.log(`Building the production server bundle for ${config.platform}…`);
  command(
    "docker",
    productionServerBuildArguments(config, outputDirectory, versionPatch),
    { inherit: true },
  );
  createProductionServerArchive(outputDirectory, artifactPath);
  return artifactPath;
}

export function createProductionServerArchive(outputDirectory, artifactPath) {
  command(
    "tar",
    ["--no-xattrs", "-czf", artifactPath, "-C", outputDirectory, "."],
    {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    },
  );
}

function uploadAndInstall(config, keyPath, commit, artifactPath) {
  const remoteDirectory = `/tmp/cantrip-deploy-${commit}`;
  const destination = `${config.sshUser}@${config.sshHost}:${remoteDirectory}/`;
  runSsh(
    config,
    keyPath,
    `install -d -o root -g root -m 0700 ${remoteDirectory}`,
  );
  command(
    "scp",
    [
      ...sshOptions(keyPath),
      artifactPath,
      path.join(deploymentDirectory, "Caddyfile"),
      path.join(deploymentDirectory, "cantrip-migrate@.service"),
      path.join(deploymentDirectory, "cantrip-server.service"),
      path.join(deploymentDirectory, "install.sh"),
      destination,
    ],
    { inherit: true },
  );
  console.log(
    `Installing Cantrip ${commit.slice(0, 12)} on ${config.sshHost}…`,
  );
  try {
    runSsh(
      config,
      keyPath,
      `bash ${remoteDirectory}/install.sh ${commit} ${remoteDirectory}/cantrip-server.tar.gz ${remoteDirectory}`,
      { inherit: true },
    );
  } finally {
    runSsh(
      config,
      keyPath,
      `rm -f -- ${remoteDirectory}/cantrip-server.tar.gz ${remoteDirectory}/Caddyfile ${remoteDirectory}/cantrip-migrate@.service ${remoteDirectory}/cantrip-server.service ${remoteDirectory}/install.sh && rmdir ${remoteDirectory}`,
      { allowFailure: true },
    );
  }
}

async function waitForPublicEndpoint(url, label) {
  let lastStatus = "no response";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
      lastStatus = `HTTP ${response.status}`;
      if (response.ok) return;
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`${label} did not become publicly ready (${lastStatus}).`);
}

export async function deployProduction({
  root = scriptRoot,
  commit: expectedCommit,
} = {}) {
  const config = await loadDeploymentConfig();
  const commit = await validateProductionSource(root, expectedCommit);
  const versionPatch = git(root, ["rev-list", "--count", commit]);
  await validateProductionDns(config);

  const secretOutput = secretCommand("infisical", [
    "secrets",
    `--env=${config.infisicalEnvironment}`,
    "--output=json",
    "--silent",
  ]);
  const secrets = parseInfisicalSecrets(secretOutput);
  const privateKey = secrets.get(config.sshPrivateKeySecret);
  if (!privateKey?.trim()) {
    throw new Error(
      `Infisical production is missing ${config.sshPrivateKeySecret}.`,
    );
  }
  const environmentFile = serializeSystemdEnvironment(
    buildProductionEnvironment(secrets, config),
  );
  secrets.clear();

  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-production-deploy-"),
  );
  const keyPath = path.join(temporaryDirectory, "deploy-key");
  try {
    await writeFile(
      keyPath,
      privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`,
      { mode: 0o600 },
    );
    await chmod(keyPath, 0o600);
    const artifactPath = buildServerBundle(
      config,
      temporaryDirectory,
      versionPatch,
    );
    writeRemoteEnvironment(config, keyPath, environmentFile);
    uploadAndInstall(config, keyPath, commit, artifactPath);
    await waitForPublicEndpoint(
      `https://${config.apiDomain}/readyz`,
      "Cantrip API",
    );
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }

  console.log(
    `Deployed Cantrip ${commit.slice(0, 12)} to https://${config.apiDomain}.`,
  );
  return { commit, origin: `https://${config.apiDomain}` };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  deployProduction().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
