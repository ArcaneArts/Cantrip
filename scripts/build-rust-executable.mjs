import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

export async function buildRustExecutable({
  manifest,
  binary,
  example,
  release = false,
  environment,
  signal,
}) {
  const name = example ?? binary;
  const child = spawn(
    "cargo",
    [
      "build",
      "--locked",
      "--manifest-path",
      manifest,
      "--message-format=json-render-diagnostics",
      ...(release ? ["--release"] : []),
      ...(example ? ["--example", example] : ["--bin", binary]),
    ],
    {
      cwd: repositoryRoot,
      env: environment,
      signal,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  let executable;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      if (
        message.reason === "compiler-artifact" &&
        message.target.name === name &&
        message.executable
      ) {
        executable = message.executable;
      } else if (
        message.reason === "compiler-message" &&
        message.message?.rendered
      ) {
        process.stderr.write(message.message.rendered);
      }
    } catch {
      process.stderr.write(`${line}\n`);
    }
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Building ${name} failed (${code ?? signal}).`));
    });
  });
  if (!executable)
    throw new Error(`Cargo did not emit an executable for ${name}.`);
  return executable;
}
