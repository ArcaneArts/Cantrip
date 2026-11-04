import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { RunConfigurationRepository } from "../../../../cantrip_worker/src/run-configuration-repository.js";
import {
  shellRunConfigurationProvider,
  type RunConfigurationProviderContext,
} from "../../../../cantrip_worker/src/run-configuration-provider.js";
import { nodeRunConfigurationProvider } from "../../../../cantrip_worker/src/run-configuration-node-provider.js";
import { javaRunConfigurationProvider } from "../../../../cantrip_worker/src/run-configuration-java-provider.js";
import { dartRunConfigurationProvider } from "../../../../cantrip_worker/src/run-configuration-dart-provider.js";
import { flutterRunConfigurationProvider } from "../../../../cantrip_worker/src/run-configuration-flutter-provider.js";
import { rustRunConfigurationProvider } from "../../../../cantrip_worker/src/run-configuration-rust-provider.js";
import { resolveRunConfigurationEnvironmentSources } from "../../../../cantrip_worker/src/run-configuration-environment-source.js";
import {
  mergeRunConfigurationEnvironmentLayers,
  runConfigurationEnvironmentNameIsReserved,
} from "../../../../cantrip_worker/src/run-configuration-environment-policy.js";
import {
  osRunPlanInputSchema,
  osRunPlanResponseSchema,
} from "../../../../cantrip_worker/src/os-executor/run-plan-contract.js";

