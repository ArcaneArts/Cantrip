import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

const protocolTests = [
  "src/run-configuration-definitions.test.ts",
  "src/run-configuration-operations.test.ts",
  "src/run-configuration-runtime.test.ts",
  "src/run-configuration-secrets.test.ts",
  "src/run-configurations.test.ts",
];

const serverTests = [
  "test/run-cli-execution.test.ts",
  "test/run-configuration-cutover-migration.test.ts",
  "test/run-configuration-definitions-api.test.ts",
  "test/run-configuration-runtimes.test.ts",
];

const workerTests = [
  "src/run-configuration-environment-policy.test.ts",
  "src/run-configuration-output-redactor.test.ts",
  "src/run-configuration-path-discovery.test.ts",
  "src/run-configuration-process-tree.test.ts",
  "src/run-configuration-runtime-supervisor.test.ts",
  "src/run-configuration-secret-encryption.test.ts",
  "src/run-content-encryption.test.ts",
  "test/cli-broker.test.ts",
  "test/mcp-broker.test.ts",
  "test/mcp-run-configuration-operations.test.ts",
  "test/mcp-tool-catalog.test.ts",
  "test/run-configuration-definition-service.test.ts",
  "test/run-configuration-environment-source.test.ts",
  "test/run-configuration-provider.test.ts",
  "test/run-configuration-repository.test.ts",
  "test/terminal-direct-endpoint.test.ts",
];

const appTests = [
  "src/components/mobile/mobile-project-selector.test.tsx",
  "src/components/projects/project-settings-page.test.tsx",
  "src/components/run/run-configuration-control.test.tsx",
  "src/components/run/run-configuration-flutter-device-picker.test.tsx",
  "src/components/run/run-configuration-path-picker.test.tsx",
  "src/components/run/run-configuration-target-picker.test.tsx",
  "src/components/run/run-configuration-validation-status.test.tsx",
  "src/components/terminal/run-terminal-view.test.tsx",
  "src/components/terminal/terminal-service-panel.test.tsx",
  "src/components/workspace/project-tab-bar.test.tsx",
  "src/lib/project-surface.test.ts",
  "src/lib/run-configuration-api.test.ts",
  "src/lib/run-configuration-control-model.test.ts",
  "src/lib/run-configuration-editor-model.test.ts",
  "src/lib/run-configuration-focus-recovery.test.ts",
  "src/lib/run-configuration-secret-encryption.test.ts",
  "src/lib/run-configuration-selection.test.ts",
  "src/lib/run-terminal-model.test.ts",
  "src/lib/surface-title-encryption.test.ts",
];

function packageTestStep(label, packageName, packageDirectory, tests) {
  return {
    label,
    command: "pnpm",
    args: ["--filter", packageName, "exec", "vitest", "run", ...tests],
    inputs: tests.map((path) => `${packageDirectory}/${path}`),
  };
}

export const validationSteps = [
  {
    label: "Build shared Run contracts",
    command: "pnpm",
    args: [
      "--filter",
      "@cantrip/version",
      "--filter",
      "@cantrip/logging",
      "--filter",
      "@cantrip/protocol",
      "--filter",
      "@cantrip/crypto",
      "build",
    ],
    inputs: [
      "packages/version/package.json",
      "packages/logging/package.json",
      "packages/protocol/package.json",
      "packages/crypto/package.json",
    ],
  },
  packageTestStep(
    "Protocol contracts",
    "@cantrip/protocol",
    "packages/protocol",
    protocolTests,
  ),
  packageTestStep(
    "Server authoring, lifecycle, CLI, and MCP",
    "@cantrip/server",
    "cantrip_server",
    serverTests,
  ),
  {
    label: "Server active-worktree cleanup",
    command: "pnpm",
    args: [
      "--filter",
      "@cantrip/server",
      "exec",
      "vitest",
      "run",
      "test/worktree-api.test.ts",
      "--testNamePattern",
      "retires an active Run instance instead of treating it as a worktree removal blocker",
    ],
    inputs: ["cantrip_server/test/worktree-api.test.ts"],
  },
  packageTestStep(
    "Worker providers, process ownership, environment, and security",
    "@cantrip/worker",
    "cantrip_worker",
    workerTests,
  ),
  packageTestStep(
    "App controls, editor, terminal, and responsive surfaces",
    "@cantrip/app",
    "cantrip_app",
    appTests,
  ),
  {
    label: "CLI contract",
    command: "cargo",
    args: ["test", "--locked", "--manifest-path", "cantrip_cli/Cargo.toml"],
    inputs: ["cantrip_cli/Cargo.toml", "cantrip_cli/src/main.rs"],
  },
  {
    label: "Legacy cutover audit",
    command: "node",
    args: ["scripts/audit-run-configuration-cutover.mjs"],
    inputs: ["scripts/audit-run-configuration-cutover.mjs"],
  },
];

function qaEvent(status, details, context = {}) {
  process.stdout.write(
    `QA_EVT ${JSON.stringify({
      event: "run-configuration-validation",
      status,
      details,
      context,
    })}\n`,
  );
}

function executable(command, args) {
  if (command !== "pnpm" || !process.env.npm_execpath) {
    return {
      command:
        process.platform === "win32" && command === "pnpm"
          ? "pnpm.cmd"
          : command,
      args,
    };
  }
  return {
    command: process.execPath,
    args: [process.env.npm_execpath, ...args],
  };
}

async function runStep(step) {
  const invocation = executable(step.command, step.args);
  process.stdout.write(`\n==> ${step.label}\n`);
  let code;
  try {
    code = await new Promise((resolveCode, reject) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd: repositoryRoot,
        env: process.env,
        stdio: "inherit",
        windowsHide: true,
      });
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => {
        if (signal) {
          reject(new Error(`${step.label} terminated with signal ${signal}.`));
          return;
        }
        resolveCode(exitCode ?? 1);
      });
    });
  } catch (error) {
    qaEvent("fail", `${step.label} could not run.`, {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  if (code !== 0) {
    qaEvent("fail", `${step.label} failed.`, { exitCode: code });
    throw new Error(`${step.label} exited with code ${code}.`);
  }
  qaEvent("pass", `${step.label} passed.`);
}

export async function main(arguments_ = process.argv.slice(2)) {
  if (arguments_.length === 1 && arguments_[0] === "--list") {
    for (const step of validationSteps) process.stdout.write(`${step.label}\n`);
    return;
  }
  if (arguments_.length > 0) {
    throw new Error(`Unknown argument: ${arguments_[0]}`);
  }
  for (const step of validationSteps) await runStep(step);
  qaEvent("pass", "The complete Run configuration verification gate passed.", {
    steps: validationSteps.length,
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
