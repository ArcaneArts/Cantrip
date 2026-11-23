import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

/** The authenticated root carrier; no model credentials enter the guest. */
export function rootGuestCommand(transport, program, args) {
  if (!/^\/usr\/bin\/[a-z0-9-]+$/.test(program))
    throw new Error("An explicit guest program is required");
  if (transport.kind === "docker")
    return {
      command: "docker",
      args: [
        "exec",
        "-i",
        "--user",
        "0",
        "--",
        transport.container,
        program,
        ...args,
      ],
    };
  if (transport.kind !== "ssh") throw new Error("Unsupported guest transport");
  return {
    command: "ssh",
    args: [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ForwardAgent=no",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      `UserKnownHostsFile=${transport.knownHostsFile}`,
      "-i",
      transport.identityFile,
      "-p",
      String(transport.port),
      "--",
      `${transport.user}@${transport.host}`,
      ["sudo", "-n", "--", program, ...args].map(quote).join(" "),
    ],
  };
}

export function packageJobSource() {
  return readFile(new URL("./package-job.py", import.meta.url), "utf8");
}

export class PackageCarrierError extends Error {
  delivery = "unknown";
}

/** Sends trusted rescue code instead of invoking installed Cantrip helpers.
 * No mutation is retried. Aborting the carrier does not cancel an admitted job. */
export async function packageControl(transport, args, options = {}) {
  const source = await packageJobSource();
  const command = rootGuestCommand(transport, "/usr/bin/python3", [
    "-c",
    source,
    ...args,
  ]);
  const child = spawn(command.command, command.args, {
    stdio: "pipe",
    signal: options.signal,
  });
  let stdout = "";
  let stderr = "";
  let overflow = false;
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    if (stdout.length + chunk.length > 4 * 1024 * 1024) {
      overflow = true;
      child.kill();
    } else stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-16384);
  });
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const input = options.input
    ? pipeline(options.input, child.stdin).then(
        () => null,
        (error) => error,
      )
    : new Promise((resolve) => {
        child.stdin.on("error", resolve);
        child.stdin.end(() => resolve(null));
      });
  let result;
  try {
    result = await completed;
  } catch (error) {
    throw new PackageCarrierError(`Package carrier failed: ${error.message}`, {
      cause: error,
    });
  }
  const inputError = await input;
  if (result.code !== 0 || overflow)
    throw new PackageCarrierError(
      `Package carrier ended ${result.code ?? result.signal}: ${overflow ? "response exceeds limit" : stderr.trim()}`,
    );
  if (inputError)
    throw new PackageCarrierError(
      `Package upload failed: ${inputError.message}`,
      { cause: inputError },
    );
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new PackageCarrierError(
      "Package carrier returned no verified JSON outcome",
      { cause: error },
    );
  }
}
