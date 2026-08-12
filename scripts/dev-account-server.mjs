import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const composeArguments = [
  "compose",
  "-f",
  "compose.dev-server.yml",
  "exec",
  "-T",
  "postgres",
  "psql",
  "-U",
  "cantrip",
  "-d",
  "cantrip_accounts",
  "-tAc",
  "SELECT 1",
];
const serverUrl = "http://127.0.0.1:4320";

function run(command, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, options);
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function waitForPostgres() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await run("docker", composeArguments, {
      cwd: repositoryRoot,
      stdio: "ignore",
    }).catch(() => ({ code: 1, signal: null }));
    if (result.code === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    "Timed out waiting for the account-mode development database.",
  );
}

await waitForPostgres();

const environment = {
  ...process.env,
  DATABASE_URL: "postgresql://cantrip:cantrip@127.0.0.1:54330/cantrip_accounts",
  CANTRIP_SERVER_HOST: "127.0.0.1",
  CANTRIP_SERVER_PORT: "4320",
  CANTRIP_CODE_SURFACE_HOST: "127.0.0.1",
  CANTRIP_CODE_SURFACE_PORT: "4321",
  CANTRIP_CODE_SURFACE_ORIGIN: "http://127.0.0.1:4321",
  CANTRIP_DEPLOYMENT_MODE: "local",
  CANTRIP_BOOTSTRAP_MODE: "standalone",
  CANTRIP_AUTH_MODE: "accounts",
  CANTRIP_LICENSE_WHITELIST_ENABLED: "false",
  CANTRIP_PUBLIC_REGISTRATION: "true",
  CANTRIP_COOKIE_SECURE: "false",
  CANTRIP_COOKIE_SAME_SITE: "lax",
  CANTRIP_DATA_DIR: path.join(repositoryRoot, ".cantrip", "dev-server"),
  CANTRIP_APP_ORIGINS:
    "http://127.0.0.1:5173,http://127.0.0.1:1420,http://tauri.localhost,https://tauri.localhost,tauri://localhost,capacitor://localhost",
};

delete environment.CANTRIP_WORKER_TOKEN;
delete environment.CANTRIP_WORKER_DEVELOPMENT_BOOTSTRAP;
delete environment.CANTRIP_WORKER_ENROLLMENT_CODE;
delete environment.CANTRIP_WORKER_CREDENTIAL;
delete environment.CANTRIP_ALLOW_INSECURE_REMOTE;
delete environment.CANTRIP_ADMIN_BOOTSTRAP_TOKEN;
delete environment.CANTRIP_PASSWORD_HASH;
delete environment.CANTRIP_PUBLIC_ORIGIN;
delete environment.CANTRIP_SECRET_ENCRYPTION_KEYS;
delete environment.CANTRIP_ACTIVE_SECRET_ENCRYPTION_KEY_ID;
delete environment.REDIS_URL;

console.log(
  `[cantrip_server] Starting account-mode development server at ${serverUrl}`,
);
console.log(
  `[cantrip_server] Add ${serverUrl} through the Cantrip server switcher and create a test account.`,
);

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const server = spawn(pnpmCommand, ["--filter", "@cantrip/server", "dev"], {
  cwd: repositoryRoot,
  env: environment,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.kill(signal));
}

server.once("error", (error) => {
  console.error(`[cantrip_server] Could not start: ${error.message}`);
  process.exitCode = 1;
});

server.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
