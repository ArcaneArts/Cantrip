import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { rustEnvironment } from "./cargo.mjs";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

export async function buildRustServer({ release = false } = {}) {
  const child = spawn(
    "cargo",
    [
      "build",
      "--locked",
      "--manifest-path",
      "cantrip_server_rs/Cargo.toml",
      "--message-format=json-render-diagnostics",
      ...(release ? ["--release"] : []),
    ],
    {
      cwd: repositoryRoot,
      env: await rustEnvironment(),
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
        message.target.name === "cantrip-server" &&
        message.executable
      ) {
        executable = message.executable;
      }
    } catch {
      process.stderr.write(`${line}\n`);
    }
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Rust server build failed (${code ?? signal}).`));
    });
  });
  if (!executable) throw new Error("Cargo did not emit a server executable.");
  return executable;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(
    await buildRustServer({ release: process.argv.includes("--release") }),
  );
}
