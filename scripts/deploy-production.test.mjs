import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildProductionEnvironment,
  parseInfisicalSecrets,
  productionServerBuildArguments,
  quoteSystemdEnvironmentValue,
  serializeSystemdEnvironment,
  validateDeploymentConfig,
} from "./deploy-production.mjs";

const config = {
  apiDomain: "winterhold.cantrip.art",
  codeDomain: "code.winterhold.cantrip.art",
  infisicalEnvironment: "prod",
  platform: "linux/amd64",
  sshHost: "134.209.161.233",
  sshPrivateKeySecret: "CANTRIP_DROPLET_SSH_PRIVATE_KEY",
  sshUser: "root",
};

function productionSecrets() {
  return new Map([
    ["CANTRIP_ACTIVE_SECRET_ENCRYPTION_KEY_ID", "primary"],
    ["CANTRIP_ADMIN_EMAIL", "magic@arcane.art"],
    ["CANTRIP_API_DOMAIN", "winterhold.cantrip.art"],
    ["CANTRIP_APP_ORIGINS", "https://tauri.localhost,tauri://localhost"],
    ["CANTRIP_CODE_DOMAIN", "code.winterhold.cantrip.art"],
    ["CANTRIP_CODE_SURFACE_ORIGIN", "https://code.winterhold.cantrip.art"],
    ["CANTRIP_DROPLET_SSH_PRIVATE_KEY", "private deployment material"],
    ["CANTRIP_METRICS_TOKEN", `${"m".repeat(64)}\n`],
    ["CANTRIP_PUBLIC_ORIGIN", "https://winterhold.cantrip.art"],
    [
      "CANTRIP_SECRET_ENCRYPTION_KEYS",
      JSON.stringify({ primary: Buffer.alloc(32, 1).toString("base64") }),
    ],
    [
      "DATABASE_URL",
      'postgresql://cantrip:p@ss"word\\value@database.example:25060/cantrip?sslmode=require',
    ],
  ]);
}

test("parses Infisical output without accepting malformed or duplicate entries", () => {
  const secrets = parseInfisicalSecrets(
    JSON.stringify([
      { secretKey: "DATABASE_URL", secretValue: "postgres://x" },
    ]),
  );
  assert.equal(secrets.get("DATABASE_URL"), "postgres://x");
  assert.throws(() => parseInfisicalSecrets("not-json"), /malformed JSON/u);
  assert.throws(
    () =>
      parseInfisicalSecrets(
        JSON.stringify([
          { secretKey: "A", secretValue: "one" },
          { secretKey: "A", secretValue: "two" },
        ]),
      ),
    /duplicate A/u,
  );
});

test("builds an allowlisted hosted environment without deployment credentials", () => {
  const environment = buildProductionEnvironment(productionSecrets(), config);
  assert.equal(environment.CANTRIP_AUTH_MODE, "accounts");
  assert.equal(environment.CANTRIP_SERVER_HOST, "127.0.0.1");
  assert.equal(environment.CANTRIP_TRUSTED_PROXIES, "loopback");
  assert.equal(environment.CANTRIP_METRICS_TOKEN, "m".repeat(64));
  assert.equal(environment.DATABASE_URL.startsWith("postgresql://"), true);
  assert.equal("CANTRIP_DROPLET_SSH_PRIVATE_KEY" in environment, false);
  assert.equal("CANTRIP_WORKER_TOKEN" in environment, false);
});

test("requires every production secret and the configured public origins", () => {
  const missing = productionSecrets();
  missing.delete("DATABASE_URL");
  assert.throws(
    () => buildProductionEnvironment(missing, config),
    /missing required secrets: DATABASE_URL/u,
  );

  const wrongOrigin = productionSecrets();
  wrongOrigin.set("CANTRIP_PUBLIC_ORIGIN", "https://elsewhere.example");
  assert.throws(
    () => buildProductionEnvironment(wrongOrigin, config),
    /must equal https:\/\/winterhold\.cantrip\.art/u,
  );
});

test("serializes systemd environment values without losing URL punctuation", () => {
  assert.equal(
    quoteSystemdEnvironmentValue('space # dollar $ quote " slash \\'),
    '"space # dollar $ quote \\" slash \\\\"',
  );
  assert.equal(
    serializeSystemdEnvironment({ B: "second", A: "first" }),
    'A="first"\nB="second"\n',
  );
  assert.throws(
    () => quoteSystemdEnvironmentValue("line one\nline two"),
    /cannot contain NUL or newlines/u,
  );
});

test("validates the committed production target", () => {
  assert.deepEqual(validateDeploymentConfig({ ...config }), config);
  assert.throws(
    () => validateDeploymentConfig({ ...config, platform: "linux/arm64" }),
    /requires linux\/amd64/u,
  );
  assert.throws(
    () => validateDeploymentConfig({ ...config, apiDomain: config.codeDomain }),
    /must differ/u,
  );
});

test("passes the release commit count into the production Docker build", () => {
  const arguments_ = productionServerBuildArguments(
    config,
    "/tmp/cantrip-server-output",
    "1375",
  );
  assert.deepEqual(arguments_.slice(0, 8), [
    "buildx",
    "build",
    "--platform",
    "linux/amd64",
    "--build-arg",
    "CANTRIP_VERSION_PATCH=1375",
    "--target",
    "distribution",
  ]);
  assert.throws(
    () => productionServerBuildArguments(config, "/tmp/output", "release"),
    /must be a Git commit count/u,
  );
});

test("copies every server workspace dependency into the Docker build", async () => {
  const dockerfile = await readFile(
    new URL("../deploy/docker/server.Dockerfile", import.meta.url),
    "utf8",
  );
  for (const source of [
    "version.json",
    "packages/logging",
    "packages/protocol",
    "packages/version",
    "cantrip_server",
  ]) {
    assert.match(dockerfile, new RegExp(`^COPY ${source}`, "mu"));
  }
  assert.match(dockerfile, /^ARG CANTRIP_VERSION_PATCH$/mu);
});

test("requires explicit commit-count versions for hosted Docker services", async () => {
  const [compose, workerDockerfile] = await Promise.all([
    readFile(new URL("../deploy/compose.hosted.yml", import.meta.url), "utf8"),
    readFile(
      new URL("../deploy/docker/worker.Dockerfile", import.meta.url),
      "utf8",
    ),
  ]);
  assert.equal(
    compose.match(/CANTRIP_VERSION_PATCH: \$\{CANTRIP_VERSION_PATCH:/gu)
      ?.length,
    2,
  );
  assert.match(workerDockerfile, /^ARG CANTRIP_VERSION_PATCH$/mu);
});

test("keeps extracted production releases traversable by the service user", async () => {
  const installer = await readFile(
    new URL("../deploy/production/install.sh", import.meta.url),
    "utf8",
  );
  assert.match(
    installer,
    /tar -xzf "\$artifact_path" -C "\$incoming_directory"\n  chmod 0755 "\$incoming_directory"/u,
  );
});
