import { spawn } from "node:child_process";
import {
  remoteCommand,
  type OsExecutorTransport,
} from "../../src/os-executor/connection.js";
export function guestPython(transport: OsExecutorTransport, script: string) {
  const spec = remoteCommand(transport, []);
  if (transport.kind === "docker")
    spec.args.splice(-1, 1, "/usr/bin/python3", "-");
  else spec.args[spec.args.length - 1] = "sudo -n -- /usr/bin/python3 -";
  const child = spawn(spec.command, spec.args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  const output = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Actual guest client timed out."));
    }, 60_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 65_536) child.kill();
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4096);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`Actual guest client exited ${code}: ${stderr}`));
    });
  });
  void output.catch(() => {});
  child.stdin.end(script);
  return { child, output };
}