// A finite preparation child. The owning Worker starts and supervises all Run
// processes through the native executor. No scheduler or network listener lives here.
process.umask(0o077);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let phase: "definition" | "target" | "environment" | "provider" = "definition";
let output = "";
try {
  for await (const line of lines) {
    const input = osRunPlanInputSchema.parse(JSON.parse(line));
    const account = userInfo();
    const baseline = {
      HOME: account.homedir,
      USER: account.username,
      LOGNAME: account.username,
      SHELL: account.shell || "/bin/bash",
      LANG: "C.UTF-8",
      PATH:
        process.env.PATH ??
        "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    };
    const sourceRoot = await realpath(input.sourceRoot),
      targetRoot = await realpath(input.targetRoot);
    if (sourceRoot !== input.sourceRoot || targetRoot !== input.targetRoot)
      throw new Error(
        "A captured Run root changed its canonical Linux location.",
      );
    const repository = await RunConfigurationRepository.open(sourceRoot);
    const entry = await repository.read(input.identity.configurationId);
    if (
      !entry.found ||
      entry.entry.status !== "ready" ||
      !entry.entry.document ||
      entry.entry.revision !== input.identity.definitionRevision
    )
      throw new Error(
        "The Primary Run definition is unavailable or changed before launch.",
      );
    const document = entry.entry.document;
    const context: RunConfigurationProviderContext = {
      platform: "linux",
      targetRoot,
      defaultShell: baseline.SHELL,
    };
    phase = "target";
    const materialized =
      document.provider === "shell"
        ? await shellRunConfigurationProvider.materialize(document, context)
        : document.provider === "node"
          ? await nodeRunConfigurationProvider.materialize(document, context)
          : document.provider === "java"
            ? await javaRunConfigurationProvider.materialize(document, context)
            : document.provider === "dart"
              ? await dartRunConfigurationProvider.materialize(
                  document,
                  context,
                )
              : document.provider === "flutter"
                ? await flutterRunConfigurationProvider.materialize(
                    document,
                    context,
                  )
                : await rustRunConfigurationProvider.materialize(
                    document,
                    context,
                  );
    phase = "environment";
    const layers = await resolveRunConfigurationEnvironmentSources({
      baseline,
      defaultShell: baseline.SHELL,
      environment: { ...materialized.environment, secrets: [] },
      expectedCodexEnvironmentRevision: input.identity.codexEnvironmentRevision,
      platform: "linux",
      protectedSecrets: [],
      sourceRoot,
      targetRoot,
      openSecret: async () => {
        throw new Error("Unexpected encrypted secret in Linux preparation.");
      },
      execute: async (command, environment, timeoutMs) =>
        new Promise((resolve, reject) => {
          const child = spawn(command.executable, command.arguments, {
            cwd: command.workingDirectory,
            env: environment,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let timedOut = false;
          const kill = () => {
            try {
              if (child.pid) process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          };
          const timer = setTimeout(() => {
            timedOut = true;
            kill();
          }, timeoutMs);
          const decoders = {
            stdout: new StringDecoder("utf8"),
            stderr: new StringDecoder("utf8"),
          };
          let bytes = Buffer.byteLength(output);
          const collect = (stream: "stdout" | "stderr", chunk: Buffer) => {
            bytes += chunk.length;
            output += decoders[stream].write(chunk);
            if (bytes > 1024 * 1024) {
              timedOut = true;
              kill();
            }
          };
          child.stdout.on("data", (chunk) => collect("stdout", chunk));
          child.stderr.on("data", (chunk) => collect("stderr", chunk));
          child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once("close", (code, signal) => {
            clearTimeout(timer);
            output += decoders.stdout.end() + decoders.stderr.end();
            timedOut
              ? reject(
                  new Error(
                    "Linux environment preparation exceeded its bound.",
                  ),
                )
              : resolve({ exitCode: code ?? 1, signal });
          });
        }),
    });
    const secrets = new Map(
      input.secrets.map((item) => [item.reference, item.value]),
    );
    const selectedSecrets: Array<[string, string]> = [];
    for (const reference of materialized.environment.secrets) {
      if (!reference.enabled) continue;
      const value = secrets.get(reference.secret);
      if (value === undefined)
        throw new Error(
          `Run secret reference ${reference.secret} is unavailable.`,
        );
      selectedSecrets.push([reference.name, value]);
    }
    const allowed = (layer: Record<string, string> | undefined) =>
      Object.fromEntries(
        Object.entries(layer ?? {}).filter(
          ([name]) => !runConfigurationEnvironmentNameIsReserved(name),
        ),
      );
    const environment = mergeRunConfigurationEnvironmentLayers(
      "linux",
      baseline,
      allowed(layers.codex),
      allowed(layers.files),
      allowed(
        Object.fromEntries(
          materialized.environment.variables
            .filter((item) => item.enabled)
            .map((item) => [item.name, item.value]),
        ),
      ),
      allowed(Object.fromEntries(selectedSecrets)),
      allowed(materialized.environmentAdditions),
      {
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        CANTRIP_PROJECT_ID: input.identity.projectId,
        CANTRIP_PROJECT_ROOT: sourceRoot,
        CANTRIP_RUN_CONFIGURATION_ID: input.identity.configurationId,
        CANTRIP_RUN_GENERATION: String(input.identity.generation),
        CANTRIP_RUN_OPERATION_ID: input.identity.operationId,
        CANTRIP_RUN_RUNTIME_ID: input.identity.runtimeId,
        CANTRIP_RUN_TERMINAL_ID: input.identity.terminalId,
        CANTRIP_RUN_WORKTREE_ID: input.identity.worktreeId,
        CANTRIP_WORKTREE_PATH: targetRoot,
        CODEX_WORKTREE_PATH: targetRoot,
      },
    );
    phase = "provider";
    const validationContext = {
      ...context,
      environment,
      allowToolInspection: true,
    };
    const diagnostics =
      document.provider === "shell"
        ? await shellRunConfigurationProvider.validate(
            document,
            validationContext,
          )
        : document.provider === "node"
          ? await nodeRunConfigurationProvider.validate(
              document,
              validationContext,
            )
          : document.provider === "java"
            ? await javaRunConfigurationProvider.validate(
                document,
                validationContext,
              )
            : document.provider === "dart"
              ? await dartRunConfigurationProvider.validate(
                  document,
                  validationContext,
                )
              : document.provider === "flutter"
                ? await flutterRunConfigurationProvider.validate(
                    document,
                    validationContext,
                  )
                : await rustRunConfigurationProvider.validate(
                    document,
                    validationContext,
                  );
    const error = diagnostics.find((item) => item.severity === "error");
    if (error)
      throw Object.assign(new Error(error.message), { code: error.code });
    const { executable, arguments: args, workingDirectory } = materialized;
    const result = osRunPlanResponseSchema.parse({
      state: "ready",
      command: { executable, arguments: args, workingDirectory },
      beforeLaunch: materialized.beforeLaunch,
      environment,
      preparationOutput: output,
      stopGracePeriodMs: document.stop.gracePeriodMs,
    });
    process.stdout.write(JSON.stringify(result) + "\n");
    break;
  }
} catch (error) {
  const code =
    error &&
    typeof error === "object" &&
    typeof Reflect.get(error, "code") === "string"
      ? Reflect.get(error, "code")
      : "linux-preparation-failed";
  process.stdout.write(
    JSON.stringify(
      osRunPlanResponseSchema.parse({
        state: "failed",
        phase,
        code,
        message: (error instanceof Error
          ? error.message
          : "Linux Run preparation failed."
        ).slice(0, 1000),
      }),
    ) + "\n",
  );
} finally {
  lines.close();
  process.stdin.destroy();
}
